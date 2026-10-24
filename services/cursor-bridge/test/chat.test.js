import assert from 'node:assert/strict'
import test from 'node:test'

import { fromBinary, toJson } from '@bufbuild/protobuf'
import { ValueSchema } from '@bufbuild/protobuf/wkt'

import {
  IDLE_REPLY_ERROR,
  assistantCompletion,
  buildFreshRunRequest,
  countsAsAgentOutput,
  createReplyIdle,
  freshConversationId,
  jsonResponseBody,
  parseMessages
} from '../src/chat.js'
import { cursorSchema } from '../src/proto.js'

const ConversationStep = cursorSchema('agent.v1.ConversationStep')
const AgentClientMessage = cursorSchema('agent.v1.AgentClientMessage')

function decodeArgs(args) {
  const decoded = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    decoded[key] = toJson(ValueSchema, fromBinary(ValueSchema, value))
  }
  return decoded
}

function toolSteps(blobStore) {
  const steps = []
  for (const value of blobStore.values()) {
    let step
    try {
      step = fromBinary(ConversationStep, value)
    } catch {
      continue
    }
    if (step.message?.case !== 'toolCall' || step.message.value.tool?.case !== 'mcpToolCall') continue
    const call = step.message.value.tool.value
    const result = call.result?.result
    let text = ''
    if (result?.case === 'success') {
      text = (result.value.content ?? []).map((item) => item.content?.value?.text ?? '').join('\n')
    } else if (result?.case === 'error') {
      text = result.value.error ?? ''
    }
    steps.push({
      toolCallId: call.args?.toolCallId ?? '',
      toolName: call.args?.toolName || call.args?.name || '',
      args: decodeArgs(call.args?.args),
      text
    })
  }
  return steps
}

function freshRun(messages, tools) {
  const parsed = parseMessages(messages)
  const blobStore = new Map()
  const bytes = buildFreshRunRequest(
    'composer-2.5-fast',
    parsed,
    '00000000-0000-4000-8000-000000000001',
    blobStore,
    tools
  )
  const client = fromBinary(AgentClientMessage, bytes)
  assert.equal(client.message?.case, 'runRequest')
  return { parsed, blobStore, run: client.message.value }
}

const headerResult = '{"id":"0:160","name":"Header","type":"FRAME"}'

test('a prior get_node result is encoded on that tool call', () => {
  const { parsed, blobStore, run } = freshRun([
    { role: 'system', content: 'Edit the design.' },
    { role: 'user', content: 'Change the Header title to Hello.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_header',
        type: 'function',
        function: { name: 'get_node', arguments: '{"id":"0:160","depth":3}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_header', content: headerResult }
  ])
  assert.equal(parsed.resume, true)
  assert.equal(run.action.action.case, 'resumeAction')
  const steps = toolSteps(blobStore)
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0], {
    toolCallId: 'call_header',
    toolName: 'get_node',
    args: { id: '0:160', depth: 3 },
    text: headerResult
  })
  const raw = Buffer.concat([...blobStore.values()].map((value) => Buffer.from(value))).toString('utf8')
  assert.match(raw, /Change the Header title to Hello\./)
})

test('tool results stay paired with their tool_call ids', () => {
  const { blobStore, run } = freshRun([
    { role: 'user', content: 'Change the Header title to Hello.' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'get_node', arguments: '{"id":"0:160","depth":3}' }
        },
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'set_text', arguments: '{"id":"0:161","text":"Hello"}' }
        }
      ]
    },
    { role: 'tool', tool_call_id: 'call_b', content: 'SET_OK' },
    { role: 'tool', tool_call_id: 'call_a', content: headerResult }
  ])
  assert.equal(run.action.action.case, 'resumeAction')
  const byId = new Map(toolSteps(blobStore).map((step) => [step.toolCallId, step]))
  assert.equal(byId.get('call_a')?.toolName, 'get_node')
  assert.deepEqual(byId.get('call_a')?.args, { id: '0:160', depth: 3 })
  assert.equal(byId.get('call_a')?.text, headerResult)
  assert.equal(byId.get('call_b')?.toolName, 'set_text')
  assert.equal(byId.get('call_b')?.text, 'SET_OK')
  assert.equal(byId.get('call_b')?.args.text, 'Hello')
})

