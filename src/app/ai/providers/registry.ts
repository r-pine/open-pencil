import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'

import type { AIProviderID } from '@open-pencil/core/constants'

import {
  createAnthropicCompatibleAdapter,
  createOpenAICompatibleAdapter
} from '@/app/ai/providers/compatible'
import { cursorChatFetch } from '@/app/ai/providers/cursor/event-stream'
import type { ModelProviderAdapter } from '@/app/ai/providers/types'

type DirectProviderID = Exclude<AIProviderID, `acp:${string}` | `harness:${string}`>

function cursorBridgeBaseURL(): string {
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return `${window.location.origin}/api/cursor`
  }
  return 'http://127.0.0.1/api/cursor'
}

const MODEL_PROVIDER_ADAPTERS = {
  openrouter: {
    create(config, runtime) {
      const provider = createOpenRouter({
        apiKey: config.apiKey,
        fetch: runtime.fetch,
        headers: {
          'X-OpenRouter-Title': 'OpenPencil',
          'HTTP-Referer': 'https://github.com/open-pencil/open-pencil'
        }
      })
      return provider(config.customModelID.trim() || config.modelID)
    }
  },
  anthropic: createAnthropicCompatibleAdapter(),
  openai: createOpenAICompatibleAdapter(),
  google: {
    create(config, runtime) {
      return createGoogleGenerativeAI({ apiKey: config.apiKey, fetch: runtime.fetch })(
        config.modelID
      )
    }
  },
  deepseek: {
    create(config, runtime) {
      return createDeepSeek({ apiKey: config.apiKey, fetch: runtime.fetch })(config.modelID)
    }
  },
  zai: createAnthropicCompatibleAdapter({ baseURL: 'https://api.z.ai/api/anthropic' }),
  minimax: createOpenAICompatibleAdapter({ baseURL: 'https://api.minimax.io/v1', mode: 'chat' }),
  cursor: {
    create(config, runtime) {
      return createOpenAICompatibleAdapter({
        baseURL: cursorBridgeBaseURL,
        mode: 'chat'
      }).create(config, { fetch: cursorChatFetch(runtime.fetch) })
    }
  },
  'openai-compatible': createOpenAICompatibleAdapter({
    baseURL: (config) => config.customBaseURL,
    mode: 'configurable'
  }),
  'anthropic-compatible': createAnthropicCompatibleAdapter({
    baseURL: (config) => config.customBaseURL
  })
} satisfies Record<DirectProviderID, ModelProviderAdapter>

function isDirectProviderID(providerID: AIProviderID): providerID is DirectProviderID {
  return !providerID.startsWith('acp:') && providerID !== 'harness:pi'
}

export function modelProviderAdapter(providerID: AIProviderID): ModelProviderAdapter {
  if (!isDirectProviderID(providerID)) {
    throw new Error('ACP providers and Harness agents do not use direct API models')
  }
  return MODEL_PROVIDER_ADAPTERS[providerID]
}
