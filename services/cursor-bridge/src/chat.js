import crypto from 'node:crypto'

import { create, fromBinary, fromJson, toBinary, toJson } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'

import { frameConnectMessage, openCursorRun } from './h2.js'
import { cursorSchema } from './proto.js'

const AgentClientMessage = cursorSchema('agent.v1.AgentClientMessage')
const AgentServerMessage = cursorSchema('agent.v1.AgentServerMessage')
const AgentRunRequest = cursorSchema('agent.v1.AgentRunRequest')
const ConversationAction = cursorSchema('agent.v1.ConversationAction')
const ConversationStateStructure = cursorSchema('agent.v1.ConversationStateStructure')
const ConversationStep = cursorSchema('agent.v1.ConversationStep')
const AgentConversationTurn = cursorSchema('agent.v1.AgentConversationTurnStructure')
const ConversationTurn = cursorSchema('agent.v1.ConversationTurnStructure')
const AssistantMessage = cursorSchema('agent.v1.AssistantMessage')
const UserMessage = cursorSchema('agent.v1.UserMessage')
const UserMessageAction = cursorSchema('agent.v1.UserMessageAction')
const SelectedContext = cursorSchema('agent.v1.SelectedContext')
const ModelDetails = cursorSchema('agent.v1.ModelDetails')
const CancelAction = cursorSchema('agent.v1.CancelAction')
const ResumeAction = cursorSchema('agent.v1.ResumeAction')
const ClientHeartbeat = cursorSchema('agent.v1.ClientHeartbeat')
const KvClientMessage = cursorSchema('agent.v1.KvClientMessage')
const GetBlobResult = cursorSchema('agent.v1.GetBlobResult')
const SetBlobResult = cursorSchema('agent.v1.SetBlobResult')
const ExecClientMessage = cursorSchema('agent.v1.ExecClientMessage')
const McpArgs = cursorSchema('agent.v1.McpArgs')
const McpResult = cursorSchema('agent.v1.McpResult')
const McpSuccess = cursorSchema('agent.v1.McpSuccess')
const McpError = cursorSchema('agent.v1.McpError')
const McpTextContent = cursorSchema('agent.v1.McpTextContent')
const McpToolResultContentItem = cursorSchema('agent.v1.McpToolResultContentItem')
const McpToolCall = cursorSchema('agent.v1.McpToolCall')
const McpToolResult = cursorSchema('agent.v1.McpToolResult')
const McpToolDefinition = cursorSchema('agent.v1.McpToolDefinition')
const McpTools = cursorSchema('agent.v1.McpTools')
const McpToolNotFound = cursorSchema('agent.v1.McpToolNotFound')
const SkillOptions = cursorSchema('agent.v1.SkillOptions')
const McpFileSystemOptions = cursorSchema('agent.v1.McpFileSystemOptions')
const ToolCall = cursorSchema('agent.v1.ToolCall')
const RequestContext = cursorSchema('agent.v1.RequestContext')
const RequestContextResult = cursorSchema('agent.v1.RequestContextResult')
const RequestContextSuccess = cursorSchema('agent.v1.RequestContextSuccess')
const ReadResult = cursorSchema('agent.v1.ReadResult')
const ReadRejected = cursorSchema('agent.v1.ReadRejected')
const LsResult = cursorSchema('agent.v1.LsResult')
const LsRejected = cursorSchema('agent.v1.LsRejected')
const GrepResult = cursorSchema('agent.v1.GrepResult')
const GrepError = cursorSchema('agent.v1.GrepError')
const WriteResult = cursorSchema('agent.v1.WriteResult')
const WriteRejected = cursorSchema('agent.v1.WriteRejected')
const DeleteResult = cursorSchema('agent.v1.DeleteResult')
const DeleteRejected = cursorSchema('agent.v1.DeleteRejected')
const ShellResult = cursorSchema('agent.v1.ShellResult')
const ShellRejected = cursorSchema('agent.v1.ShellRejected')
const ShellStream = cursorSchema('agent.v1.ShellStream')
const BackgroundShellSpawnResult = cursorSchema('agent.v1.BackgroundShellSpawnResult')
const WriteShellStdinResult = cursorSchema('agent.v1.WriteShellStdinResult')
const WriteShellStdinError = cursorSchema('agent.v1.WriteShellStdinError')
const FetchResult = cursorSchema('agent.v1.FetchResult')
const FetchError = cursorSchema('agent.v1.FetchError')
const DiagnosticsResult = cursorSchema('agent.v1.DiagnosticsResult')

const CONNECT_END_STREAM_FLAG = 0b00000010
const REJECT_REASON = 'Tool not available in this environment. Use the provided tools instead.'
const BRIDGE_TTL_MS = 3 * 60 * 1000

const activeBridges = new Map()

function textContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n')
}

function parseToolCallArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return { value: parsed }
  } catch {
    return raw ? { __raw: raw } : {}
  }
}

function assistantToolCalls(message) {
  const calls = []
  for (const toolCall of message.tool_calls ?? []) {
    calls.push({
      id: toolCall.id ?? '',
      name: toolCall.function?.name ?? '',
      args: parseToolCallArguments(toolCall.function?.arguments ?? '')
    })
  }
  if (calls.length || !Array.isArray(message.content)) return calls
  for (const part of message.content) {
    if (!part || (part.type !== 'tool-call' && part.type !== 'tool_call')) continue
    const args = part.args ?? part.input ?? part.arguments ?? {}
    calls.push({
      id: part.toolCallId ?? part.id ?? '',
      name: part.toolName ?? part.name ?? '',
      args: parseToolCallArguments(args)
    })
  }
  return calls
}

function toolResultText(message) {
  const content = message.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (part.type !== 'tool-result' && part.type !== 'tool_result') continue
      const output = part.result ?? part.output ?? part.text ?? ''
      return typeof output === 'string' ? output : JSON.stringify(output)
    }
  }
  return textContent(content)
}

function promptToolResult(toolCallId, toolName, result) {
  return {
    role: 'tool',
    id: toolCallId,
    content: [{
      type: 'tool-result',
      toolName: toolName || '',
      toolCallId,
      result
    }]
  }
}

export function parseMessages(messages) {
  const systemParts = messages.filter((message) => message.role === 'system').map((message) => textContent(message.content))
  const systemPrompt = systemParts.length ? systemParts.join('\n') : 'You are a helpful assistant.'
  const turns = []
  const promptMessages = []
  const toolNameById = new Map()
  let current = null

  const finish = () => {
    if (!current) return
    turns.push({ userText: current.userText, steps: current.steps })
    current = null
  }

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      finish()
      const userText = textContent(message.content)
      current = { userText, steps: [], toolCallById: new Map() }
      if (userText) promptMessages.push({ role: 'user', content: [{ type: 'text', text: userText }] })
      continue
    }
    if (!current) continue
    if (message.role === 'assistant') {
      const text = textContent(message.content)
      const calls = assistantToolCalls(message)
      if (text) current.steps.push({ kind: 'assistantText', text })
      for (const call of calls) {
        const step = {
          kind: 'toolCall',
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.args
        }
        current.steps.push(step)
        if (step.toolCallId) {
          current.toolCallById.set(step.toolCallId, step)
          toolNameById.set(step.toolCallId, step.toolName)
        }
      }
      const content = []
      if (text) content.push({ type: 'text', text })
      for (const call of calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          args: call.args
        })
      }
      if (content.length) promptMessages.push({ role: 'assistant', content })
      continue
    }
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id ?? message.toolCallId ?? ''
      const content = toolResultText(message)
      const existing = toolCallId ? current.toolCallById.get(toolCallId) : undefined
      const toolName = existing?.toolName || toolNameById.get(toolCallId) || ''
      if (existing) existing.result = { content, isError: false }
      else {
        current.steps.push({
          kind: 'toolCall',
          toolCallId,
          toolName,
          arguments: {},
          result: { content, isError: false }
        })
      }
      promptMessages.push(promptToolResult(toolCallId, toolName, content))
    }
  }

  let userText = ''
  let toolResults = []
  let resume = false
  if (current) {
    const toolSteps = current.steps.filter((step) => step.kind === 'toolCall')
    const answered = toolSteps.filter((step) => step.result)
    const last = current.steps.at(-1)
    toolResults = answered.map((step) => ({ toolCallId: step.toolCallId, content: step.result.content }))
    if (last?.kind === 'toolCall' && answered.length > 0) {
      turns.push({ userText: current.userText, steps: current.steps })
      resume = true
    } else if (last?.kind === 'toolCall' || current.steps.length === 0) {
      userText = current.userText
    } else {
      turns.push({ userText: current.userText, steps: current.steps })
    }
  }
  return { systemPrompt, userText, turns, toolResults, resume, promptMessages }
}

function encodeMcpArgValue(value) {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value))
  } catch {
    return new TextEncoder().encode(String(value))
  }
}

function encodeMcpArgsMap(args) {
  const encoded = {}
  for (const [key, value] of Object.entries(args ?? {})) encoded[key] = encodeMcpArgValue(value)
  return encoded
}

function decodeMcpArgValue(value) {
  try {
    return toJson(ValueSchema, fromBinary(ValueSchema, value))
  } catch {
    return new TextDecoder().decode(value)
  }
}

function buildMcpTools(tools) {
  return (tools ?? []).map((tool) => {
    const fn = tool.function ?? {}
    const jsonSchema = fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} }
    return create(McpToolDefinition, {
      name: fn.name,
      description: fn.description || '',
      providerIdentifier: 'open-pencil',
      toolName: fn.name,
      inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, jsonSchema))
    })
  })
}

