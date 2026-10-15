import type { FetchFunction } from '@/app/http/types'

/**
 * How long a Cursor chat stream may go without a `data:` event.
 * SSE comments (`: ping`) keep the socket open but are not model output.
 * The bridge sends one about every 15s, so this is a few of those with no reply.
 */
export const CURSOR_SSE_DATA_IDLE_MS = 60_000

/** The chat stream produced no `data:` event, only comments or silence. */
export class CursorEventStreamStallError extends Error {
  constructor() {
    super('Cursor event stream sent no data events')
    this.name = 'CursorEventStreamStallError'
  }
}

/** A completed SSE line whose field name is `data`. Comments (`: ping`) are not. */
export function isSSEDataLine(line: string): boolean {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
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
 * Comment lines do not count as progress. If the body ends, or `idleMs` passes,
 * with no `data:` event, the stream errors instead of ending as an empty completion.
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
      const fail = async (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.error(error)
        try {
          await reader.cancel(error)
        } catch (cancelError) {
          console.warn('Cursor event stream could not be cancelled', cancelError)
        }
      }
      const arm = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          void fail(new CursorEventStreamStallError())
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
            settled = true
            if (!sawData) controller.error(new CursorEventStreamStallError())
            else controller.close()
            return
          }
          controller.enqueue(value)
          pending += decoder.decode(value, { stream: true })
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          if (lines.some((line) => isSSEDataLine(line))) {
            sawData = true
            arm()
          }
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
