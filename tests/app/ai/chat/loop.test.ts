import 'fake-indexeddb/auto'
import { expect, spyOn, test } from 'bun:test'

import { APICallError, simulateReadableStream, type UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

import { FigmaAPI } from '@open-pencil/core/figma-api'

import { classifyAIChatError, isCursorReplyStall } from '@/app/ai/chat/failure'
import {
  closestToolName,
  prepareLoopMessages,
  unknownToolError,
  withoutRepeatedUserTurn
} from '@/app/ai/chat/loop'
import { createToolLoopTransport } from '@/app/ai/chat/transports'
import { CursorEventStreamStallError } from '@/app/ai/providers/cursor/event-stream'
import * as figmaFactory from '@/app/automation/bridge/figma-factory'
import { createEditorStore } from '@/app/editor/session/create'

import { MOCK_USAGE } from '#tests/helpers/chat/usage'

const ASK = 'Cut the icons into 232x232 components and change the Header text'

type PromptMessage = { role: string; content?: unknown }

function userTexts(prompt: readonly PromptMessage[] | undefined): string[] {
  if (!prompt) return []
  return prompt.flatMap((message) => {
    if (message.role !== 'user') return []
    if (typeof message.content === 'string') return [message.content]
    if (!Array.isArray(message.content)) return []
    return message.content.flatMap((part) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : []
    )
  })
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
  } catch (error) {
    // A stalled reply rejects the stream instead of starting another step.
    if (!isCursorReplyStall(error)) throw error
  } finally {
    reader.releaseLock()
  }
  return chunks
}

function toolOutputs(chunks: readonly unknown[]): unknown[] {
  return chunks.flatMap((chunk) => {
    if (typeof chunk !== 'object' || chunk === null || !('type' in chunk)) return []
    if (chunk.type === 'tool-output-available' && 'output' in chunk) return [chunk.output]
    if (chunk.type === 'tool-output-error' && 'errorText' in chunk) return [chunk.errorText]
    return []
  })
}

function transportFor(store: ReturnType<typeof createEditorStore>, model: MockLanguageModelV4) {
  return createToolLoopTransport({
    store,
    providerID: 'openai',
    model,
    effectiveModelID: 'test',
    maxOutputTokens: 100,
    thinkingLevel: () => 'default'
  })
}

/** Viewport DOM is not part of the tool loop; give tools a Figma API over the document. */
function installFigma() {
  return spyOn(figmaFactory, 'makeFigmaFromStore').mockImplementation((editor, pageId) => {
    const api = new FigmaAPI(editor.graph)
    api.currentPage = api.wrapNode(pageId ?? editor.state.currentPageId)
    return api
  })
}

async function send(
  store: ReturnType<typeof createEditorStore>,
  model: MockLanguageModelV4,
  messages: UIMessage[],
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message'
): Promise<unknown[]> {
  const stream = await transportFor(store, model).sendMessages({
    trigger,
    chatId: 'loop',
    messageId: undefined,
    abortSignal: undefined,
    messages
  })
  return drain(stream)
}

test('a repeated tool call stops the run and a different call still runs', async () => {
  const store = createEditorStore()
  const figma = installFigma()
  const reads: string[] = []
  const original = FigmaAPI.prototype.getNodeById
  FigmaAPI.prototype.getNodeById = function (id: string) {
    reads.push(id)
    return original.call(this, id)
  }
  const steps = [
    { toolName: 'get_node', input: { id: '0:160', depth: 3 } },
    { toolName: 'set_text', input: { id: '0:163', text: 'Header' } },
    { toolName: 'get_node', input: { id: '0:160', depth: 3 } },
    { toolName: 'render', input: { jsx: '<Frame name="x" />' } }
  ]
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++]
      const chunks = step
        ? [
            {
              type: 'tool-call' as const,
              toolCallId: `call-${call}`,
              toolName: step.toolName,
              input: JSON.stringify(step.input)
            },
            {
              type: 'finish' as const,
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage: MOCK_USAGE
            }
          ]
        : [
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: MOCK_USAGE
            }
          ]
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks
        })
      }
    }
  })
  try {
    await send(store, model, [{ id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] }])
    expect(model.doStreamCalls).toHaveLength(3)
    expect(reads).toEqual(['0:160', '0:163'])
    expect(userTexts(model.doStreamCalls[2]?.prompt).filter((text) => text === ASK)).toEqual([ASK])
  } finally {
    FigmaAPI.prototype.getNodeById = original
    figma.mockRestore()
    store.dispose()
  }
})

test('a get_node call that already failed without an id is not run again', async () => {
  const store = createEditorStore()
  const figma = installFigma()
  const reads: string[] = []
  const original = FigmaAPI.prototype.getNodeById
  FigmaAPI.prototype.getNodeById = function (id: string) {
    reads.push(id)
    return original.call(this, id)
  }
  const steps = [
    { toolName: 'get_node', input: { depth: 5 } },
    { toolName: 'get_node', input: { depth: 5 } },
    { toolName: 'get_node', input: { id: '0:163', depth: 1 } }
  ]
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++]
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: step
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `missing-${call}`,
                  toolName: step.toolName,
                  input: JSON.stringify(step.input)
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
            : [
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'stop' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
        })
      }
    }
  })
  try {
    await send(store, model, [{ id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] }])
    expect(model.doStreamCalls).toHaveLength(2)
    expect(reads).toEqual([])
  } finally {
    FigmaAPI.prototype.getNodeById = original
    figma.mockRestore()
    store.dispose()
  }
})

