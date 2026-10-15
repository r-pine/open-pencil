import { tryOnScopeDispose } from '@vueuse/core'
import { ref, watch, type Ref } from 'vue'

import { findModelConnectionForDraft, modelConnection } from '@/app/ai/models'
import type { AIModelProfileDraft } from '@/app/ai/models/types'
import type { ModelOption } from '@open-pencil/core/constants'

import { createCursorPKCE, cursorLoginURL, cursorTokenExpiry } from './pkce'
import { fetchCursorModels, resolveCursorAccessToken, type CursorSession } from './session'

export type CursorLoginStatus =
  | 'idle'
  | 'waiting'
  | 'blocked'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'ready'

const POPUP_NAME = 'open-pencil-cursor'
const POPUP_FEATURES = 'popup,width=520,height=720'
const POLL_TIMEOUT_MS = 3 * 60 * 1000

interface CursorProfileOptions {
  draft: AIModelProfileDraft
  keyInput: Ref<string>
  hasExistingKey: Ref<boolean>
  session: Ref<CursorSession | null>
  setModels: (models: ModelOption[]) => void
}

class CursorLoginTimeout extends Error {}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function pollCursor(uuid: string, verifier: string, signal: AbortSignal) {
  let wait = 1000
  let failures = 0
  const started = Date.now()
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await delay(wait, signal)
    const response = await fetch('/api/cursor/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid, verifier }),
      signal
    })
    if (response.status === 404) {
      failures = 0
      wait = Math.min(wait * 1.2, 5000)
      continue
    }
    if (!response.ok) {
      failures += 1
      if (failures >= 3) throw new Error('poll failed')
      continue
    }
    const data = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown }
    if (typeof data.accessToken === 'string' && data.accessToken && typeof data.refreshToken === 'string') {
      return { accessToken: data.accessToken, refreshToken: data.refreshToken }
    }
  }
  throw new CursorLoginTimeout()
}

export function useCursorProfile({
  draft,
  keyInput,
  hasExistingKey,
  session,
  setModels
}: CursorProfileOptions) {
  const status = ref<CursorLoginStatus>('idle')
  const modelsStatus = ref<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
  let popup: Window | null = null
  let authorizationURL = ''
  let abort: AbortController | null = null
  let loginAccess = ''
  let modelsRequest = 0

  tryOnScopeDispose(() => abort?.abort())

  async function loadModels(accessToken: string): Promise<void> {
    const request = ++modelsRequest
    modelsStatus.value = 'loading'
    try {
      const models = await fetchCursorModels(accessToken)
      if (request !== modelsRequest || draft.providerID !== 'cursor') return
      setModels(models)
      modelsStatus.value = models.length ? 'ready' : 'empty'
    } catch {
      if (request !== modelsRequest) return
      modelsStatus.value = 'error'
    }
  }

  async function loadSaved(): Promise<void> {
    if (draft.providerID !== 'cursor') return
    const typed = keyInput.value.trim()
    if (typed) {
      await loadModels(typed)
      return
    }
    if (!hasExistingKey.value) return
    const connection = findModelConnectionForDraft(draft)
    if (!connection) return
    const stored = modelConnection(connection.id)
    if (!stored) return
    const access = await resolveCursorAccessToken(stored).catch(() => null)
    if (!access || draft.providerID !== 'cursor' || keyInput.value.trim()) return
    await loadModels(access)
  }

  function signIn(): void {
    abort?.abort()
    popup = window.open('about:blank', POPUP_NAME, POPUP_FEATURES)
    if (!popup) {
      status.value = 'blocked'
      return
    }
    const controller = new AbortController()
    abort = controller
    status.value = 'waiting'
    void (async () => {
      try {
        const pkce = await createCursorPKCE()
        authorizationURL = cursorLoginURL(pkce)
        if (popup && !popup.closed) popup.location.href = authorizationURL
        const tokens = await pollCursor(pkce.uuid, pkce.verifier, controller.signal)
        if (controller.signal.aborted) return
        loginAccess = tokens.accessToken
        session.value = {
          refreshToken: tokens.refreshToken,
          expiresAt: String(cursorTokenExpiry(tokens.accessToken))
        }
        keyInput.value = tokens.accessToken
        status.value = 'ready'
        popup?.close()
        await loadModels(tokens.accessToken)
      } catch (error) {
        if (controller.signal.aborted) {
          status.value = 'cancelled'
          return
        }
        status.value = error instanceof CursorLoginTimeout ? 'expired' : 'failed'
        popup?.close()
      }
    })()
  }

  function reopen(): void {
    if (!authorizationURL) return
    popup = window.open(authorizationURL, POPUP_NAME, POPUP_FEATURES)
  }

  function cancel(): void {
    abort?.abort()
    abort = null
    popup?.close()
    status.value = 'idle'
  }

  let modelTimer: ReturnType<typeof setTimeout> | undefined
  watch(keyInput, (value) => {
    const token = value.trim()
    if (token && token === loginAccess) return
    if (status.value === 'ready') status.value = 'idle'
    loginAccess = ''
    session.value = null
    clearTimeout(modelTimer)
    if (draft.providerID !== 'cursor' || !token) return
    modelTimer = setTimeout(() => void loadModels(token), 400)
  })

  watch(
    () => [draft.providerID, hasExistingKey.value] as const,
    () => {
      if (draft.providerID !== 'cursor') {
        modelsStatus.value = 'idle'
        return
      }
      void loadSaved()
    },
    { immediate: true }
  )

  return { status, modelsStatus, signIn, reopen, cancel }
}
