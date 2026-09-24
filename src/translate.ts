import { createHash, createHmac, randomUUID } from "node:crypto"

export type TranslationProvider = "microsoft" | "youdao" | "caiyun" | "openai" | "claude" | "deepseek" | "llm_custom" | "deepl" | "openai_compatible"

export type LanguageCode = "auto" | "zh" | "en" | "ja" | "ko" | "ru" | "ar" | "fr" | "de"

/** 语言显示名称（用于 LLM prompt 和 UI） */
export const LANGUAGE_LABEL: Record<string, string> = {
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  ar: "Arabic",
  fr: "French",
  de: "German"
}

/** Microsoft Translator API 语言代码 */
export const LANGUAGE_MICROSOFT: Record<string, string> = {
  zh: "zh-Hans",
  en: "en",
  ja: "ja",
  ko: "ko",
  ru: "ru",
  ar: "ar",
  fr: "fr",
  de: "de"
}

/** DeepL API 语言代码 */
export const LANGUAGE_DEEPL: Record<string, string> = {
  zh: "ZH",
  en: "EN-US",
  ja: "JA",
  ko: "KO",
  ru: "RU",
  ar: "AR",
  fr: "FR",
  de: "DE"
}

export interface PluginSettings {
  defaultProvider: TranslationProvider
  visibleProviders: TranslationProvider[]
  providerRows: ProviderTableRow[]
  defaultSourceLanguage: LanguageCode
  defaultTargetLanguage: LanguageCode
  /** 配对语言：当源语言等于 Wox 界面语言时翻译成此语言 */
  pairLanguage: LanguageCode
  /** Wox 界面语言（由插件 init 时通过 i18n 探针检测，不需要持久化） */
  woxLanguage?: LanguageCode
  deeplApiKey: string
  openaiBaseUrl: string
  openaiApiKey: string
  openaiModel: string
  requestTimeoutMs: number
  showPreviewDetails: boolean
  historyLimit: number
}

export interface ParsedQuery {
  provider: TranslationProvider
  text: string
  forcedProvider: boolean
  /** 用户通过 tr 指令指定的目标语言，覆盖设置中的目标语言 */
  targetLanguage?: LanguageCode
  /** 用户通过 tr 指令指定的源语言，覆盖设置中的源语言 */
  sourceLanguage?: LanguageCode
}

export interface LanguageDirection {
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  targetLabel: string
  microsoftTarget: string
  deeplTarget: string
}

export interface TranslationRequest {
  text: string
  direction: LanguageDirection
  settings: PluginSettings
}

export interface TranslationResponse {
  translatedText: string
  providerName: string
  detectedSourceLanguage?: string
}

export interface TranslationHistoryEntry {
  sourceText: string
  translatedText: string
  provider: TranslationProvider
  providerName: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  detectedSourceLanguage?: string
  timestamp: number
}