function allowedToolNames(mcpTools) {
  return new Set((mcpTools ?? []).map((tool) => tool.toolName || tool.name).filter(Boolean))
}

function buildRequestContext(mcpTools) {
  return create(RequestContext, {
    tools: mcpTools,
    webSearchEnabled: false,
    skillOptions: create(SkillOptions, { skillDescriptors: [] }),
    mcpFileSystemOptions: create(McpFileSystemOptions, { enabled: false, mcpDescriptors: [] })
  })
}

function modelVisiblePrompt(promptMessages, resume) {
  const messages = promptMessages ?? []
  if (resume || !messages.length || messages.at(-1).role !== 'user') return messages
  return messages.slice(0, -1)
}

function buildSelectedContextBlob(rootPromptBlobIds) {
  const parts = []
  for (const blobId of rootPromptBlobIds) {
    parts.push(Buffer.concat([Buffer.from([0x0a, blobId.length]), blobId]))
  }
  const client = Buffer.from('open-pencil')
  parts.push(Buffer.concat([Buffer.from([0xb2, 0x01, client.length]), client]))
  return Buffer.concat(parts)
}

function storeBlob(data, blobStore) {
  const id = crypto.createHash('sha256').update(data).digest()
  blobStore.set(Buffer.from(id).toString('hex'), data)
  return id
}

function createUserMessage(text, selectedContextBlob) {
  const messageId = crypto.randomUUID()
  return create(UserMessage, {
    text,
    messageId,
    selectedContext: create(SelectedContext, {}),
    mode: 1,
    selectedContextBlob,
    correlationId: messageId
  })
}

function mcpSuccess(content) {
  return create(McpSuccess, {
    content: [
      create(McpToolResultContentItem, {
        content: { case: 'text', value: create(McpTextContent, { text: content }) }
      })
    ],
    isError: false
  })
}

function buildTurnStepBytes(step) {
  if (step.kind === 'assistantText') {
    return toBinary(ConversationStep, create(ConversationStep, {
      message: { case: 'assistantMessage', value: create(AssistantMessage, { text: step.text }) }
    }))
  }
  const toolName = step.toolName || 'tool'
  const mcpToolCall = create(McpToolCall, {
    args: create(McpArgs, {
      name: toolName,
      args: encodeMcpArgsMap(step.arguments),
      toolCallId: step.toolCallId,
      providerIdentifier: 'open-pencil',
      toolName
    }),
    ...(step.result
      ? {
          result: create(McpToolResult, {
            result: step.result.isError
              ? { case: 'error', value: create(cursorSchema('agent.v1.McpToolError'), { error: step.result.content }) }
              : { case: 'success', value: mcpSuccess(step.result.content) }
          })
        }
      : {})
  })
  return toBinary(ConversationStep, create(ConversationStep, {
    message: {
      case: 'toolCall',
      value: create(ToolCall, { tool: { case: 'mcpToolCall', value: mcpToolCall } })
    }
  }))
}

export function freshConversationId() {
  // Cursor reloads every blob it already stored for a conversation id. This
  // process only has the blobs for the run it is building, so a fresh run must
  // not reuse an id from an earlier prompt or the server answers
  // "The requested blob was not found".
  return crypto.randomUUID()
}

export function buildCursorRequest(modelId, systemPrompt, userText, turns, conversationId, blobStore, options = {}) {
  const systemBlobId = storeBlob(Buffer.from(JSON.stringify({ role: 'system', content: systemPrompt })), blobStore)
  const rootPromptIds = [systemBlobId]
  for (const entry of modelVisiblePrompt(options.promptMessages, options.resume)) {
    rootPromptIds.push(storeBlob(Buffer.from(JSON.stringify(entry)), blobStore))
  }
  const selectedCtxBlob = storeBlob(buildSelectedContextBlob([systemBlobId]), blobStore)
  const mcpTools = buildMcpTools(options.tools)
  const requestContext = buildRequestContext(mcpTools)
  const turnBlobIds = []
  for (const turn of turns) {
    const userMsg = createUserMessage(turn.userText, selectedCtxBlob)
    const userMsgBlobId = storeBlob(toBinary(UserMessage, userMsg), blobStore)
    const stepBlobIds = turn.steps.map((step) => storeBlob(buildTurnStepBytes(step), blobStore))
    const agentTurn = create(AgentConversationTurn, {
      userMessage: userMsgBlobId,
      steps: stepBlobIds,
      requestId: crypto.randomUUID()
    })
    turnBlobIds.push(storeBlob(toBinary(ConversationTurn, create(ConversationTurn, {
      turn: { case: 'agentConversationTurn', value: agentTurn }
    })), blobStore))
  }
  const conversationState = create(ConversationStateStructure, {
    rootPromptMessagesJson: rootPromptIds,
    turns: turnBlobIds,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    mode: 1,
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
    clientName: 'open-pencil'
  })
  const action = options.resume
    ? create(ConversationAction, {
        action: { case: 'resumeAction', value: create(ResumeAction, { requestContext }) }
      })
    : create(ConversationAction, {
        action: {
          case: 'userMessageAction',
          value: create(UserMessageAction, {
            userMessage: createUserMessage(userText, selectedCtxBlob),
            requestContext
          })
        }
      })
  const runRequest = create(AgentRunRequest, {
    conversationState,
    action,
    modelDetails: create(ModelDetails, {
      modelId,
      displayModelId: modelId,
      displayName: modelId
    }),
    mcpTools: create(McpTools, { mcpTools }),
    mcpFileSystemOptions: create(McpFileSystemOptions, { enabled: false, mcpDescriptors: [] }),
    skillOptions: create(SkillOptions, { skillDescriptors: [] }),
    // custom_system_prompt is forwarded as `agent --system-prompt`, which the
    // current Cursor agent rejects with "unknown option '--system-prompt'".
    // The system text stays in root_prompt_messages_json instead.
    conversationId
  })
  return toBinary(AgentClientMessage, create(AgentClientMessage, {
    message: { case: 'runRequest', value: runRequest }
  }))
}

