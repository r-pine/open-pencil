const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'

export interface CursorPKCE {
  verifier: string
  challenge: string
  uuid: string
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function createCursorPKCE(): Promise<CursorPKCE> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64url(verifierBytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return {
    verifier,
    challenge: base64url(new Uint8Array(digest)),
    uuid: crypto.randomUUID()
  }
}

export function cursorLoginURL(pkce: Pick<CursorPKCE, 'challenge' | 'uuid'>): string {
  const params = new URLSearchParams({
    challenge: pkce.challenge,
    uuid: pkce.uuid,
    mode: 'login',
    redirectTarget: 'cli'
  })
  return `${CURSOR_LOGIN_URL}?${params.toString()}`
}

export function cursorTokenExpiry(token: string): number {
  try {
    const part = token.split('.')[1]
    if (!part) return Date.now() + 60 * 60 * 1000
    const payload = JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))) as { exp?: unknown }
    if (typeof payload.exp === 'number') return payload.exp * 1000 - 5 * 60 * 1000
  } catch {
    // A non-JWT token is refreshed on a one-hour clock.
  }
  return Date.now() + 60 * 60 * 1000
}