export interface ProviderTableRow {
  provider?: string
  name?: string
  note?: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

const PROVIDER_ALIASES: Record<string, TranslationProvider> = {
  ms: "microsoft",
  microsoft: "microsoft",
  youdao: "youdao",
  yd: "youdao",
  caiyun: "caiyun",
  cy: "caiyun",
  deepl: "deepl",
  openai: "openai",
  claude: "claude",
  anthropic: "claude",
  deepseek: "deepseek",
  custom: "llm_custom",
  llm: "llm_custom",
  llm_custom: "llm_custom",
  openai_compatible: "llm_custom"
}

const MICROSOFT_TRANSLATOR_PRIVATE_KEY = Buffer.from([
  0xa2, 0x29, 0x3a, 0x3d, 0xd0, 0xdd, 0x32, 0x73, 0x97, 0x7a, 0x64, 0xdb, 0xc2, 0xf3, 0x27, 0xf5, 0xd7, 0xbf, 0x87, 0xd9, 0x45, 0x9d, 0xf0, 0x5a, 0x09, 0x66, 0xc6, 0x30, 0xc6, 0x6a, 0xaa, 0x84, 0x9a,
  0x41, 0xaa, 0x94, 0x3a, 0xa8, 0xd5, 0x1a, 0x6e, 0x4d, 0xaa, 0xc9, 0xa3, 0x70, 0x12, 0x35, 0xc7, 0xeb, 0x12, 0xf6, 0xe8, 0x23, 0x07, 0x9e, 0x47, 0x10, 0x95, 0x91, 0x88, 0x55, 0xd8, 0x17
])
const CAIYUN_DEFAULT_TOKEN = "token:qgemv4jr1y38jyq6vhvi"
const CAIYUN_BROWSER_ID = "beba19f9d7f10c74c98334c9e8afcd34"

export const DEFAULT_SETTINGS: PluginSettings = {
  defaultProvider: "microsoft",
  visibleProviders: [],
  providerRows: [],
  defaultSourceLanguage: "auto",
  defaultTargetLanguage: "auto",
  pairLanguage: "auto",
  deeplApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  requestTimeoutMs: 10000,
  showPreviewDetails: true,
  historyLimit: 10
}

export function normalizeProvider(value: string): TranslationProvider {
  if (isTranslationProvider(value)) {
    return value
  }
  return DEFAULT_SETTINGS.defaultProvider
}

function isTranslationProvider(value: string): value is TranslationProvider {
  return (
    value === "microsoft" ||
    value === "youdao" ||
    value === "caiyun" ||
    value === "openai" ||
    value === "claude" ||
    value === "deepseek" ||
    value === "llm_custom" ||
    value === "deepl" ||
    value === "openai_compatible"
  )
}

export const LANGUAGE_CODES: LanguageCode[] = ["auto", "zh", "en", "ja", "ko", "ru", "ar", "fr", "de"]

export function isValidLanguageCode(value: string): value is LanguageCode {
  return LANGUAGE_CODES.includes(value as LanguageCode)
}

export function parseProviderList(value: string): TranslationProvider[] {
  const providers: TranslationProvider[] = []

  let rawValues = value.split(",")
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      rawValues = parsed.filter(item => typeof item === "string")
    }
  } catch {
    // Wox commonly stores multi-select values as a comma separated string.
  }

  for (const rawValue of rawValues) {
    const trimmed = rawValue.trim()
    if (trimmed === "") {
      continue
    }
    if (!isTranslationProvider(trimmed)) {
      continue
    }
    const provider = trimmed
    if (!providers.includes(provider)) {
      providers.push(provider)
    }
  }
  return providers
}

export function parseProviderTableRows(value: string): ProviderTableRow[] {
  if (value.trim() === "") {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return (parsed as ProviderTableRow[]).filter(row => typeof row === "object" && row !== null && typeof row.provider === "string" && isTranslationProvider(row.provider))
  } catch {
    return []
  }
}

export function parseHistoryEntries(value: string): TranslationHistoryEntry[] {
  if (value.trim() === "") {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item): item is TranslationHistoryEntry => {
      if (typeof item !== "object" || item === null) {
        return false
      }
      const candidate = item as Partial<TranslationHistoryEntry>
      return (
        typeof candidate.sourceText === "string" &&
        typeof candidate.translatedText === "string" &&
        typeof candidate.provider === "string" &&
        typeof candidate.providerName === "string" &&
        typeof candidate.sourceLanguage === "string" &&
        typeof candidate.targetLanguage === "string" &&
        typeof candidate.timestamp === "number"
      )
    })
  } catch {
    return []
  }
}

export function historyKeyMatches(entry: TranslationHistoryEntry, provider: TranslationProvider, sourceText: string, direction: LanguageDirection): boolean {
  return entry.provider === provider && entry.sourceText === sourceText && entry.sourceLanguage === direction.sourceLanguage && entry.targetLanguage === direction.targetLanguage
}

function sameHistoryEntry(left: TranslationHistoryEntry, right: TranslationHistoryEntry): boolean {
  return left.provider === right.provider && left.sourceText === right.sourceText && left.sourceLanguage === right.sourceLanguage && left.targetLanguage === right.targetLanguage
}

export function trimHistoryEntries(entries: TranslationHistoryEntry[], historyLimit: number): TranslationHistoryEntry[] {
  return entries.slice(0, Math.max(0, historyLimit))
}

