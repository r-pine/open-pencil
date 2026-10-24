import type { FetchFunction } from '@/app/http/types'

/**
 * How long the chat may go without a `data:` event or a bridge `: ping`.
 * Each ping means the bridge is still waiting on Cursor and starts this window again.
 * The bridge itself closes a run that has gone quiet.
 */
export const CURSOR_SSE_DATA_IDLE_MS = 60_000

/** The chat stream produced no `data:` event, only comments or silence. */
export class CursorEventStreamStallError extends Error {
  constructor() {
    super('Cursor event stream sent no data events')
    this.name = 'CursorEventStreamStallError'
  }
}

/**
 * SSE the AI SDK already understands. `controller.error` on a 200 body is rewritten
 * as "Failed to process successful response", which hides this stall.
 */
const STALL_SSE = new TextEncoder().encode(
  'data: {"error":{"message":"Cursor stopped sending a reply"}}\n\ndata: [DONE]\n\n'
)

function sseLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** A completed SSE comment. The bridge uses these as `: ping` keepalives. */
export function isSSEPingLine(line: string): boolean {
  return sseLine(line).startsWith(':')
}

/** A completed SSE line whose field name is `data`. Comments (`: ping`) are not. */
export function isSSEDataLine(line: string): boolean {
  const text = sseLine(line)
  if (text.startsWith(':')) return false
  const colon = text.indexOf(':')
  const field = colon === -1 ? text : text.slice(0, colon)
  return field === 'data'
}

type GuardOptions = {
  idleMs?: number
}

/**
 * Forwards an SSE body unchanged, including tool-call and text `data:` events.
 * A `: ping` comment extends the wait. If the body ends with no `data:` event,
 * or nothing arrives for `idleMs`, the stream ends on a stall frame the SDK
 * reports as a provider error. Erroring the 200 body would hide that as a
 * successful response.
 */
export function guardCursorEventStream(
  source: ReadableStream<Uint8Array>,
  options: GuardOptions = {}
): ReadableStream<Uint8Array> {
  const idleMs = options.idleMs ?? CURSOR_SSE_DATA_IDLE_MS
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let sawData = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const stall = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.enqueue(STALL_SSE)
        controller.close()
        void reader.cancel(new CursorEventStreamStallError()).catch((cancelError: unknown) => {
          console.warn('Cursor event stream could not be cancelled', cancelError)
        })
      }
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          stall()
        }, idleMs)
      }
      arm()
      try {
        while (!settled) {
          const { done, value } = await reader.read()
          if (settled) return
          if (done) {
            pending += decoder.decode()
            if (isSSEDataLine(pending)) sawData = true
            clearTimeout(timer)
            if (!sawData) {
              stall()
              return
            }
            settled = true
            controller.close()
            return
          }
          controller.enqueue(value)
          pending += decoder.decode(value, { stream: true })
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          if (lines.some((line) => isSSEDataLine(line))) sawData = true
          if (sawData || lines.some((line) => isSSEPingLine(line))) arm()
        }
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.error(error instanceof Error ? error : new Error(String(error)))
      }
    },
    cancel(reason) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      return reader.cancel(reason)
    }
  })
}

/** Wraps a 200 event-stream so a ping-only body cannot finish the chat successfully. */
export function guardCursorEventResponse(response: Response, options?: GuardOptions): Response {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || response.body == null || !contentType.includes('text/event-stream')) {
    return response
  }
  return new Response(guardCursorEventStream(response.body, options), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

/** Cursor chat completions go through the bridge; other providers keep their own fetch. */
export function cursorChatFetch(base: FetchFunction | undefined): FetchFunction {
  const fetchImpl = base ?? fetch
  return async (input, init) => guardCursorEventResponse(await fetchImpl(input, init))
}