function clientFrame(messageCase, valueSchema, value) {
  const clientMessage = create(AgentClientMessage, {
    message: { case: messageCase, value: create(valueSchema, value) }
  })
  return frameConnectMessage(toBinary(AgentClientMessage, clientMessage))
}

function heartbeatFrame() {
  return frameConnectMessage(toBinary(AgentClientMessage, create(AgentClientMessage, {
    message: { case: 'clientHeartbeat', value: create(ClientHeartbeat, {}) }
  })))
}

function sendExecResult(execMsg, messageCase, valueSchema, value, bridge) {
  const execClientMessage = create(ExecClientMessage, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase, value: create(valueSchema, value) }
  })
  bridge.write(frameConnectMessage(toBinary(AgentClientMessage, create(AgentClientMessage, {
    message: { case: 'execClientMessage', value: execClientMessage }
  }))))
}

function rejectShell(execMsg, messageCase, schema, args, bridge) {
  sendExecResult(execMsg, messageCase, schema, {
    [messageCase === 'shellStream' ? 'event' : 'result']: {
      case: 'rejected',
      value: create(ShellRejected, {
        command: args?.command ?? '',
        workingDirectory: args?.workingDirectory ?? '',
        reason: REJECT_REASON,
        isReadonly: false
      })
    }
  }, bridge)
}