test('a later user message stays the run action and keeps the earlier tool result', () => {
  const { parsed, blobStore, run } = freshRun([
    { role: 'user', content: 'Change the Header title to Hello.' },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_header',
        type: 'function',
        function: { name: 'get_node', arguments: '{"id":"0:160","depth":3}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_header', content: headerResult },
    { role: 'user', content: 'Use the Header you already loaded.' }
  ])
  assert.equal(parsed.resume, false)
  assert.equal(run.action.action.case, 'userMessageAction')
  assert.equal(run.action.action.value.userMessage.text, 'Use the Header you already loaded.')
  const steps = toolSteps(blobStore)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].toolCallId, 'call_header')
  assert.equal(steps[0].text, headerResult)
})

test('a finished reply without a body is still JSON and keeps the assistant text', () => {
  const completion = assistantCompletion('chatcmpl-1', 10, 'grok-4.7-high-fast', 'hello')
  assert.equal(completion.choices[0].message.content, 'hello')
  assert.equal(completion.choices[0].finish_reason, 'stop')
  const encoded = jsonResponseBody(completion)
  assert.equal(Buffer.from(encoded).toString('utf8'), encoded)
  const missing = jsonResponseBody(undefined)
  assert.equal(typeof missing, 'string')
  assert.equal(JSON.parse(missing).error.message, 'Cursor request failed')
  assert.doesNotThrow(() => Buffer.from(missing))
})

test('heartbeats keep a live reply open until the cap, and a quiet one still stops', () => {
  assert.equal(countsAsAgentOutput('interactionUpdate', 'heartbeat', false), false)
  assert.equal(countsAsAgentOutput('interactionUpdate', 'tokenDelta', false), true)
  assert.equal(countsAsAgentOutput('kvServerMessage', undefined, false), true)
  assert.equal(countsAsAgentOutput('interactionUpdate', 'textDelta', false), false)
  assert.equal(countsAsAgentOutput('interactionUpdate', 'textDelta', true), true)
  let time = 1_000
  const scheduled = []
  let fired = null
  const idle = createReplyIdle(50_000, () => {
    fired = IDLE_REPLY_ERROR
  }, (fn, ms) => {
    const handle = { fn, ms }
    scheduled.push(handle)
    return handle
  }, () => {}, 240_000, () => time)
  idle.arm()
  assert.equal(scheduled.at(-1).ms, 50_000)
  time = 6_000
  idle.observe('interactionUpdate', 'heartbeat', false)
  assert.equal(scheduled.at(-1).ms, 50_000)
  time = 201_000
  idle.observe('interactionUpdate', 'heartbeat', false)
  assert.equal(scheduled.at(-1).ms, 40_000)
  idle.observe('interactionUpdate', 'thinkingDelta', false)
  assert.equal(scheduled.at(-1).ms, 40_000)
  time = 241_000
  idle.observe('interactionUpdate', 'tokenDelta', false)
  assert.equal(scheduled.at(-1).ms, 50_000)
  idle.stop()
  scheduled[0].fn()
  assert.equal(fired, null)
})

function rootMessages(blobStore) {
  const messages = []
  for (const value of blobStore.values()) {
    const text = Buffer.from(value).toString('utf8')
    if (!text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.role === 'string') messages.push(parsed)
    } catch {
      // Binary conversation blobs are not prompt JSON.
    }
  }
  return messages
}

function toolNames(tools) {
  return (tools ?? []).map((tool) => tool.toolName || tool.name)
}

