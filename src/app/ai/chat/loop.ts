import { NoSuchToolError, wrapLanguageModel, type LanguageModel } from 'ai'

import { finalizeStallError, isCursorReplyStall } from '@/app/ai/chat/failure'

type TurnMessage = {
  role: string
  content?: unknown
  parts?: unknown
}

function messageParts(message: TurnMessage): unknown[] {
  if (Array.isArray(message.content)) return message.content
  if (Array.isArray(message.parts)) return message.parts
  return []
}

function userText(message: TurnMessage): string | null {
  if (message.role !== 'user') return null
  if (typeof message.content === 'string') return message.content
  const texts = messageParts(message).flatMap((part) => {
    if (typeof part !== 'object' || part === null || !('text' in part)) return []
    return typeof part.text === 'string' ? [part.text] : []
  })
  return texts.length > 0 ? texts.join('\n') : null
}

/** An assistant or tool message that belongs to an unfinished tool loop. */
function isToolHistory(message: TurnMessage): boolean {
  if (message.role === 'tool') return true
  if (message.role !== 'assistant') return false
  return messageParts(message).some((part) => {
    if (typeof part !== 'object' || part === null) return false
    const type = 'type' in part ? part.type : undefined
    if (type === 'tool-call' || type === 'tool-result' || type === 'tool-error') return true
    if (typeof type === 'string' && type.startsWith('tool-')) return true
    return 'toolCallId' in part
  })
}

/**
 * Drops a user turn that repeats the previous one after tool calls have started.
 * A retry must not insert that turn again between the tool results. A later message
 * the person actually sends again, after a finished reply, stays.
 */