function handleExec(execMsg, mcpTools, bridge, onMcp) {
  const execCase = execMsg.message?.case
  const args = execMsg.message?.value
  if (execCase === 'requestContextArgs') {
    sendExecResult(execMsg, 'requestContextResult', RequestContextResult, {
      result: {
        case: 'success',
        value: create(RequestContextSuccess, {
          requestContext: create(RequestContext, { tools: mcpTools })
        })
      }
    }, bridge)
    return
  }
  if (execCase === 'mcpArgs') {
    const toolName = args?.toolName || args?.name || 'tool'
    const allowed = allowedToolNames(mcpTools)
    if (!allowed.has(toolName)) {
      sendExecResult(execMsg, 'mcpResult', McpResult, {
        result: {
          case: 'toolNotFound',
          value: create(McpToolNotFound, { name: toolName, availableTools: [...allowed] })
        }
      }, bridge)
      return
    }
    const decoded = {}
    for (const [key, value] of Object.entries(args?.args ?? {})) decoded[key] = decodeMcpArgValue(value)
    onMcp({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: args?.toolCallId || crypto.randomUUID(),
      toolName,
      decodedArgs: JSON.stringify(decoded)
    })
    return
  }
  if (execCase === 'readArgs') {
    sendExecResult(execMsg, 'readResult', ReadResult, {
      result: { case: 'rejected', value: create(ReadRejected, { path: args?.path ?? '', reason: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'lsArgs') {
    sendExecResult(execMsg, 'lsResult', LsResult, {
      result: { case: 'rejected', value: create(LsRejected, { path: args?.path ?? '', reason: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'writeArgs') {
    sendExecResult(execMsg, 'writeResult', WriteResult, {
      result: { case: 'rejected', value: create(WriteRejected, { path: args?.path ?? '', reason: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'deleteArgs') {
    sendExecResult(execMsg, 'deleteResult', DeleteResult, {
      result: { case: 'rejected', value: create(DeleteRejected, { path: args?.path ?? '', reason: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'grepArgs') {
    sendExecResult(execMsg, 'grepResult', GrepResult, {
      result: { case: 'error', value: create(GrepError, { error: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'shellArgs') {
    rejectShell(execMsg, 'shellResult', ShellResult, args, bridge)
    return
  }
  if (execCase === 'shellStreamArgs') {
    rejectShell(execMsg, 'shellStream', ShellStream, args, bridge)
    return
  }
  if (execCase === 'backgroundShellSpawnArgs') {
    rejectShell(execMsg, 'backgroundShellSpawnResult', BackgroundShellSpawnResult, args, bridge)
    return
  }
  if (execCase === 'fetchArgs') {
    sendExecResult(execMsg, 'fetchResult', FetchResult, {
      result: { case: 'error', value: create(FetchError, { url: args?.url ?? '', error: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'writeShellStdinArgs') {
    sendExecResult(execMsg, 'writeShellStdinResult', WriteShellStdinResult, {
      result: { case: 'error', value: create(WriteShellStdinError, { error: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'diagnosticsArgs') {
    sendExecResult(execMsg, 'diagnosticsResult', DiagnosticsResult, {}, bridge)
    return
  }
  const piReply = {
    piReadArgs: ['piReadResult', 'agent.v1.PiReadExecResult', 'agent.v1.PiReadExecError'],
    piBashArgs: ['piBashResult', 'agent.v1.PiBashExecResult', 'agent.v1.PiBashExecError'],
    piEditArgs: ['piEditResult', 'agent.v1.PiEditExecResult', 'agent.v1.PiEditExecError'],
    piWriteArgs: ['piWriteResult', 'agent.v1.PiWriteExecResult', 'agent.v1.PiWriteExecError'],
    piGrepArgs: ['piGrepResult', 'agent.v1.PiGrepExecResult', 'agent.v1.PiGrepExecError'],
    piFindArgs: ['piFindResult', 'agent.v1.PiFindExecResult', 'agent.v1.PiFindExecError'],
    piLsArgs: ['piLsResult', 'agent.v1.PiLsExecResult', 'agent.v1.PiLsExecError']
  }[execCase]
  if (piReply) {
    const [resultCase, resultName, errorName] = piReply
    sendExecResult(execMsg, resultCase, cursorSchema(resultName), {
      result: { case: 'error', value: create(cursorSchema(errorName), { error: REJECT_REASON }) }
    }, bridge)
    return
  }
  if (execCase === 'executeHookArgs') {
    const requestCase = args?.request?.request?.case
    const hookSchema = {
      preCompact: 'agent.v1.PreCompactRequestResponse',
      subagentStart: 'agent.v1.SubagentStartRequestResponse',
      subagentStop: 'agent.v1.SubagentStopRequestResponse',
      preToolUse: 'agent.v1.PreToolUseRequestResponse',
      postToolUse: 'agent.v1.PostToolUseRequestResponse',
      postToolUseFailure: 'agent.v1.PostToolUseFailureRequestResponse',
      beforeSubmitPrompt: 'agent.v1.BeforeSubmitPromptRequestResponse',
      afterAgentResponse: 'agent.v1.AfterAgentResponseRequestResponse',
      afterAgentThought: 'agent.v1.AfterAgentThoughtRequestResponse',
      stop: 'agent.v1.StopRequestResponse'
    }[requestCase]
    if (!hookSchema) {
      throwExec(execMsg, bridge, `Unsupported hook ${requestCase || 'unset'}`)
      return
    }
    const ExecuteHookResponse = cursorSchema('agent.v1.ExecuteHookResponse')
    sendExecResult(execMsg, 'executeHookResult', cursorSchema('agent.v1.ExecuteHookResult'), {
      response: create(ExecuteHookResponse, {
        response: { case: requestCase, value: create(cursorSchema(hookSchema), {}) }
      })
    }, bridge)
    return
  }
  if (execCase === 'mcpStateExecArgs') {
    const McpStateServer = cursorSchema('agent.v1.McpStateServer')
    const McpStateSuccess = cursorSchema('agent.v1.McpStateSuccess')
    sendExecResult(execMsg, 'mcpStateExecResult', cursorSchema('agent.v1.McpStateExecResult'), {
      result: {
        case: 'success',
        value: create(McpStateSuccess, {
          servers: mcpTools.length
            ? [create(McpStateServer, {
              serverName: 'open-pencil',
              serverIdentifier: 'open-pencil',
              tools: mcpTools,
              status: 'connected'
            })]
            : []
        })
      }
    }, bridge)
    return
  }
  const allowlist = {
    shellAllowlistPrecheckArgs: ['shellAllowlistPrecheckResult', 'agent.v1.ShellAllowlistPrecheckResult'],
    mcpAllowlistPrecheckArgs: ['mcpAllowlistPrecheckResult', 'agent.v1.McpAllowlistPrecheckResult'],
    webFetchAllowlistPrecheckArgs: ['webFetchAllowlistPrecheckResult', 'agent.v1.WebFetchAllowlistPrecheckResult']
  }[execCase]
  if (allowlist) {
    sendExecResult(execMsg, allowlist[0], cursorSchema(allowlist[1]), { allowlisted: false }, bridge)
    return
  }
  const unknown = (execMsg.$unknown ?? []).map((field) => field.no).join(',')
  console.error(`[cursor-bridge] unhandled exec ${execCase || 'unknown'} fields=${unknown}`)
  throwExec(execMsg, bridge, REJECT_REASON)
}

function throwExec(execMsg, bridge, error) {
  const ExecClientControlMessage = cursorSchema('agent.v1.ExecClientControlMessage')
  const ExecClientThrow = cursorSchema('agent.v1.ExecClientThrow')
  const ExecClientStreamClose = cursorSchema('agent.v1.ExecClientStreamClose')
  bridge.write(clientFrame('execClientControlMessage', ExecClientControlMessage, {
    message: { case: 'throw', value: create(ExecClientThrow, { id: execMsg.id, error, errorCode: 'unsupported' }) }
  }))
  bridge.write(clientFrame('execClientControlMessage', ExecClientControlMessage, {
    message: { case: 'streamClose', value: create(ExecClientStreamClose, { id: execMsg.id }) }
  }))
}

function handleKv(kvMsg, blobStore, bridge) {
  const kvCase = kvMsg.message?.case
  if (kvCase === 'getBlobArgs') {
    const blobId = kvMsg.message.value?.blobId
    const data = blobId ? blobStore.get(Buffer.from(blobId).toString('hex')) : undefined
    if (!data) console.error(`[cursor-bridge] blob miss bytes=${blobId?.length ?? 0}`)
    bridge.write(clientFrame('kvClientMessage', KvClientMessage, {
      id: kvMsg.id,
      message: { case: 'getBlobResult', value: create(GetBlobResult, data ? { blobData: data } : {}) }
    }))
    return
  }
  if (kvCase === 'setBlobArgs') {
    const blobId = kvMsg.message.value?.blobId
    const blobData = kvMsg.message.value?.blobData
    if (blobId && blobData) blobStore.set(Buffer.from(blobId).toString('hex'), blobData)
    bridge.write(clientFrame('kvClientMessage', KvClientMessage, {
      id: kvMsg.id,
      message: { case: 'setBlobResult', value: create(SetBlobResult, {}) }
    }))
  }
}

function createFrameParser(onMessage, onEnd) {
  let pending = Buffer.alloc(0)
  return (chunk) => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 5) {
      const flags = pending[0]
      const length = pending.readUInt32BE(1)
      if (pending.length < 5 + length) break
      const message = pending.subarray(5, 5 + length)
      pending = pending.subarray(5 + length)
      if (flags & CONNECT_END_STREAM_FLAG) onEnd(message)
      else onMessage(message)
    }
  }
}

function bridgeKeyFor(messages) {
  const firstUser = messages.find((message) => message.role === 'user')
  const text = textContent(firstUser?.content).slice(0, 200)
  const system = messages.filter((message) => message.role === 'system').map((message) => textContent(message.content)).join('\n').slice(0, 200)
  return crypto.createHash('sha256').update(`bridge:${system}\n${text}`).digest('hex').slice(0, 24)
}

function completionId() {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`
}

function publicError(error) {
  return String(error?.message ?? error ?? 'Cursor request failed')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 400)
}

function startRun(accessToken, requestBytes) {
  const bridge = openCursorRun(accessToken)
  bridge.write(frameConnectMessage(requestBytes))
  const entry = { bridge, heartbeatTimer: null, touched: Date.now() }
  ensureHeartbeat(entry)
  return entry
}

function ensureHeartbeat(entry) {
  if (entry.heartbeatTimer) return
  entry.heartbeatTimer = setInterval(() => {
    if (entry.bridge.alive) entry.bridge.write(heartbeatFrame())
  }, 5_000)
}

function stopHeartbeat(entry) {
  clearInterval(entry.heartbeatTimer)
  entry.heartbeatTimer = null
}

function cancelBridge(entry) {
  stopHeartbeat(entry)
  if (entry.bridge.alive) {
    const action = create(ConversationAction, {
      action: { case: 'cancelAction', value: create(CancelAction, {}) }
    })
    entry.bridge.write(frameConnectMessage(toBinary(AgentClientMessage, create(AgentClientMessage, {
      message: { case: 'conversationAction', value: action }
    }))))
    entry.bridge.end()
  }
}

export function sweepBridges(now = Date.now()) {
  for (const [key, entry] of activeBridges) {
    if (now - entry.touched > BRIDGE_TTL_MS) {
      activeBridges.delete(key)
      cancelBridge(entry)
    }
  }
}

function sendBytes(res, status, contentType, body) {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function writeToolCalls(res, modelId, pending, stream) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  const toolCalls = pending.map((exec, index) => ({
    index,
    id: exec.toolCallId,
    type: 'function',
    function: { name: exec.toolName, arguments: exec.decodedArgs }
  }))
  if (!stream) {
    sendBytes(res, 200, 'application/json; charset=utf-8', JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: toolCalls },
        finish_reason: 'tool_calls'
      }]
    }))
    return
  }
  const lines = []
  for (const toolCall of toolCalls) {
    lines.push(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }]
    })}`)
  }
  lines.push(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
  })}`)
  lines.push('data: [DONE]')
  sendBytes(res, 200, 'text/event-stream; charset=utf-8', `${lines.join('\n\n')}\n\n`)
}

function sendMcpResults(entry, toolResults) {
  const byId = new Map(toolResults.map((result) => [result.toolCallId, result.content]))
  for (const exec of entry.pending) {
    if (exec.delivered) continue
    const content = byId.get(exec.toolCallId)
    if (content == null) continue
    exec.delivered = true
    const mcpResult = create(McpResult, { result: { case: 'success', value: mcpSuccess(content) } })
    const execClientMessage = create(ExecClientMessage, {
      id: exec.execMsgId,
      execId: exec.execId,
      message: { case: 'mcpResult', value: mcpResult }
    })
    entry.bridge.write(frameConnectMessage(toBinary(AgentClientMessage, create(AgentClientMessage, {
      message: { case: 'execClientMessage', value: execClientMessage }
    }))))
  }
}

const IDLE_MS = 50_000
export const IDLE_REPLY_ERROR = 'Cursor stopped sending a reply'

export function countsAsAgentOutput(messageCase, updateCase, hasText) {
  if (messageCase !== 'interactionUpdate') return false
  if (updateCase === 'textDelta' || updateCase === 'thinkingDelta') return Boolean(hasText)
  return updateCase === 'partialToolCall' || updateCase === 'toolCallDelta' || updateCase === 'toolCallStarted'
}

export function createReplyIdle(idleMs, onIdle, schedule = setTimeout, cancel = clearTimeout) {
  let timer = null
  let stopped = false
  const arm = () => {
    if (stopped) return
    cancel(timer)
    timer = schedule(() => {
      if (!stopped) onIdle()
    }, idleMs)
  }
  return {
    arm,
    stop() {
      stopped = true
      cancel(timer)
      timer = null
    },
    observe(messageCase, updateCase, hasText) {
      if (!stopped && countsAsAgentOutput(messageCase, updateCase, hasText)) arm()
    }
  }
}

export function buildFreshRunRequest(modelId, parsed, conversationId, blobStore, tools) {
  const userText = parsed.resume
    ? ''
    : (parsed.userText || parsed.toolResults.map((result) => result.content).join('\n'))
  return buildCursorRequest(
    modelId,
    parsed.systemPrompt,
    userText,
    parsed.turns,
    conversationId,
    blobStore,
    {
      resume: Boolean(parsed.resume),
      tools,
      promptMessages: parsed.promptMessages
    }
  )
}

function attachStream(entry, modelId, req, res, stream) {
  const id = completionId()
  const created = Math.floor(Date.now() / 1000)
  let closed = false
  let paused = false
  const chunks = []
  const seen = []
  let replyIdle
  let detachListeners = () => {}
  entry.detach?.()
  ensureHeartbeat(entry)
  let started = false
  const beginStream = () => {
    if (started || !stream || res.headersSent) return
    started = true
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders?.()
  }
  const ping = setInterval(() => {
    if (!stream || closed || paused) return
    beginStream()
    res.write(': ping\n\n')
  }, 15_000)
  const send = (data) => {
    if (closed || !stream) return
    beginStream()
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const chunk = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })
  const finish = (status, body) => {
    if (closed || res.writableEnded) return
    closed = true
    detachListeners()
    replyIdle.stop()
    clearInterval(ping)
    stopHeartbeat(entry)
    if (stream && (status === 200 || res.headersSent)) {
      beginStream()
      if (status !== 200) {
        const message = body?.error?.message || IDLE_REPLY_ERROR
        res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`)
      } else {
        res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (!res.headersSent) {
      sendBytes(res, status, 'application/json; charset=utf-8', JSON.stringify(body))
    }
  }
  const abort = () => {
    if (closed || paused) return
    closed = true
    detachListeners()
    replyIdle.stop()
    clearInterval(ping)
    activeBridges.delete(entry.key)
    cancelBridge(entry)
    if (!res.headersSent && !stream) {
      res.writeHead(499, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Client closed request' } }))
    }
  }
  replyIdle = createReplyIdle(IDLE_MS, () => {
    if (closed || paused) return
    console.error(`[cursor-bridge] idle timeout status=${entry.bridge.status} messages=${seen.join(',') || 'none'}`)
    activeBridges.delete(entry.key)
    finish(504, { error: { message: IDLE_REPLY_ERROR } })
    cancelBridge(entry)
  })
  replyIdle.arm()
  req.on('aborted', abort)
  res.on('close', () => {
    if (!closed && !paused) abort()
  })

  const stopData = entry.bridge.onData(createFrameParser((bytes) => {
    let serverMessage
    try {
      serverMessage = fromBinary(AgentServerMessage, bytes)
    } catch (error) {
      if (seen.length < 8) console.error(`[cursor-bridge] decode failed: ${publicError(error)}`)
      return
    }
    const messageCase = serverMessage.message?.case
    const update = messageCase === 'interactionUpdate' ? serverMessage.message.value?.message : null
    if (seen.length < 12) {
      const label = update?.case ? `${messageCase}:${update.case}` : (messageCase || 'empty')
      seen.push(label)
      console.error(`[cursor-bridge] message ${label}`)
    }
    if (!paused && !closed) replyIdle.observe(messageCase, update?.case, Boolean(update?.value?.text))
    if (messageCase === 'interactionUpdate') {
      if (update?.case === 'textDelta' && update.value?.text) {
        chunks.push(update.value.text)
        send(chunk({ content: update.value.text }))
      } else if (update?.case === 'thinkingDelta' && update.value?.text) {
        send(chunk({ reasoning_content: update.value.text }))
      }
      return
    }
    if (messageCase === 'kvServerMessage') {
      handleKv(serverMessage.message.value, entry.blobStore, entry.bridge)
      return
    }
    if (messageCase === 'execServerMessage') {
      handleExec(serverMessage.message.value, entry.mcpTools, entry.bridge, (exec) => {
        entry.pending.push(exec)
        if (paused) return
        paused = true
        activeBridges.set(entry.key, entry)
        entry.touched = Date.now()
        if (stream) {
          const index = entry.pending.length - 1
          send(chunk({
            tool_calls: [{
              index,
              id: exec.toolCallId,
              type: 'function',
              function: { name: exec.toolName, arguments: exec.decodedArgs }
            }]
          }))
          send(chunk({}, 'tool_calls'))
          closed = true
          replyIdle.stop()
          clearInterval(ping)
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          closed = true
          replyIdle.stop()
          clearInterval(ping)
          writeToolCalls(res, modelId, entry.pending, false)
        }
      })
    }
  }, (endBytes) => {
    try {
      const payload = JSON.parse(Buffer.from(endBytes).toString('utf8'))
      if (payload?.error) {
        const message = publicError(payload.error)
        console.error(`[cursor-bridge] upstream error ${message}`)
        // Cursor application errors are not an upstream gateway failure.
        finish(400, { error: { message, type: 'upstream_error' } })
      }
    } catch {
      // An end frame without JSON is a normal close.
    }
  }))

  const stopClose = entry.bridge.onClose((code) => {
    if (paused || closed) return
    if (code !== 0 && !chunks.length) {
      const message = entry.bridge.status === 401 || entry.bridge.status === 403
        ? 'Cursor rejected the access token'
        : 'Cursor stream closed'
      finish(entry.bridge.status === 401 || entry.bridge.status === 403 ? 401 : 502, {
        error: { message }
      })
      return
    }
    const content = chunks.join('')
    if (stream) {
      finish(200)
    } else {
      finish(200, {
        id,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      })
    }
  })
  detachListeners = () => {
    stopData()
    stopClose()
    entry.detach = null
    detachListeners = () => {}
  }
  entry.detach = detachListeners
}

export async function handleChatCompletion(body, accessToken, req, res) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const modelId = typeof body.model === 'string' ? body.model.trim() : ''
  if (!modelId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'model is required' } }))
    return
  }
  const parsed = parseMessages(messages)
  const stream = body.stream === true
  const key = bridgeKeyFor(messages)
  const active = activeBridges.get(key)
  if (active && parsed.toolResults.length && active.bridge.alive) {
    activeBridges.delete(key)
    active.touched = Date.now()
    active.mcpTools = buildMcpTools(body.tools)
    active.detach?.()
    attachStream(active, modelId, req, res, stream)
    sendMcpResults(active, parsed.toolResults)
    return
  }
  if (active) {
    activeBridges.delete(key)
    cancelBridge(active)
  }
  if (!parsed.userText && !parsed.resume) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'No user message found' } }))
    return
  }
  const blobStore = new Map()
  const mcpTools = buildMcpTools(body.tools)
  let requestBytes
  try {
    requestBytes = buildFreshRunRequest(modelId, parsed, freshConversationId(), blobStore, body.tools)
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: publicError(error) } }))
    return
  }
  const entry = {
    ...startRun(accessToken, requestBytes),
    key,
    blobStore,
    mcpTools,
    pending: []
  }
  attachStream(entry, modelId, req, res, stream)
}
