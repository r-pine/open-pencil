import { create, fromBinary, toBinary } from '@bufbuild/protobuf'

import { handleChatCompletion, sweepBridges } from './chat.js'
import { unaryCursor } from './h2.js'
import { cursorSchema } from './proto.js'

const GetUsableModelsRequest = cursorSchema('agent.v1.GetUsableModelsRequest')
const GetUsableModelsResponse = cursorSchema('agent.v1.GetUsableModelsResponse')
const PORT = Number(process.env.PORT || 8787)
const MAX_BODY = 1_500_000

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function bearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = header.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? ''
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const host = new URL(origin).host
    return host === 'pencil.rpine.xyz' || host === req.headers.host
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function decodeConnectUnaryBody(payload) {
  if (payload.length < 5) return null
  let offset = 0
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]
    const length = payload.readUInt32BE(offset + 1)
    const end = offset + 5 + length
    if (end > payload.length) return null
    if ((flags & 0b00000001) === 0 && (flags & 0b00000010) === 0) {
      return payload.subarray(offset + 5, end)
    }
    offset = end
  }
  return null
}

function cursorModels(decoded) {
  const byId = new Map()
  for (const model of decoded?.models ?? []) {
    const id = typeof model.modelId === 'string' ? model.modelId.trim() : ''
    if (!id) continue
    const name = model.displayName || model.displayNameShort || model.displayModelId || id
    byId.set(id, { id, name, reasoning: Boolean(model.thinkingDetails) })
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function listModels(accessToken) {
  const requestBody = Buffer.from(toBinary(GetUsableModelsRequest, create(GetUsableModelsRequest, {})))
  const response = await unaryCursor(
    accessToken,
    '/agent.v1.AgentService/GetUsableModels',
    requestBody
  )
  if (response.status === 401 || response.status === 403) {
    const error = new Error('unauthorized')
    error.status = 401
    throw error
  }
  if (response.status && response.status !== 200) {
    const error = new Error('models failed')
    error.status = 502
    throw error
  }
  let decoded = null
  try {
    decoded = fromBinary(GetUsableModelsResponse, response.body)
  } catch {
    const framed = decodeConnectUnaryBody(response.body)
    if (framed) decoded = fromBinary(GetUsableModelsResponse, framed)
  }
  return cursorModels(decoded)
}

async function handlePoll(req, res) {
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    sendJSON(res, 400, { error: 'invalid json' })
    return
  }
  const uuid = typeof payload.uuid === 'string' ? payload.uuid : ''
  const verifier = typeof payload.verifier === 'string' ? payload.verifier : ''
  if (!uuid || !verifier) {
    sendJSON(res, 400, { error: 'uuid and verifier are required' })
    return
  }
  const upstream = await fetch(
    `https://api2.cursor.sh/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`
  )
  if (upstream.status === 404) {
    sendJSON(res, 404, { pending: true })
    return
  }
  const text = await upstream.text()
  if (!upstream.ok) {
    sendJSON(res, upstream.status === 401 ? 401 : 502, { error: 'poll failed' })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

async function handleRefresh(req, res) {
  const token = bearer(req)
  if (!token) {
    sendJSON(res, 401, { error: 'missing bearer token' })
    return
  }
  const upstream = await fetch('https://api2.cursor.sh/auth/exchange_user_api_key', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  })
  const text = await upstream.text()
  if (!upstream.ok) {
    sendJSON(res, upstream.status === 401 || upstream.status === 403 ? 401 : 502, {
      error: 'refresh failed'
    })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

async function handleModels(req, res) {
  const token = bearer(req)
  if (!token) {
    sendJSON(res, 401, { error: 'missing bearer token' })
    return
  }
  try {
    sendJSON(res, 200, await listModels(token))
  } catch (error) {
    sendJSON(res, error.status === 401 ? 401 : 502, { error: 'models failed' })
  }
}

async function handleChat(req, res) {
  const token = bearer(req)
  if (!token) {
    sendJSON(res, 401, { error: 'missing bearer token' })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJSON(res, 400, { error: 'invalid json' })
    return
  }
  await handleChatCompletion(body, token, req, res)
}

function route(req) {
  const url = new URL(req.url ?? '/', 'http://cursor-bridge')
  return { method: req.method ?? 'GET', path: url.pathname }
}

const server = (await import('node:http')).createServer(async (req, res) => {
  const { method, path } = route(req)
  if (!originAllowed(req)) {
    sendJSON(res, 403, { error: 'origin not allowed' })
    return
  }
  try {
    if (method === 'GET' && (path === '/health' || path === '/api/cursor/health')) {
      sendJSON(res, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === '/api/cursor/auth/poll') {
      await handlePoll(req, res)
      return
    }
    if (method === 'POST' && path === '/api/cursor/auth/refresh') {
      await handleRefresh(req, res)
      return
    }
    if (method === 'POST' && path === '/api/cursor/models') {
      await handleModels(req, res)
      return
    }
    if (method === 'POST' && path === '/api/cursor/chat/completions') {
      await handleChat(req, res)
      return
    }
    sendJSON(res, 404, { error: 'not found' })
  } catch {
    if (!res.headersSent) sendJSON(res, 500, { error: 'bridge failed' })
  }
})

setInterval(() => sweepBridges(), 30_000).unref()
server.listen(PORT, '0.0.0.0', () => {
  console.log(`cursor bridge listening on ${PORT}`)
})
