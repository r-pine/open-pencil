import { APICallError, StreamProviderError } from 'ai'

import { CursorEventStreamStallError } from '@/app/ai/providers/cursor/event-stream'

export type AIChatFailureReason =
  | 'authentication'
  | 'forbidden'
  | 'insufficient-credit'
  | 'model-not-found'
  | 'network'
  | 'output-limit'
  | 'rate-limit'
  | 'repeated-action'
  | 'request-failed'
  | 'stalled'

export type AIChatFailure = {
  reason: AIChatFailureReason
  detail?: string
  statusCode?: number
  retryable?: boolean
}

export type ProviderErrorShape = {
  statusCode?: unknown
  status?: unknown
  responseStatusCode?: unknown
  responseStatus?: unknown
  code?: unknown
  response?: { status?: unknown }
}

function statusNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return null
}

export function providerErrorStatus(error: unknown): number | null {
  if (APICallError.isInstance(error)) return error.statusCode ?? null
  if (typeof error !== 'object' || error === null) return null
  const value = error as ProviderErrorShape
  return (
    statusNumber(value.statusCode) ??
    statusNumber(value.status) ??
    statusNumber(value.responseStatusCode) ??
    statusNumber(value.responseStatus) ??
    statusNumber(value.code) ??
    statusNumber(value.response?.status)
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizedErrorText(error: unknown): string {
  return errorText(error).toLowerCase()
}

export function isInsufficientCreditError(error: unknown): boolean {
  if (providerErrorStatus(error) === 402) return true
  const text = normalizedErrorText(error)
  return [
    'insufficient credit',
    'insufficient balance',
    'insufficient quota',
    'credit balance',
    'payment required',
    'quota exceeded',
    'billing quota',
    'top up',
    'top-up'
  ].some((phrase) => text.includes(phrase))
}

function statusFailureReason(status: number | null): AIChatFailureReason | null {
  if (status === 401) return 'authentication'
  if (status === 402) return 'insufficient-credit'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'model-not-found'
  if (status === 408) return 'network'
  if (status === 429) return 'rate-limit'
  return null
}

const CURSOR_STALL_TEXT = 'cursor stopped sending a reply'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

/** A Cursor reply that stopped, whether the bridge said so or the event stream went quiet. */
export function isCursorReplyStall(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof CursorEventStreamStallError) return true
    const text = errorMessage(current).toLowerCase()
    if (text.includes(CURSOR_STALL_TEXT) || text.includes('cursor event stream sent no data')) {
      return true
    }
    seen.add(current)
    current = (current as { cause?: unknown }).cause
  }
  const text = errorMessage(error).toLowerCase()
  return text.includes(CURSOR_STALL_TEXT) || text.includes('cursor event stream sent no data')
}

/** Retries must not run again after Cursor has already stopped the reply. */
export function finalizeStallError(error: unknown): unknown {
  if (!isCursorReplyStall(error)) return error
  if (APICallError.isInstance(error)) {
    if (!error.isRetryable) return error
    return new APICallError({
      message: error.message,
      url: error.url,
      requestBodyValues: error.requestBodyValues,
      statusCode: error.statusCode,
      responseHeaders: error.responseHeaders,
      responseBody: error.responseBody,
      cause: error,
      isRetryable: false,
      data: error.data
    })
  }
  if (StreamProviderError.isInstance(error)) {
    if (!error.isRetryable) return error
    return new StreamProviderError({
      message: error.message,
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      isRetryable: false,
      data: error.data,
      cause: error
    })
  }
  return error
}

function failureReason(error: unknown): AIChatFailureReason {
  if (isCursorReplyStall(error)) return 'stalled'
  const statusReason = statusFailureReason(providerErrorStatus(error))
  if (statusReason) return statusReason
  if (isInsufficientCreditError(error)) return 'insufficient-credit'
  const text = normalizedErrorText(error)
  if (
    (text.includes('expired') || text.includes('invalid') || text.includes('authentication')) &&
    (text.includes('key') || text.includes('token') || text.includes('credential'))
  ) {
    return 'authentication'
  }
  if (text.includes('rate limit') || text.includes('too many requests')) return 'rate-limit'
  if (text.includes('model not found') || text.includes('unknown model')) return 'model-not-found'
  if (
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('cors') ||
    text.includes('connection')
  ) {
    return 'network'
  }
  return 'request-failed'
}

export function classifyAIChatFinish(finishReason?: string): AIChatFailure | null {
  return finishReason === 'length' ? { reason: 'output-limit' } : null
}

export function classifyAIChatError(error: unknown): AIChatFailure {
  return {
    reason: failureReason(error),
    detail: errorText(error),
    statusCode: providerErrorStatus(error) ?? undefined,
    // A provider error after the stream starts arrives as StreamProviderError, not APICallError.
    retryable:
      APICallError.isInstance(error) || StreamProviderError.isInstance(error)
        ? error.isRetryable
        : undefined
  }
}