export function upsertHistoryEntry(entries: TranslationHistoryEntry[], entry: TranslationHistoryEntry, historyLimit: number): TranslationHistoryEntry[] {
  const withoutDuplicate = entries.filter(existing => !sameHistoryEntry(existing, entry))
  return trimHistoryEntries(
    [entry, ...withoutDuplicate].sort((left, right) => right.timestamp - left.timestamp),
    historyLimit
  )
}

function normalizeHistorySearchText(text: string): string {
  return text.trim().toLowerCase()
}

export function searchHistoryEntries(entries: TranslationHistoryEntry[], query: string): TranslationHistoryEntry[] {
  const normalizedQuery = normalizeHistorySearchText(query)
  if (normalizedQuery === "") {
    return entries
  }

  return entries.filter(entry => {
    const source = normalizeHistorySearchText(entry.sourceText)
    const translated = normalizeHistorySearchText(entry.translatedText)
    return source.includes(normalizedQuery) || translated.includes(normalizedQuery)
  })
}

export function parseTranslationQuery(search: string, defaultProvider: TranslationProvider): ParsedQuery {
  const trimmed = search.trim()
  if (trimmed === "") {
    return { provider: defaultProvider, text: "", forcedProvider: false }
  }

  const words = trimmed.split(/\s+/)
  let idx = 0
  let provider = defaultProvider
  let forcedProvider = false
  let targetLanguage: LanguageCode | undefined
  let sourceLanguage: LanguageCode | undefined

  // 1. 检查第一个单词是否是翻译源别名
  const first = words[0].toLowerCase()
  const providerAlias = PROVIDER_ALIASES[first]
  if (providerAlias) {
    provider = providerAlias
    forcedProvider = true
    idx++
  }

  // 2. 检查下一个单词是否是语言规格（en:zh / :zh / zh）
  if (idx < words.length) {
    const spec = parseLanguageSpec(words[idx].toLowerCase())
    if (spec) {
      targetLanguage = spec.targetLanguage
      sourceLanguage = spec.sourceLanguage
      idx++
    }
  }

  // 3. 从原始字符串中提取剩余文本（保留换行），而不是 split+join
  let textStart = 0
  for (let i = 0; i < idx; i++) {
    const match = trimmed.slice(textStart).match(/^[^\s]+\s*/)
    if (match) {
      textStart += match[0].length
    }
  }
  const text = trimmed.slice(textStart).trim()

  return { provider, text, forcedProvider, targetLanguage, sourceLanguage }
}

/** 解析语言规格指令，支持格式：zh / :zh / en:zh / auto:zh */
export function parseLanguageSpec(word: string): { targetLanguage?: LanguageCode; sourceLanguage?: LanguageCode } | null {
  // ":zh" — 仅目标语言（冒号开头）
  if (word.startsWith(":") && word.length >= 3 && word.length <= 5) {
    const lang = word.slice(1)
    if (isValidLanguageCode(lang) && lang !== "auto") {
      return { targetLanguage: lang as LanguageCode }
    }
    return null
  }

  // "en:zh" 或 "auto:zh" — 显式 source:target
  const colonParts = word.split(":")
  if (colonParts.length === 2) {
    const left = colonParts[0]
    const right = colonParts[1]
    if (left === "auto" && isValidLanguageCode(right)) {
      return { targetLanguage: right as LanguageCode }
    }
    if (isValidLanguageCode(left) && isValidLanguageCode(right)) {
      return {
        sourceLanguage: left === "auto" ? undefined : (left as LanguageCode),
        targetLanguage: right === "auto" ? undefined : (right as LanguageCode)
      }
    }
    return null
  }

  // "zh" — 裸语言代码（仅 2 字母，排除 "auto"）
  if (/^[a-z]{2}$/.test(word) && isValidLanguageCode(word) && word !== "auto") {
    return { targetLanguage: word as LanguageCode }
  }

  return null
}

type ScriptFamily = "cjk" | "kana" | "hangul" | "cyrillic" | "arabic" | "latin" | null

