import crypto from 'node:crypto'
import http2 from 'node:http2'

const CURSOR_API = 'https://api2.cursor.sh'
const CURSOR_CLIENT_VERSION = 'cli-2026.01.09-231024f'

export function frameConnectMessage(data, flags = 0) {
  const bytes = Buffer.from(data)
  const frame = Buffer.alloc(5 + bytes.length)
  frame[0] = flags
  frame.writeUInt32BE(bytes.length, 1)
  bytes.copy(frame, 5)
  return frame
}

function cursorHeaders(accessToken, rpcPath, unary) {
  const headers = {
    ':method': 'POST',
    ':path': rpcPath,
    'content-type': unary ? 'application/proto' : 'application/connect+proto',
    te: 'trailers',
    authorization: `Bearer ${accessToken}`,
    'x-ghost-mode': 'true',
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'cli',
    'x-request-id': crypto.randomUUID()
  }
  if (!unary) headers['connect-protocol-version'] = '1'
  return headers
}

export function unaryCursor(accessToken, rpcPath, body, timeoutMs = 20_000) {
  const client = http2.connect(CURSOR_API)
  const stream = client.request(cursorHeaders(accessToken, rpcPath, true))
  const chunks = []
  let status = 0
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.close(http2.constants.NGHTTP2_CANCEL)
      client.destroy()
      reject(new Error('Cursor request timed out'))
    }, timeoutMs)
    const fail = (error) => {
      clearTimeout(timer)
      client.destroy()
      reject(error instanceof Error ? error : new Error('Cursor request failed'))
    }
    client.on('error', fail)
    stream.on('error', fail)
    stream.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0)
    })
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => {
      clearTimeout(timer)
      client.close()
      resolve({ status, body: Buffer.concat(chunks) })
    })
    stream.end(body)
  })
}

export function openCursorRun(accessToken) {
  const client = http2.connect(CURSOR_API)
  const stream = client.request(
    cursorHeaders(accessToken, '/agent.v1.AgentService/Run', false)
  )
  let alive = true
  let status = 0
  const dataListeners = []
  const closeListeners = []
  const fail = () => {
    if (!alive) return
    alive = false
    for (const listener of [...closeListeners]) listener(1)
  }
  client.on('error', fail)
  stream.on('error', fail)
  stream.on('response', (headers) => {
    status = Number(headers[':status'] ?? 0)
  })
  stream.on('data', (chunk) => {
    for (const listener of [...dataListeners]) listener(Buffer.from(chunk))
  })
  stream.on('end', () => {
    if (!alive) return
    alive = false
    client.close()
    for (const listener of [...closeListeners]) listener(0)
  })
  const unsubscribe = (list, listener) => () => {
    const index = list.indexOf(listener)
    if (index >= 0) list.splice(index, 1)
  }
  return {
    get alive() {
      return alive && !stream.closed && !stream.destroyed
    },
    get status() {
      return status
    },
    write(data) {
      if (this.alive) stream.write(data)
    },
    end() {
      if (!this.alive) return
      stream.end()
    },
    onData(listener) {
      dataListeners.push(listener)
      return unsubscribe(dataListeners, listener)
    },
    onClose(listener) {
      closeListeners.push(listener)
      return unsubscribe(closeListeners, listener)
    }
  }
}
