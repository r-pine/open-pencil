import * as v from 'valibot'

/** Where official OpenPencil builds send pings, usage stats, and waitlist sign-ups. */
export const FEEDBACK_ORIGIN = 'https://feedback.openpencil.dev'

export const PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android', 'unknown'] as const
export const ARCHITECTURES = ['arm64', 'x64', 'unknown'] as const
export const APP_KINDS = ['desktop', 'web'] as const
export const BROWSERS = ['chrome', 'edge', 'opera', 'firefox', 'safari', 'unknown'] as const
export const LOCALES = ['en', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'ru', 'zh-CN'] as const
export const DOCUMENT_FORMATS = [
  'fig',
  'pen',
  'png',
  'jpg',
  'webp',
  'svg',
  'pdf',
  'pptx',
  'jsx',
  'tailwind-jsx',
  'html'
] as const
export const AI_PROVIDERS = [
  'openrouter',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'openai-compatible',
  'zai',
  'minimax',
  'cursor',
  'anthropic-compatible',
  'harness:pi',
  'acp:claude-code',
  'acp:codex',
  'acp:gemini-cli'
] as const

export type Platform = (typeof PLATFORMS)[number]
export type Architecture = (typeof ARCHITECTURES)[number]
export type AppKind = (typeof APP_KINDS)[number]
export type Browser = (typeof BROWSERS)[number]
export type Locale = (typeof LOCALES)[number]
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number]
export type AIProvider = (typeof AI_PROVIDERS)[number]

/** The install's answer to the usage stats question; `unset` until it is asked and answered. */
export const USAGE_STATS_ANSWERS = ['unset', 'granted', 'denied'] as const
export type UsageStatsAnswer = (typeof USAGE_STATS_ANSWERS)[number]

/** Where a person agreed to share usage stats. */
export const CONSENT_SOURCES = ['welcome', 'prompt', 'settings'] as const
export type ConsentSource = (typeof CONSENT_SOURCES)[number]

const AppVersionSchema = v.pipe(
  v.string(),
  v.maxLength(32),
  v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)
)

/** The build an install runs; every ping and every usage batch carries it and nothing else about the device. */
const buildEntries = {
  version: AppVersionSchema,
  platform: v.picklist(PLATFORMS),
  arch: v.picklist(ARCHITECTURES),
  app: v.picklist(APP_KINDS),
  browser: v.picklist(BROWSERS)
}

export const BuildSchema = v.strictObject(buildEntries)
export type Build = v.InferOutput<typeof BuildSchema>

/**
 * The daily anonymous ping: no identifier, only which build is running and how the install
 * answered the usage stats question, which counts the installs that declined.
 */
export const PingSchema = v.strictObject({
  ...buildEntries,
  usageStats: v.picklist(USAGE_STATS_ANSWERS)
})
export type Ping = v.InferOutput<typeof PingSchema>

const timestamp = v.pipe(v.string(), v.isoTimestamp())

/**
 * Every usage event official builds may send, and the only ones the ingest proxy forwards.
 * A property is a closed list of values, so no event can carry names, text, or paths.
 */
export const UsageEventSchema = v.variant('name', [
  v.strictObject({ name: v.literal('app_opened'), timestamp, locale: v.picklist(LOCALES) }),
  v.strictObject({
    name: v.literal('document_opened'),
    timestamp,
    format: v.picklist(DOCUMENT_FORMATS)
  }),
  v.strictObject({
    name: v.literal('document_exported'),
    timestamp,
    format: v.picklist(DOCUMENT_FORMATS)
  }),
  v.strictObject({
    name: v.literal('ai_reply_finished'),
    timestamp,
    provider: v.picklist(AI_PROVIDERS)
  }),
  v.strictObject({
    name: v.literal('usage_stats_enabled'),
    timestamp,
    source: v.picklist(CONSENT_SOURCES)
  })
])
export type UsageEvent = v.InferOutput<typeof UsageEventSchema>
export type UsageEventName = UsageEvent['name']

export const USAGE_BATCH_LIMIT = 50

/** A batch of usage events from one install that agreed to share them. */
export const UsageBatchSchema = v.strictObject({
  ...buildEntries,
  /** A random ID made on the device when its user agreed; it names no person or account. */
  installId: v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/)),
  events: v.pipe(v.array(UsageEventSchema), v.minLength(1), v.maxLength(USAGE_BATCH_LIMIT))
})
export type UsageBatch = v.InferOutput<typeof UsageBatchSchema>

/** The public Turnstile site key for the website's waitlist form; the secret lives on the Worker. */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFUZEGj-sE8C_2zT'

/** The `data-action` the waitlist form gives its widget; tokens issued for anything else are refused. */
export const WAITLIST_TURNSTILE_ACTION = 'waitlist'

/** A Cloud waitlist sign-up from the website form. */
export const WaitlistSignupSchema = v.strictObject({
  email: v.pipe(v.string(), v.trim(), v.maxLength(254), v.email()),
  /** What the person would use Cloud for, if they say. */
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  turnstileToken: v.pipe(v.string(), v.minLength(1), v.maxLength(2048))
})
export type WaitlistSignup = v.InferOutput<typeof WaitlistSignupSchema>