test('a retry does not send the same user message twice in the middle of tool history', async () => {
  const history: UIMessage[] = [
    { id: 'user-1', role: 'user', parts: [{ type: 'text', text: ASK }] },
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Studying the Header.' },
        {
          type: 'tool-get_node',
          toolCallId: 'call-header',
          state: 'output-available',
          input: { id: '0:160', depth: 3 },
          output: { id: '0:160', name: 'Header' }
        }
      ]
    },
    { id: 'user-2', role: 'user', parts: [{ type: 'text', text: ASK }] }
  ]
  const repeated = withoutRepeatedUserTurn([
    { role: 'user', content: ASK },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolName: 'get_node', input: { id: '0:160', depth: 3 } }]
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolName: 'get_node', output: { name: 'Header' } }]
    },
    { role: 'user', content: ASK }
  ])
  expect(repeated.map((message) => message.role)).toEqual(['user', 'assistant', 'tool'])

  const kept = withoutRepeatedUserTurn([
    { role: 'user', content: ASK },
    { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    { role: 'user', content: ASK }
  ])
  expect(kept).toHaveLength(3)

  const store = createEditorStore()
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        initialDelayInMs: null,
        chunkDelayInMs: null,
        chunks: [
          { type: 'text-start', id: 'reply' },
          { type: 'text-delta', id: 'reply', delta: 'Stopped' },
          { type: 'text-end', id: 'reply' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: MOCK_USAGE
          }
        ]
      })
    })
  })
  try {
    await send(store, model, history)
    expect(userTexts(model.doStreamCalls[0]?.prompt).filter((text) => text === ASK)).toEqual([ASK])

    await send(store, model, [
      { id: 'user-a', role: 'user', parts: [{ type: 'text', text: ASK }] },
      { id: 'assistant-a', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] },
      { id: 'user-b', role: 'user', parts: [{ type: 'text', text: ASK }] }
    ])
    expect(userTexts(model.doStreamCalls[1]?.prompt).filter((text) => text === ASK)).toEqual([
      ASK,
      ASK
    ])
  } finally {
    store.dispose()
  }
})

test('a Cursor stall is not retried and does not request the tool again', async () => {
  const store = createEditorStore()
  const stall = new APICallError({
    message: 'Cursor stopped sending a reply',
    url: 'https://pencil.example/api/cursor/chat/completions',
    requestBodyValues: {},
    statusCode: 500,
    isRetryable: true
  })
  expect(classifyAIChatError(stall).reason).toBe('stalled')
  expect(classifyAIChatError(new CursorEventStreamStallError()).reason).toBe('stalled')

  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1
      if (calls === 1) throw stall
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'again',
              toolName: 'get_node',
              input: JSON.stringify({ id: '0:160', depth: 3 })
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: MOCK_USAGE
            }
          ]
        })
      }
    }
  })
  try {
    await send(store, model, [{ id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] }])
    expect(calls).toBe(1)
    expect(model.doStreamCalls).toHaveLength(1)
  } finally {
    store.dispose()
  }
})