const designTools = [
  { type: 'function', function: { name: 'get_node', description: 'Read a node', parameters: { type: 'object', properties: { id: { type: 'string' } } } } },
  { type: 'function', function: { name: 'list_pages', description: 'List pages', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'render', description: 'Render', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_text', description: 'Set text', parameters: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } } }
]

test('a history ending in list_pages resumes with that result and only the request tools', () => {
  const pageResult = 'current page «02 Иконки»'
  const { parsed, blobStore, run } = freshRun([
    { role: 'system', content: 'Edit the design with the provided tools only.' },
    { role: 'user', content: 'Cut icons into 232×232 components and edit Header text.' },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_old',
        type: 'function',
        function: { name: 'get_node', arguments: '{"id":"0:160","depth":3}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_old', content: headerResult },
    {
      role: 'assistant',
      tool_calls: [{
        id: 'call_text',
        type: 'function',
        function: { name: 'set_text', arguments: '{"id":"0:161","text":"Hello"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_text', content: 'SET_OK' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_pages',
        type: 'function',
        function: { name: 'list_pages', arguments: '{}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_pages', content: pageResult }
  ], designTools)
  assert.equal(parsed.resume, true)
  assert.equal(run.action.action.case, 'resumeAction')
  const steps = toolSteps(blobStore)
  const pages = steps.find((step) => step.toolCallId === 'call_pages')
  assert.equal(pages?.toolName, 'list_pages')
  assert.deepEqual(pages?.args, {})
  assert.equal(pages?.text, pageResult)
  const prompt = rootMessages(blobStore)
  const toolEntries = prompt.filter((message) => message.role === 'tool')
  assert.deepEqual(toolEntries.map((message) => message.id), ['call_old', 'call_text', 'call_pages'])
  assert.equal(toolEntries.at(-1).content[0].type, 'tool-result')
  assert.equal(toolEntries.at(-1).content[0].toolName, 'list_pages')
  assert.equal(toolEntries.at(-1).content[0].result, pageResult)
  const names = toolNames(run.mcpTools?.mcpTools)
  assert.deepEqual(names, ['get_node', 'list_pages', 'render', 'set_text'])
  assert.deepEqual(toolNames(run.action.action.value.requestContext?.tools), names)
  assert.equal(names.includes('get_nodes'), false)
  assert.equal(names.includes('Read'), false)
  assert.equal(names.includes('Shell'), false)
  assert.equal((run.skillOptions?.skillDescriptors ?? []).length, 0)
})

test('a second connection test does not reuse a conversation whose blobs are gone', () => {
  const messages = [{ role: 'user', content: 'Reply with OK.' }]
  const parsed = parseMessages(messages)
  assert.equal(parsed.resume, false)
  assert.equal(parsed.userText, 'Reply with OK.')
  const firstStore = new Map()
  const firstId = freshConversationId()
  const firstBytes = buildFreshRunRequest('grok-4.7-high-fast', parsed, firstId, firstStore)
  const firstRun = fromBinary(AgentClientMessage, firstBytes).message.value
  assert.equal(firstRun.conversationId, firstId)
  assert.equal(firstRun.customSystemPrompt ?? '', '')
  assert.equal(firstRun.action.action.case, 'userMessageAction')
  const discarded = new Set(firstStore.keys())
  firstStore.clear()
  const secondStore = new Map()
  const secondId = freshConversationId()
  const secondBytes = buildFreshRunRequest('grok-4.7-high-fast', parsed, secondId, secondStore)
  const secondRun = fromBinary(AgentClientMessage, secondBytes).message.value
  assert.notEqual(secondId, firstId)
  assert.equal(secondRun.conversationId, secondId)
  assert.equal(secondRun.customSystemPrompt ?? '', '')
  assert.equal(secondRun.action.action.value.userMessage.text, 'Reply with OK.')
  const prompt = rootMessages(secondStore)
  assert.equal(prompt.some((message) => message.role === 'system' && message.content === parsed.systemPrompt), true)
  for (const id of secondStore.keys()) assert.equal(firstStore.has(id), false)
  const referenced = [
    ...(secondRun.conversationState?.rootPromptMessagesJson ?? []),
    ...(secondRun.conversationState?.turns ?? [])
  ].map((id) => Buffer.from(id).toString('hex'))
  assert.ok(referenced.length > 0)
  for (const id of referenced) {
    assert.equal(secondStore.has(id), true)
    assert.equal(discarded.has(id), true)
  }
  assert.equal(secondRun.conversationId === firstRun.conversationId, false)
})

test('tool results drop image bytes before they reach Cursor', () => {
  const pixels = Buffer.alloc(8_000, 7).toString('base64')
  const { blobStore } = freshRun([
    { role: 'user', content: 'export the node' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_export',
        function: { name: 'export_image', arguments: '{"ids":["0:1"]}' }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_export',
      content: [{
        type: 'tool-result',
        toolName: 'export_image',
        toolCallId: 'call_export',
        output: {
          type: 'file',
          mediaType: 'image/png',
          data: pixels,
          caption: 'button row'
        }
      }]
    }
  ])
  const exported = toolSteps(blobStore).find((step) => step.toolName === 'export_image')
  assert.ok(exported)
  assert.equal(exported.text.includes(pixels), false)
  assert.match(exported.text, /omitted \d+ chars/)
  assert.match(exported.text, /button row/)
  for (const value of blobStore.values()) {
    assert.equal(value.includes(Buffer.from(pixels)), false)
  }
})

test('agent text schedules a new idle deadline and a stopped timer does not fire', () => {
  const scheduled = []
  let fired = 0
  const idle = createReplyIdle(50_000, () => {
    fired += 1
  }, (fn, ms) => {
    const handle = { fn, ms }
    scheduled.push(handle)
    return handle
  }, () => {})
  idle.arm()
  idle.observe('interactionUpdate', 'textDelta', true)
  idle.observe('interactionUpdate', 'toolCallStarted', false)
  assert.equal(scheduled.length, 3)
  idle.stop()
  scheduled[0].fn()
  assert.equal(fired, 0)
})