export function withoutRepeatedUserTurn<T extends TurnMessage>(messages: readonly T[]): T[] {
  let lastUserText: string | null = null
  let sawToolHistory = false
  const kept: T[] = []
  for (const message of messages) {
    const text = userText(message)
    if (text !== null) {
      if (lastUserText !== null && text === lastUserText && sawToolHistory) continue
      lastUserText = text
      sawToolHistory = false
      kept.push(message)
      continue
    }
    if (isToolHistory(message)) sawToolHistory = true
    kept.push(message)
  }
  return kept
}

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map((item) => stableValue(item)).join(',')}]`
  const entries = Object.entries(value)
    .filter((entry) => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Identity of one tool call: name plus arguments, independent of key order. */
export function toolCallKey(name: string, args: unknown): string {
  return `${name}\n${stableValue(args)}`
}

/**
 * Told to the model when it repeats a call that already succeeded.
 * The next request has to be a different tool or different arguments.
 */
export const ALREADY_RAN_NOTE =
  'This exact call already ran. The next call must be a different tool or different arguments.'

/** A returned tool value the model can keep using. `{ error: string }` is a failed call. */
export function toolResultSucceeded(result: unknown): boolean {
  return !(isRecord(result) && typeof result.error === 'string')
}

/** The earlier result, plus a note that this exact call must not be made again. */
export function resultWithAlreadyRanNote(result: unknown): unknown {
  if (isRecord(result)) return { ...result, note: ALREADY_RAN_NOTE }
  return { result, note: ALREADY_RAN_NOTE }
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const next = new Array<number>(right.length + 1)
  for (let row = 1; row <= left.length; row++) {
    next[0] = row
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      next[column] = Math.min(
        next[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost
      )
    }
    previous.splice(0, previous.length, ...next)
  }
  return previous[right.length]
}

/** The real tool a misspelled name most likely meant, when it is close enough to name. */
export function closestToolName(
  requested: string,
  available: readonly string[]
): string | undefined {
  const wanted = requested.toLowerCase()
  let best: { name: string; score: number } | undefined
  for (const name of available) {
    if (name === requested) continue
    const other = name.toLowerCase()
    const prefix = wanted.startsWith(other) || other.startsWith(wanted)
    const score = editDistance(wanted, other) - (prefix ? 0.5 : 0)
    if (!best || score < best.score) best = { name, score }
  }
  if (!best || best.score > 3) return undefined
  return best.name
}

/**
 * A tool result the model can continue from. The closest real tool is named, and it is not called.
 */
export function unknownToolError(toolName: string, available: readonly string[]): string {
  const closest = closestToolName(toolName, available)
  if (!closest) return `Unknown tool "${toolName}".`
  return `Unknown tool "${toolName}". Use ${closest}.`
}

const UNAVAILABLE_TOOL = /unavailable tool '([^']+)'/

/** The tool name inside an AI SDK `NoSuchToolError`, or the message it renders. */
export function unknownToolNameFrom(error: unknown): string | null {
  if (NoSuchToolError.isInstance(error)) return error.toolName
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return UNAVAILABLE_TOOL.exec(text)?.[1] ?? null
}

function uiToolName(part: Record<string, unknown>): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null
  if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) return null
  if (part.type === 'tool-call' || part.type === 'tool-result' || part.type === 'tool-error')
    return null
  return part.type.slice('tool-'.length)
}

function completedUITool(part: unknown): { key: string } | null {
  if (!isRecord(part)) return null
  const name = uiToolName(part)
  if (!name) return null
  if (part.state !== 'output-available' && part.state !== 'output-error') return null
  return { key: toolCallKey(name, part.input) }
}

function isStepStart(part: unknown): boolean {
  return isRecord(part) && part.type === 'step-start'
}

function collapseUIMessages<T extends TurnMessage>(messages: readonly T[]): T[] {
  const latest = new Map<string, { message: number; part: number }>()
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.parts)) return
    message.parts.forEach((part, partIndex) => {
      const identity = completedUITool(part)
      if (identity) latest.set(identity.key, { message: messageIndex, part: partIndex })
    })
  })
  return messages.flatMap((message, messageIndex) => {
    if (!Array.isArray(message.parts)) return [message]
    const parts = message.parts.filter((part, partIndex) => {
      const identity = completedUITool(part)
      if (!identity) return true
      const kept = latest.get(identity.key)
      return kept?.message === messageIndex && kept.part === partIndex
    })
    if (parts.length === message.parts.length) return [message]
    if (parts.length === 0 || parts.every(isStepStart)) return []
    return [{ ...message, parts }]
  })
}

function modelToolCall(part: unknown): { id: string; key: string } | null {
  if (!isRecord(part) || part.type !== 'tool-call') return null
  if (typeof part.toolName !== 'string' || typeof part.toolCallId !== 'string') return null
  return { id: part.toolCallId, key: toolCallKey(part.toolName, part.input) }
}

function toolResultId(part: unknown): string | null {
  if (!isRecord(part)) return null
  if (part.type !== 'tool-result' && part.type !== 'tool-error') return null
  return typeof part.toolCallId === 'string' ? part.toolCallId : null
}

function collapseModelMessages<T extends TurnMessage>(messages: readonly T[]): T[] {
  const calls: { id: string; key: string }[] = []
  const results = new Set<string>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const call = modelToolCall(part)
      if (call) calls.push(call)
      const resultId = toolResultId(part)
      if (resultId) results.add(resultId)
    }
  }
  const latestId = new Map<string, string>()
  for (const call of calls) {
    if (results.has(call.id)) latestId.set(call.key, call.id)
  }
  const dropped = new Set(
    calls
      .filter((call) => results.has(call.id) && latestId.get(call.key) !== call.id)
      .map((call) => call.id)
  )
  if (dropped.size === 0) return [...messages]
  return messages.flatMap((message) => {
    if (!Array.isArray(message.content)) return [message]
    const content = message.content.filter((part) => {
      const call = modelToolCall(part)
      if (call) return !dropped.has(call.id)
      const resultId = toolResultId(part)
      return resultId === null || !dropped.has(resultId)
    })
    if (content.length === message.content.length) return [message]
    if (content.length === 0) return []
    return [{ ...message, content }]
  })
}

/**
 * Drops earlier copies of a tool call that was already made with the same name and arguments.
 * The latest result stays. A later call with different arguments stays too.
 */
export function collapseRepeatedToolCalls<T extends TurnMessage>(messages: readonly T[]): T[] {
  const ui = messages.some((message) => Array.isArray(message.parts))
  return ui ? collapseUIMessages(messages) : collapseModelMessages(messages)
}

function knownTools(toolNames: readonly string[]): Set<string> {
  return new Set(toolNames)
}

function normalizeUITool(part: unknown, names: readonly string[]): unknown {
  if (!isRecord(part)) return part
  const name = uiToolName(part)
  if (!name || knownTools(names).has(name)) return part
  if (part.state !== 'output-available' && part.state !== 'output-error') return part
  const rest = { ...part }
  delete rest.errorText
  return {
    ...rest,
    state: 'output-available',
    output: { error: unknownToolError(name, names) }
  }
}

function normalizeModelPart(part: unknown, names: readonly string[]): unknown {
  if (!isRecord(part) || part.type !== 'tool-result') return part
  if (typeof part.toolName !== 'string' || knownTools(names).has(part.toolName)) return part
  return {
    ...part,
    output: { type: 'json', value: { error: unknownToolError(part.toolName, names) } }
  }
}

function normalizeUnknownTools<T extends TurnMessage>(
  messages: readonly T[],
  toolNames: readonly string[]
): T[] {
  return messages.map((message) => {
    if (Array.isArray(message.parts)) {
      const parts = message.parts.map((part) => normalizeUITool(part, toolNames))
      return parts.some((part, index) => part !== message.parts?.[index])
        ? { ...message, parts }
        : message
    }
    if (!Array.isArray(message.content)) return message
    const content = message.content.map((part) => normalizeModelPart(part, toolNames))
    return content.some((part, index) => part !== message.content?.[index])
      ? { ...message, content }
      : message
  })
}

/**
 * History sent with a model call: one copy of each identical tool call, and unknown tools
 * rewritten to a normal error that names the closest real tool.
 */
export function prepareLoopMessages<T extends TurnMessage>(
  messages: readonly T[],
  toolNames: readonly string[]
): T[] {
  return normalizeUnknownTools(
    collapseRepeatedToolCalls(withoutRepeatedUserTurn(messages)),
    toolNames
  )
}

type StallNotice = () => void

function flagStallChunks(
  stream: ReadableStream<unknown>,
  onStall: StallNotice
): ReadableStream<unknown> {
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          chunk.type === 'error' &&
          'error' in chunk &&
          isCursorReplyStall(chunk.error)
        ) {
          onStall()
          controller.enqueue({ ...chunk, error: finalizeStallError(chunk.error) })
          return
        }
        controller.enqueue(chunk)
      }
    })
  )
}

/**
 * A Cursor stall is final: the model call is not retried, and an error frame
 * after a tool call does not start another turn that can repeat that call.
 */
export function guardToolLoopModel(
  model: LanguageModel,
  onStall: StallNotice,
  toolNames: () => readonly string[]
): LanguageModel {
  if (typeof model === 'string') return model
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        prompt: prepareLoopMessages(params.prompt, toolNames())
      }),
      wrapStream: async ({ doStream }) => {
        try {
          const result = await doStream()
          return { ...result, stream: flagStallChunks(result.stream, onStall) }
        } catch (error) {
          if (!isCursorReplyStall(error)) throw error
          onStall()
          throw finalizeStallError(error)
        }
      },
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate()
        } catch (error) {
          if (!isCursorReplyStall(error)) throw error
          onStall()
          throw finalizeStallError(error)
        }
      }
    }
  })
}