/** 法语特征字符 */
const FRENCH_SPECIFIC = /[çèêëàâîïôùûœÇÈÊËÀÂÎÏÔÙÛŒ]/

/** 德语特征字符 */
const GERMAN_SPECIFIC = /[ßüöäÜÖÄ]/

function detectScriptFamily(text: string): ScriptFamily {
  let cjk = 0,
    latin = 0,
    cyrillic = 0,
    hangul = 0,
    kana = 0,
    arabic = 0,
    total = 0

  for (const char of text) {
    if (/\s/.test(char)) continue
    const code = char.codePointAt(0)!
    total++
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0xf900 && code <= 0xfaff)) {
      cjk++
    } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      kana++
    } else if (code >= 0xac00 && code <= 0xd7af) {
      hangul++
    } else if (code >= 0x0400 && code <= 0x04ff) {
      cyrillic++
    } else if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f) || (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) {
      arabic++
    } else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) {
      latin++
    }
  }

  if (total === 0) return null
  if (kana > 0 && (kana + cjk) / total > 0.3) return "kana"
  if (hangul / total > 0.3) return "hangul"
  if (cjk / total > 0.3) return "cjk"
  if (arabic / total > 0.3) return "arabic"
  if (cyrillic / total > 0.3) return "cyrillic"
  if (latin / total > 0.5) return "latin"
  return null
}

/** 检测文本的 8 大语言 */
export function detectLanguage(text: string): LanguageCode {
  const script = detectScriptFamily(text)

  if (script === "kana") return "ja"
  if (script === "hangul") return "ko"
  if (script === "cjk") return "zh"
  if (script === "arabic") return "ar"
  if (script === "cyrillic") return "ru"

  if (script === "latin") {
    if (GERMAN_SPECIFIC.test(text)) return "de"
    if (FRENCH_SPECIFIC.test(text)) return "fr"
    return "en"
  }

  return "en"
}

function resolvePairLanguage(woxLanguage: LanguageCode, pairLanguage: LanguageCode): LanguageCode {
  if (pairLanguage !== "auto") {
    return pairLanguage
  }
  return woxLanguage === "zh" ? "en" : "zh"
}

export function resolveLanguageDirection(text: string, sourceLanguage: LanguageCode = "auto", woxLanguage: LanguageCode = "en", pairLanguage: LanguageCode = "auto"): LanguageDirection {
  const detected = detectLanguage(text)
  const source = sourceLanguage === "auto" ? detected : sourceLanguage

  // 智能目标：源 != Wox 界面语言 -> Wox 界面语言；源 == Wox 界面语言 -> 配对语言。
  const target = source === woxLanguage ? resolvePairLanguage(woxLanguage, pairLanguage) : woxLanguage

  return {
    sourceLanguage: sourceLanguage === "auto" ? "auto" : source,
    targetLanguage: target,
    targetLabel: LANGUAGE_LABEL[target] || "English",
    microsoftTarget: LANGUAGE_MICROSOFT[target] || target,
    deeplTarget: LANGUAGE_DEEPL[target] || target.toUpperCase()
  }
}

export function getMissingConfiguration(provider: TranslationProvider, settings: PluginSettings): string | null {
  if (provider === "deepl" && settings.deeplApiKey.trim() === "") {
    return "DeepL API key is required for DeepL translation."
  }
  if (["openai", "claude", "deepseek", "llm_custom", "openai_compatible"].includes(provider) && settings.openaiApiKey.trim() === "") {
    return "API key is required for this large language model provider."
  }
  if (["openai", "claude", "deepseek", "llm_custom", "openai_compatible"].includes(provider) && settings.openaiModel.trim() === "") {
    return "Model is required for this large language model provider."
  }
  return null
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function* readChunksWithTimeout(body: ReadableStream<Uint8Array>, timeoutMs: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout>
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Stream read timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        })
      ]).finally(() => clearTimeout(timer!))
      if (result.done) break
      yield result.value!
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function parseSSEData(data: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function parseOpenAISSEStream(chunks: AsyncGenerator<Uint8Array>, onToken: StreamCallbacks["onToken"], providerName: string): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  let fullText = ""
  const consumeData = async (data: string) => {
    if (!data || data === "[DONE]") return
    const json = parseSSEData(data)
    if (!json) return
    const choices = json.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined
    if (json.error || choices?.[0]?.finish_reason === "error") {
      const error = json.error as { message?: string } | string | undefined
      const message = typeof error === "string" ? error : error?.message || data
      throw new Error(`${providerName} returned an error: ${message}`)
    }
    const token = choices?.[0]?.delta?.content
    if (token) {
      fullText += token
      await onToken(token)
    }
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data:")) continue
      await consumeData(trimmed.slice(5).trim())
    }
  }

  const remaining = buffer.trim()
  if (remaining && remaining.startsWith("data:")) {
    await consumeData(remaining.slice(5).trim())
  }

  if (fullText === "") {
    throw new Error(`${providerName} provider returned an empty translation.`)
  }

  return fullText
}

