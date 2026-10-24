import assert from 'node:assert/strict'
import test from 'node:test'

import { create, toBinary } from '@bufbuild/protobuf'

import { IDLE_REPLY_ERROR, handleChatCompletion, useCursorRun } from '../src/chat.js'
import { cursorSchema } from '../src/proto.js'

const bridges = []

function frame(data, flags = 0) {
  const bytes = Buffer.from(data)
  const out = Buffer.alloc(5 + bytes.length)
  out[0] = flags
  out.writeUInt32BE(bytes.length, 1)
  bytes.copy(out, 5)
  return out
}

function installRun() {
  return useCursorRun(() => {
    const dataListeners = []
    const bridge = {
      alive: true,
      status: 200,
      write() {},
      end() {
        this.alive = false
      },
      onData(listener) {
        dataListeners.push(listener)
        return () => {}
      },
      onClose() {
        return () => {}
      },
      push(bytes) {
        for (const listener of [...dataListeners]) listener(bytes)
      }
    }
    bridges.push(bridge)
    return bridge
  })
}

const AgentServerMessage = cursorSchema('agent.v1.AgentServerMessage')
const InteractionUpdate = cursorSchema('agent.v1.InteractionUpdate')
const TextDeltaUpdate = cursorSchema('agent.v1.TextDeltaUpdate')
const ThinkingDeltaUpdate = cursorSchema('agent.v1.ThinkingDeltaUpdate')
const TokenDeltaUpdate = cursorSchema('agent.v1.TokenDeltaUpdate')
const TurnEndedUpdate = cursorSchema('agent.v1.TurnEndedUpdate')
const END_FLAG = 0b00000010

function updateFrame(updateCase, value, flags = 0) {
  const bytes = toBinary(AgentServerMessage, create(AgentServerMessage, {
    message: {
      case: 'interactionUpdate',
      value: create(InteractionUpdate, {
        message: { case: updateCase, value }
      })
    }
  }))
  return frame(bytes, flags)
}

function textFrame(text) {
  return updateFrame('textDelta', create(TextDeltaUpdate, { text }))
}

function thinkingFrame(text) {
  return updateFrame('thinkingDelta', create(ThinkingDeltaUpdate, { text }))
}

function tokenFrame(tokens) {
  return updateFrame('tokenDelta', create(TokenDeltaUpdate, { tokens }))
}

function turnFrame() {
  return updateFrame('turnEnded', create(TurnEndedUpdate, {}))
}

function httpResponse() {
  let status = 0
  const chunks = []
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code) {
      status = code
      res.headersSent = true
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(body) {
      if (body) chunks.push(Buffer.from(body))
      res.writableEnded = true
    },
    flushHeaders() {},
    on() {
      return res
    }
  }
  return {
    res,
    status: () => status,
    text: () => Buffer.concat(chunks).toString('utf8')
  }
}

async function complete(prompt, frames, stream = false) {
  const http = httpResponse()
  const pending = handleChatCompletion({
    model: 'grok-4.7-high-fast',
    stream,
    messages: [{ role: 'user', content: prompt }]
  }, 'token', { on() {} }, http.res)
  const bridge = bridges.at(-1)
  assert.ok(bridge)
  bridge.push(Buffer.concat(frames))
  await pending
  return http
}

test('a non-stream turn returns the assistant text instead of crashing', async () => {
  const restore = installRun()
  try {
    const http = await complete('export the button', [
      thinkingFrame('looking'),
      tokenFrame(1),
      textFrame('Hello'),
      turnFrame()
    ])
    assert.equal(http.status(), 200)
    const body = JSON.parse(http.text())
    assert.equal(body.choices[0].message.content, 'Hello')
    assert.equal(body.choices[0].finish_reason, 'stop')
  } finally {
    restore()
  }
})

test('an end frame after text returns the same completion', async () => {
  const restore = installRun()
  try {
    const http = await complete('close the run', [
      textFrame('Done'),
      frame(Buffer.from('not-json'), END_FLAG)
    ])
    assert.equal(http.status(), 200)
    assert.equal(JSON.parse(http.text()).choices[0].message.content, 'Done')
  } finally {
    restore()
  }
})

test('thinking without text stays a timeout, not an empty completion', async () => {
  const restore = installRun()
  try {
    const http = await complete('still thinking', [
      thinkingFrame('hmm'),
      tokenFrame(2),
      turnFrame()
    ])
    assert.equal(http.status(), 504)
    assert.equal(JSON.parse(http.text()).error.message, IDLE_REPLY_ERROR)
  } finally {
    restore()
  }
})

test('a stream turn ends with the text and a stop chunk', async () => {
  const restore = installRun()
  try {
    const http = await complete('stream the label', [
      textFrame('Hello'),
      turnFrame()
    ], true)
    assert.equal(http.status(), 200)
    const text = http.text()
    assert.match(text, /"content":"Hello"/)
    assert.match(text, /"finish_reason":"stop"/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    restore()
  }
})
