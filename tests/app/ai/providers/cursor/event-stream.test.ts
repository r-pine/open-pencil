import { expect, test } from 'bun:test'

import { guardCursorEventStream } from '@/app/ai/providers/cursor/event-stream'

const encoder = new TextEncoder()

const TOOL_DELTA =
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_node","arguments":"{\\"id\\":\\"0:160\\"}"}}]}}]}\n\n'

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function bodyOf(chunks: string[], holdOpen = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk))
      if (!holdOpen) controller.close()
    }
  })
}

async function readGuarded(source: ReadableStream<Uint8Array>, idleMs: number) {
  const reader = guardCursorEventStream(source, { idleMs }).getReader()
  const parts: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { completed: true as const, text: new TextDecoder().decode(merge(parts)) }
      if (value) parts.push(value)
    }
  } catch (error) {
    return {
      completed: false as const,
      error,
      text: new TextDecoder().decode(merge(parts))
    }
  }
}

function merge(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

test('a body of only ping comments ends as a stall the SDK can read', async () => {
  const result = await readGuarded(bodyOf([': ping\n\n', ': ping\n\n']), 5_000)
  expect(result.completed).toBe(true)
  expect(result.text).toContain('Cursor stopped sending a reply')
  expect(result.text).toContain('data: [DONE]')
})

test('a later data event after ping comments is still applied', async () => {
  const result = await readGuarded(
    bodyOf([': ping\n\n', TOOL_DELTA, 'data: [DONE]\n\n']),
    5_000
  )
  expect(result.completed).toBe(true)
  expect(result.text).toContain('"name":"get_node"')
  expect(result.text).toContain('data: [DONE]')
})

test('a data event split across chunks after a ping is still applied', async () => {
  const result = await readGuarded(
    bodyOf([': ping\n\ndata: {"choices":[{"delta":{"content":"He', 'llo"}}]}\n\n']),
    5_000
  )
  expect(result.completed).toBe(true)
  expect(result.text).toContain('Hello')
})

test('a later ping comment extends the wait for the reply', async () => {
  let push: (text: string) => void = () => {}
  let close: () => void = () => {}
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(bytes(text))
      close = () => controller.close()
    }
  })
  const pending = readGuarded(source, 100)
  await new Promise((resolve) => setTimeout(resolve, 60))
  push(': ping\n\n')
  await new Promise((resolve) => setTimeout(resolve, 80))
  push('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
  close()
  const result = await pending
  expect(result.completed).toBe(true)
  expect(result.text).toContain('Hi')
  expect(result.text).not.toContain('Cursor stopped sending a reply')
})

test('an open stream of only ping comments ends as a stall instead of waiting', async () => {
  const result = await readGuarded(bodyOf([': ping\n\n'], true), 40)
  expect(result.completed).toBe(true)
  expect(result.text).toContain(': ping')
  expect(result.text).toContain('Cursor stopped sending a reply')
})