async function parseClaudeSSEStream(chunks: AsyncGenerator<Uint8Array>, onToken: StreamCallbacks["onToken"]): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  let fullText = ""
  let errorText: string | null = null

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    const events = buffer.split("\n\n")
    buffer = events.pop() || ""

    for (const event of events) {
      let dataLine = ""

      for (const line of event.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.startsWith("data:")) {
          dataLine = trimmed.slice(5).trim()
        }
      }

      if (!dataLine) continue

      const json = parseSSEData(dataLine)
      if (json) {
        const type = json.type as string | undefined

        if (type === "content_block_delta") {
          const delta = json.delta as { type?: string; text?: string } | undefined
          if (delta?.type === "text_delta" && delta.text) {
            fullText += delta.text
            await onToken(delta.text)
          }
        } else if (type === "error") {
          const err = json.error as { message?: string } | undefined
          errorText = err?.message || dataLine
        }
      }
    }
  }

  // process trailing partial event
  const trimmedRemaining = buffer.trim()
  if (trimmedRemaining) {
    for (const line of trimmedRemaining.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("data:")) {
        const dataLine = trimmed.slice(5).trim()
        if (dataLine) {
          const json = parseSSEData(dataLine)
          if (json) {
            const delta = (json as { delta?: { type?: string; text?: string } }).delta
            if (delta?.type === "text_delta" && delta.text) {
              fullText += delta.text
              await onToken(delta.text)
            }
          }
        }
      }
    }
  }

  if (errorText) {
    throw new Error(`Claude provider returned an error: ${errorText}`)
  }
  if (fullText === "") {
    throw new Error("Claude provider returned an empty translation.")
  }

  return fullText
}

export interface StreamCallbacks {
  onToken: (token: string) => void | Promise<void>
  onComplete: (fullText: string) => void | Promise<void>
  onError: (error: Error) => void | Promise<void>
}

export async function translateWithOpenAICompatibleStream(request: TranslationRequest, providerName: string, callbacks: StreamCallbacks): Promise<void> {
  try {
    const baseUrl = request.settings.openaiBaseUrl.replace(/\/+$/, "")
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.settings.openaiApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: request.settings.openaiModel,
          messages: buildTranslationPrompt(request.text, request.direction.targetLabel).map(conversation => ({
            role: conversation.Role,
            content: conversation.Text
          })),
          temperature: 0.1,
          stream: true
        })
      },
      request.settings.requestTimeoutMs
    )

    if (!response.ok || !response.body) {
      const bodyText = response.ok ? "" : await response.text().catch(() => "")
      throw new Error(`${providerName} request failed with ${response.status}: ${bodyText}`)
    }

    const chunks = readChunksWithTimeout(response.body, request.settings.requestTimeoutMs)
    const fullText = await parseOpenAISSEStream(chunks, callbacks.onToken, providerName)
    await callbacks.onComplete(fullText)
  } catch (error) {
    await callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function translateWithClaudeStream(request: TranslationRequest, callbacks: StreamCallbacks): Promise<void> {
  try {
    const baseUrl = request.settings.openaiBaseUrl.replace(/\/+$/, "")
    const conversations = buildTranslationPrompt(request.text, request.direction.targetLabel)
    const response = await fetchWithTimeout(
      `${baseUrl}/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": request.settings.openaiApiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: request.settings.openaiModel,
          system: conversations[0].Text,
          messages: [{ role: "user", content: conversations[1].Text }],
          max_tokens: 2048,
          temperature: 0.1,
          stream: true
        })
      },
      request.settings.requestTimeoutMs
    )

    if (!response.ok || !response.body) {
      const bodyText = response.ok ? "" : await response.text().catch(() => "")
      throw new Error(`Claude request failed with ${response.status}: ${bodyText}`)
    }

    const chunks = readChunksWithTimeout(response.body, request.settings.requestTimeoutMs)
    const fullText = await parseClaudeSSEStream(chunks, callbacks.onToken)
    await callbacks.onComplete(fullText)
  } catch (error) {
    await callbacks.onError(error instanceof Error ? error : new Error(String(error)))
  }
}

async function parseJsonResponse(response: Response, providerName: string): Promise<unknown> {
  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(`${providerName} request failed with ${response.status}: ${bodyText}`)
  }
  try {
    return JSON.parse(bodyText) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${providerName} returned invalid JSON: ${message}`)
  }
}

function requireString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(errorMessage)
  }
  return value
}

function strictUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function microsoftSignature(url: string): string {
  const guid = randomUUID().replace(/-/g, "")
  const escapedUrl = strictUriEncode(url)
  const dateTime = new Date().toUTCString()
  const bytes = `MSTranslatorAndroidApp${escapedUrl}${dateTime}${guid}`.toLowerCase()
  const signature = createHmac("sha256", MICROSOFT_TRANSLATOR_PRIVATE_KEY).update(bytes, "utf8").digest("base64")
  return `MSTranslatorAndroidApp::${signature}::${dateTime}::${guid}`
}

async function requestMicrosoftTranslation(request: TranslationRequest): Promise<Response> {
  let url = `api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(request.direction.microsoftTarget)}`
  if (request.direction.sourceLanguage !== "auto") {
    url += `&from=${encodeURIComponent(LANGUAGE_MICROSOFT[request.direction.sourceLanguage] || request.direction.sourceLanguage)}`
  }

  return fetchWithTimeout(
    `https://${url}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MT-Signature": microsoftSignature(url)
      },
      body: JSON.stringify([{ Text: request.text }])
    },
    request.settings.requestTimeoutMs
  )
}

export async function translateWithMicrosoft(request: TranslationRequest): Promise<TranslationResponse> {
  const response = await requestMicrosoftTranslation(request)
  const json = (await parseJsonResponse(response, "Microsoft")) as Array<{
    detectedLanguage?: { language?: string }
    translations?: Array<{ text?: string }>
  }>
  const translatedText = requireString(json[0]?.translations?.[0]?.text, "Microsoft returned an empty translation.")

  return {
    translatedText,
    providerName: "Microsoft",
    detectedSourceLanguage: json[0]?.detectedLanguage?.language
  }
}

export async function translateWithDeepL(request: TranslationRequest): Promise<TranslationResponse> {
  const endpoint = "https://api-free.deepl.com/v2/translate"
  const body: Record<string, unknown> = {
    text: [request.text],
    target_lang: request.direction.deeplTarget
  }
  if (request.direction.sourceLanguage !== "auto") {
    body.source_lang = request.direction.sourceLanguage.toUpperCase()
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${request.settings.deeplApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "DeepL")) as {
    translations?: Array<{ detected_source_language?: string; text?: string }>
  }
  const translatedText = requireString(json.translations?.[0]?.text, "DeepL returned an empty translation.")

  return {
    translatedText,
    providerName: "DeepL",
    detectedSourceLanguage: json.translations?.[0]?.detected_source_language
  }
}

export async function translateWithYoudao(request: TranslationRequest): Promise<TranslationResponse> {
  const mysticTime = String(Date.now())
  const client = "deskdict"
  const product = "deskdict"
  const sign = createHash("md5").update(`client=${client}&mysticTime=${mysticTime}&product=${product}&key=cybibtzhdwayqjmrncst`, "utf8").digest("hex")
  const from = request.direction.sourceLanguage === "auto" ? "auto" : request.direction.sourceLanguage === "zh" ? "zh-CHS" : request.direction.sourceLanguage
  const to = request.direction.targetLanguage === "zh" ? "zh-CHS" : request.direction.targetLanguage
  const body = new URLSearchParams({ i: request.text })
  const params = new URLSearchParams({
    keyfrom: "deskdict.main",
    client,
    from,
    to,
    keyid: "deskdict",
    mysticTime,
    pointParam: "client,product,mysticTime",
    sign,
    domain: "0",
    useTerm: "false",
    noCheckPrivate: "false",
    recTerms: "[]",
    id: "0a464aedddbc6e4b9",
    vendor: "fanyiweb_navigation",
    in: "YoudaoDict_fanyiweb_navigation",
    appVer: "11.2.0.0",
    appZengqiang: "0",
    abTest: "0",
    model: "LENOVO",
    screen: "1920*1080",
    OsVersion: "10.0.19045",
    network: "none",
    mid: "windows10.0.19045",
    appVersion: "11.2.0.0",
    product,
    source: "mine_transtab_realtime"
  })
  const response = await fetchWithTimeout(
    `https://dict.youdao.com/dicttranslate?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Youdao Desktop Dict (Windows NT 10.0)",
        Cookie: "DESKDICT_VENDOR=unknown"
      },
      body: body.toString()
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Youdao")) as {
    translateResult?: Array<Array<{ tgt?: string }>>
  }
  const translatedText = requireString(
    json.translateResult
      ?.map(row => row.map(item => item.tgt || "").join(""))
      .join("")
      .trim(),
    "Youdao returned an empty translation."
  )

  return {
    translatedText,
    providerName: "Youdao"
  }
}

