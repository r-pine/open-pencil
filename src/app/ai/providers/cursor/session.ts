import type { ModelOption } from '@open-pencil/core/constants'

import type { AIModelConnection } from '@/app/ai/models/types'
import { appCredentialServices } from '@/app/settings/credentials/app'
import { providerCredentialRef } from '@/app/settings/credentials/migration'
import { credentialRef } from '@/app/settings/credentials/reference'

import { cursorTokenExpiry } from './pkce'

export type CursorSession = {
  refreshToken: string
  expiresAt: string
}

function extraRef(connection: AIModelConnection, field: 'refresh-token' | 'expires-at') {
  return credentialRef('cursor', field, connection.credentialProfileId)
}

export async function writeCursorSession(
  connection: AIModelConnection,
  session: CursorSession
): Promise<void> {
  await appCredentialServices.manager.set(extraRef(connection, 'refresh-token'), session.refreshToken)
  await appCredentialServices.manager.set(extraRef(connection, 'expires-at'), session.expiresAt)
}

export async function clearCursorSession(connection: AIModelConnection): Promise<void> {
  await appCredentialServices.manager.clear(extraRef(connection, 'refresh-token'))
  await appCredentialServices.manager.clear(extraRef(connection, 'expires-at'))
}

/** Returns a usable access token, refreshing it in the browser credential store when it is due. */
export async function resolveCursorAccessToken(
  connection: AIModelConnection
): Promise<string | null> {
  const accessRef = providerCredentialRef(connection.providerID, connection.credentialProfileId)
  const access = await appCredentialServices.resolver.resolve(accessRef)
  const refresh = await appCredentialServices.resolver.resolve(extraRef(connection, 'refresh-token'))
  if (!access) return null
  if (!refresh) return access
  const expires = Number(await appCredentialServices.resolver.resolve(extraRef(connection, 'expires-at')))
  if (Number.isFinite(expires) && Date.now() < expires) return access

  const response = await fetch('/api/cursor/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${refresh}` }
  })
  if (!response.ok) return access
  const data = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown }
  if (typeof data.accessToken !== 'string' || !data.accessToken) return access
  const nextRefresh = typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : refresh
  await appCredentialServices.manager.set(accessRef, data.accessToken)
  await writeCursorSession(connection, {
    refreshToken: nextRefresh,
    expiresAt: String(cursorTokenExpiry(data.accessToken))
  })
  return data.accessToken
}

export async function fetchCursorModels(accessToken: string): Promise<ModelOption[]> {
  const response = await fetch('/api/cursor/models', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!response.ok) throw new Error('Cursor models request failed')
  const data = (await response.json()) as unknown
  if (!Array.isArray(data)) return []
  const models: ModelOption[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const model = entry as { id?: unknown; name?: unknown }
    if (typeof model.id !== 'string' || !model.id) continue
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name ? model.name : model.id,
      capabilities: ['tools', 'vision']
    })
  }
  return models
}