test('repeated tool calls collapse to the latest result and later different calls stay', () => {
  expect(closestToolName('get_nodes', ['get_node', 'list_pages', 'render'])).toBe('get_node')
  expect(closestToolName('homepage', ['get_node', 'list_pages'])).toBeUndefined()
  expect(unknownToolError('get_nodes', ['get_node', 'list_pages'])).toBe(
    'Unknown tool "get_nodes". Use get_node.'
  )

  const header = { id: '0:160', depth: 3 }
  const copies = Array.from({ length: 7 }, (_, index) => ({
    type: 'tool-get_node',
    toolCallId: `old-${index}`,
    state: 'output-available',
    input: header,
    output: { id: '0:160', name: `copy-${index}` }
  }))
  const prepared = prepareLoopMessages(
    [
      { role: 'user', parts: [{ type: 'text', text: ASK }] },
      {
        role: 'assistant',
        parts: [
          ...copies,
          {
            type: 'tool-get_node',
            toolCallId: 'depth-only',
            state: 'output-available',
            input: { depth: 1 },
            output: { error: 'id is required' }
          },
          {
            type: 'tool-list_pages',
            toolCallId: 'pages',
            state: 'output-available',
            input: {},
            output: { pages: ['Home'] }
          },
          {
            type: 'tool-get_node',
            toolCallId: 'other',
            state: 'output-available',
            input: { id: '0:163', depth: 1 },
            output: { id: '0:163' }
          },
          {
            type: 'tool-set_text',
            toolCallId: 'text',
            state: 'output-available',
            input: { id: '0:163', text: 'Header' },
            output: { id: '0:163' }
          },
          {
            type: 'tool-render',
            toolCallId: 'render',
            state: 'output-available',
            input: { jsx: '<Frame />' },
            output: { ok: true }
          },
          {
            type: 'tool-get_nodes',
            toolCallId: 'plural',
            state: 'output-error',
            input: { depth: 1 },
            errorText: 'The provider rejected the request.'
          }
        ]
      }
    ],
    ['get_node', 'list_pages', 'set_text', 'render']
  )
  const parts = Array.isArray(prepared[1]?.parts) ? prepared[1].parts : []
  const ids = parts.flatMap((part) =>
    typeof part === 'object' && part !== null && 'toolCallId' in part ? [part.toolCallId] : []
  )
  expect(ids).toEqual(['old-6', 'depth-only', 'pages', 'other', 'text', 'render', 'plural'])
  const latest = parts.find(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      'toolCallId' in part &&
      part.toolCallId === 'old-6'
  )
  expect(latest && 'output' in latest ? latest.output : undefined).toEqual({
    id: '0:160',
    name: 'copy-6'
  })
  const unknown = parts.find(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      'toolCallId' in part &&
      part.toolCallId === 'plural'
  )
  expect(unknown && 'output' in unknown ? unknown.output : undefined).toEqual({
    error: 'Unknown tool "get_nodes". Use get_node.'
  })
  const ask = prepared.flatMap((message) => {
    if (message.role !== 'user' || !Array.isArray(message.parts)) return []
    return message.parts.flatMap((part) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : []
    )
  })
  expect(ask).toEqual([ASK])
})

test('an unknown tool names the closest real tool and does not run it', async () => {
  const store = createEditorStore()
  const figma = installFigma()
  const reads: string[] = []
  const original = FigmaAPI.prototype.getNodeById
  FigmaAPI.prototype.getNodeById = function (id: string) {
    reads.push(id)
    return original.call(this, id)
  }
  const steps = [
    { toolName: 'get_nodes', input: { depth: 1 } },
    { toolName: 'get_node', input: { id: '0:163', depth: 1 } }
  ]
  let call = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[call++]
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: step
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `unknown-${call}`,
                  toolName: step.toolName,
                  input: JSON.stringify(step.input)
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
            : [
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'stop' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
        })
      }
    }
  })
  try {
    const chunks = await send(store, model, [
      { id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] }
    ])
    const shown = toolOutputs(chunks).map((output) =>
      typeof output === 'string' ? output : JSON.stringify(output)
    )
    expect(shown.some((text) => text.includes('The provider rejected the request'))).toBe(false)
    expect(shown).toContain('Unknown tool "get_nodes". Use get_node.')
    expect(reads).toEqual(['0:163'])
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2)
    const continued = JSON.stringify(model.doStreamCalls[1]?.prompt)
    expect(continued).toContain('Use get_node.')
    expect(continued).not.toContain('The provider rejected the request')
  } finally {
    FigmaAPI.prototype.getNodeById = original
    figma.mockRestore()
    store.dispose()
  }
})

test('a new generation runs list_pages again after the previous run stopped a repeat', async () => {
  const store = createEditorStore()
  const figma = installFigma()
  let generation = 0
  let step = 0
  const plan = [
    ['list_pages', 'list_pages'],
    ['list_pages', 'list_pages']
  ]
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const toolName = plan[generation]?.[step++]
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: toolName
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `pages-${generation}-${step}`,
                  toolName,
                  input: '{}'
                },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'tool-calls' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
            : [
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'stop' as const, raw: undefined },
                  usage: MOCK_USAGE
                }
              ]
        })
      }
    }
  })
  const stopped = (outputs: readonly unknown[]) =>
    outputs.filter(
      (output) =>
        typeof output === 'object' &&
        output !== null &&
        'error' in output &&
        typeof output.error === 'string' &&
        output.error.includes('already performed')
    ).length
  const listed = (outputs: readonly unknown[]) =>
    outputs.filter((output) => typeof output === 'object' && output !== null && 'pages' in output)
      .length
  try {
    const first = toolOutputs(
      await send(store, model, [{ id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] }])
    )
    expect(listed(first)).toBe(1)
    expect(stopped(first)).toBe(1)

    generation = 1
    step = 0
    const again = toolOutputs(
      await send(
        store,
        model,
        [
          { id: 'user', role: 'user', parts: [{ type: 'text', text: ASK }] },
          {
            id: 'assistant',
            role: 'assistant',
            parts: [
              {
                type: 'tool-list_pages',
                toolCallId: 'pages-old',
                state: 'output-available',
                input: {},
                output: { current: 'Page 1', pages: [] }
              }
            ]
          },
          {
            id: 'user-again',
            role: 'user',
            parts: [{ type: 'text', text: 'Cut the icons to 232 by 232 and edit the Header' }]
          }
        ],
        'regenerate-message'
      )
    )
    expect(listed(again)).toBe(1)
    expect(stopped(again)).toBe(1)
  } finally {
    figma.mockRestore()
    store.dispose()
  }
})