function caiyunTranslationType(direction: LanguageDirection): string {
  // 彩云只支持中英双向
  if (direction.sourceLanguage === "zh") return "zh2en"
  if (direction.sourceLanguage === "en") return "en2zh"
  return direction.targetLanguage === "zh" ? "auto2zh" : "auto2en"
}

function caiyunCrypt(ifDecrypt = true): Record<string, string> {
  const normalKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=.+-_/"
  const cipherKey = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm0123456789=.+-_/"
  const source = ifDecrypt ? cipherKey : normalKey
  const target = ifDecrypt ? normalKey : cipherKey
  const map: Record<string, string> = {}
  for (let i = 0; i < source.length; i++) {
    map[source[i]] = target[i]
  }
  return map
}

function caiyunDecrypt(cipherText: string): string {
  const map = caiyunCrypt(true)
  const normalized = cipherText
    .split("")
    .map(char => map[char] ?? char)
    .join("")
  return Buffer.from(normalized, "base64").toString("utf8")
}

const CAIYUN_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "App-Name": "xy",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "Device-Id": "",
  Origin: "https://fanyi.caiyunapp.com",
  "Os-Type": "web",
  "Os-Version": "",
  Pragma: "no-cache",
  Referer: "https://fanyi.caiyunapp.com/",
  "X-Authorization": CAIYUN_DEFAULT_TOKEN
}

async function getCaiyunJwt(request: TranslationRequest): Promise<string> {
  const body = JSON.stringify({ browser_id: CAIYUN_BROWSER_ID })
  await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/user/jwt/generate",
    {
      method: "OPTIONS",
      headers: CAIYUN_HEADERS,
      body
    },
    request.settings.requestTimeoutMs
  )
  const response = await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/user/jwt/generate",
    {
      method: "POST",
      headers: CAIYUN_HEADERS,
      body
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Caiyun JWT")) as { jwt?: string }
  return requireString(json.jwt, "Caiyun returned an empty JWT.")
}

export async function translateWithCaiyun(request: TranslationRequest): Promise<TranslationResponse> {
  if (!["zh", "en"].includes(request.direction.targetLanguage)) {
    throw new Error("Caiyun only supports Chinese and English target languages.")
  }

  const transType = caiyunTranslationType(request.direction)
  const jwt = await getCaiyunJwt(request)
  const headers = {
    ...CAIYUN_HEADERS,
    "T-Authorization": jwt
  }
  const body = JSON.stringify({
    source: request.text,
    trans_type: transType,
    request_id: "web_fanyi",
    media: "text",
    os_type: "web",
    dict: true,
    cached: true,
    replaced: true,
    detect: true,
    browser_id: CAIYUN_BROWSER_ID
  })
  await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/translator",
    {
      method: "OPTIONS",
      headers,
      body
    },
    request.settings.requestTimeoutMs
  )
  const response = await fetchWithTimeout(
    "https://api.interpreter.caiyunai.com/v1/translator",
    {
      method: "POST",
      headers,
      body
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Caiyun")) as {
    target?: string
    rc?: number
  }
  const translatedText = requireString(json.target ? caiyunDecrypt(json.target) : "", "Caiyun returned an empty translation.")

  return {
    translatedText,
    providerName: "Caiyun"
  }
}

interface TranslationPromptMessage {
  Role: "system" | "user"
  Text: string
  Timestamp: number
}

function buildTranslationPrompt(text: string, targetLabel: string): TranslationPromptMessage[] {
  const now = Date.now()
  return [
    {
      Role: "system",
      Text: `Translate the user's text into ${targetLabel}. Return only the translation. Preserve code blocks, URLs, numbers, proper nouns, and the original line breaks and paragraph structure when appropriate. Multiple consecutive blank lines in the source should become a single line break in the translation. Do not add explanations.`,
      Timestamp: now
    },
    {
      Role: "user",
      Text: text,
      Timestamp: now
    }
  ]
}

export function collapseExtraBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n")
}

export async function translateWithOpenAICompatible(request: TranslationRequest, providerName = "OpenAI compatible"): Promise<TranslationResponse> {
  const baseUrl = request.settings.openaiBaseUrl.replace(/\/+$/, "")
  const response = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.settings.openaiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: request.settings.openaiModel,
        messages: buildTranslationPrompt(request.text, request.direction.targetLabel).map(conversation => ({
          role: conversation.Role,
          content: conversation.Text
        })),
        temperature: 0.1
      })
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, providerName)) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const translatedText = requireString(json.choices?.[0]?.message?.content, `${providerName} provider returned an empty translation.`)

  return {
    translatedText,
    providerName
  }
}

export async function translateWithClaude(request: TranslationRequest): Promise<TranslationResponse> {
  const baseUrl = request.settings.openaiBaseUrl.replace(/\/+$/, "")
  const conversations = buildTranslationPrompt(request.text, request.direction.targetLabel)
  const response = await fetchWithTimeout(
    `${baseUrl}/messages`,
    {
      method: "POST",
      headers: {
        "x-api-key": request.settings.openaiApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: request.settings.openaiModel,
        system: conversations[0].Text,
        messages: [{ role: "user", content: conversations[1].Text }],
        max_tokens: 2048,
        temperature: 0.1
      })
    },
    request.settings.requestTimeoutMs
  )
  const json = (await parseJsonResponse(response, "Claude")) as {
    content?: Array<{ type?: string; text?: string }>
  }
  const translatedText = requireString(
    json.content
      ?.filter(item => item.type === "text" && typeof item.text === "string")
      .map(item => item.text)
      .join("")
      .trim(),
    "Claude provider returned an empty translation."
  )

  return {
    translatedText,
    providerName: "Claude"
  }
}

export async function translateText(provider: TranslationProvider, request: TranslationRequest): Promise<TranslationResponse> {
  if (provider === "microsoft") {
    return translateWithMicrosoft(request)
  }
  if (provider === "youdao") {
    return translateWithYoudao(request)
  }
  if (provider === "caiyun") {
    return translateWithCaiyun(request)
  }
  if (provider === "deepl") {
    return translateWithDeepL(request)
  }
  if (provider === "claude") {
    return translateWithClaude(request)
  }
  if (provider === "openai") {
    return translateWithOpenAICompatible(request, "OpenAI")
  }
  if (provider === "deepseek") {
    return translateWithOpenAICompatible(request, "DeepSeek")
  }
  return translateWithOpenAICompatible(request)
}
