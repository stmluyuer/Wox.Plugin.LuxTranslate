import { ActionContext, Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import {
  collapseExtraBlankLines,
  DEFAULT_SETTINGS,
  getMissingConfiguration,
  historyKeyMatches,
  LanguageDirection,
  normalizeProvider,
  parseHistoryEntries,
  parseProviderList,
  parseProviderTableRows,
  parseTranslationQuery,
  PluginSettings,
  resolveLanguageDirection,
  searchHistoryEntries,
  StreamCallbacks,
  translateText,
  translateWithClaudeStream,
  translateWithOpenAICompatibleStream,
  TranslationHistoryEntry,
  TranslationProvider,
  upsertHistoryEntry,
  LanguageCode
} from "./translate"

let api: PublicAPI
let woxLanguage: LanguageCode = "en"

const HISTORY_SETTING_KEY = "translation_history"

const PLUGIN_ICON: WoxImage = {
  ImageType: "relative",
  ImageData: "images/app.svg"
}

async function getSetting(ctx: Context, key: string, fallback: string): Promise<string> {
  try {
    const value = await api.GetSetting(ctx, key)
    return value.trim() === "" ? fallback : value.trim()
  } catch {
    return fallback
  }
}

async function loadSettings(ctx: Context): Promise<PluginSettings> {
  const timeoutRaw = await getSetting(ctx, "request_timeout_ms", String(DEFAULT_SETTINGS.requestTimeoutMs))
  const timeoutMs = Number.parseInt(timeoutRaw, 10)
  const historyLimitRaw = await getSetting(ctx, "history_limit", String(DEFAULT_SETTINGS.historyLimit))
  const historyLimit = Number.parseInt(historyLimitRaw, 10)
  const showPreviewDetails = (await getSetting(ctx, "show_preview_details", String(DEFAULT_SETTINGS.showPreviewDetails))) === "true"
  const noSetupProviderTableValue = await getSetting(ctx, "no_setup_provider_table", "")
  const llmProviderTableValue = await getSetting(ctx, "llm_provider_table", "")
  const visibleProviders = parseProviderList(await getSetting(ctx, "visible_providers", DEFAULT_SETTINGS.visibleProviders.join(",")))

  const targetLanguageRaw = await getSetting(ctx, "default_target_language", DEFAULT_SETTINGS.defaultTargetLanguage || "auto")
  const pairLanguageRaw = await getSetting(ctx, "pair_language", DEFAULT_SETTINGS.pairLanguage || "auto")

  return {
    defaultProvider: normalizeProvider(await getSetting(ctx, "default_provider", DEFAULT_SETTINGS.defaultProvider)),
    visibleProviders,
    providerRows: [...parseProviderTableRows(noSetupProviderTableValue), ...parseProviderTableRows(llmProviderTableValue)],
    defaultSourceLanguage: (await getSetting(ctx, "default_source_language", DEFAULT_SETTINGS.defaultSourceLanguage)) as LanguageCode,
    defaultTargetLanguage: normalizeLanguageCode(targetLanguageRaw) as LanguageCode,
    pairLanguage: normalizeLanguageCode(pairLanguageRaw) as LanguageCode,
    woxLanguage,
    deeplApiKey: await getSetting(ctx, "deepl_api_key", DEFAULT_SETTINGS.deeplApiKey),
    openaiBaseUrl: await getSetting(ctx, "openai_base_url", DEFAULT_SETTINGS.openaiBaseUrl),
    openaiApiKey: await getSetting(ctx, "openai_api_key", DEFAULT_SETTINGS.openaiApiKey),
    openaiModel: await getSetting(ctx, "openai_model", DEFAULT_SETTINGS.openaiModel),
    requestTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SETTINGS.requestTimeoutMs,
    showPreviewDetails,
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? historyLimit : DEFAULT_SETTINGS.historyLimit
  }
}

function settingsForProvider(settings: PluginSettings, provider: TranslationProvider): PluginSettings {
  const row = settings.providerRows.find(item => item.provider === provider)
  const providerDefaults: Partial<Pick<PluginSettings, "openaiBaseUrl" | "openaiModel">> = {
    openaiBaseUrl:
      provider === "openai" ? "https://api.openai.com/v1" : provider === "deepseek" ? "https://api.deepseek.com/v1" : provider === "claude" ? "https://api.anthropic.com/v1" : settings.openaiBaseUrl,
    openaiModel: provider === "openai" ? "gpt-4o-mini" : provider === "deepseek" ? "deepseek-chat" : provider === "claude" ? "claude-3-5-haiku-latest" : settings.openaiModel
  }

  if (!row) {
    return { ...settings, ...providerDefaults }
  }

  return {
    ...settings,
    ...providerDefaults,
    openaiBaseUrl: row.baseUrl?.trim() || providerDefaults.openaiBaseUrl || settings.openaiBaseUrl,
    openaiApiKey: row.apiKey?.trim() || settings.openaiApiKey,
    openaiModel: row.model?.trim() || providerDefaults.openaiModel || settings.openaiModel
  }
}

const VALID_LANGUAGE_CODES = ["auto", "zh", "en", "ja", "ko", "ru", "ar", "fr", "de"]

function normalizeLanguageCode(value: string): LanguageCode {
  if (VALID_LANGUAGE_CODES.includes(value)) {
    return value as LanguageCode
  }
  return "auto"
}

function normalizeWoxLanguageProbe(value: string): LanguageCode {
  const normalized = value.trim().toLowerCase().replace("-", "_")
  if (normalized.startsWith("zh")) return "zh"
  if (normalized.startsWith("ja")) return "ja"
  if (normalized.startsWith("ko")) return "ko"
  if (normalized.startsWith("ru")) return "ru"
  if (normalized.startsWith("ar")) return "ar"
  if (normalized.startsWith("fr")) return "fr"
  if (normalized.startsWith("de")) return "de"
  return "en"
}

function providerCommand(provider: TranslationProvider): string {
  if (provider === "microsoft") return "ms"
  if (provider === "youdao") return "youdao"
  if (provider === "caiyun") return "caiyun"
  if (provider === "deepl") return "deepl"
  if (provider === "openai") return "openai"
  if (provider === "claude") return "claude"
  if (provider === "deepseek") return "deepseek"
  if (provider === "llm_custom" || provider === "openai_compatible") return "custom"
  return "ms"
}

function providerDisplayName(provider: TranslationProvider): string {
  if (provider === "microsoft") return "Microsoft"
  if (provider === "youdao") return "Youdao"
  if (provider === "caiyun") return "Caiyun"
  if (provider === "deepl") return "DeepL"
  if (provider === "openai") return "OpenAI"
  if (provider === "claude") return "Claude"
  if (provider === "deepseek") return "DeepSeek"
  return "Custom LLM"
}

async function t(ctx: Context, key: string): Promise<string> {
  try {
    const value = await api.GetTranslation(ctx, key)
    return value.trim() === "" ? key : value
  } catch {
    return key
  }
}

function desc(text: string): string {
  return text.replace(/^`[^`]+`\s*/, "")
}

async function buildHelpResult(ctx: Context): Promise<Result> {
  const cmd = await t(ctx, "help_preview_command")
  const dsc = await t(ctx, "help_preview_description")
  return {
    Title: await t(ctx, "help_title"),
    SubTitle: await t(ctx, "help_subtitle"),
    Icon: PLUGIN_ICON,
    Score: 100,
    Preview: {
      PreviewType: "markdown",
      PreviewData: [
        `# ${await t(ctx, "plugin_name")}`,
        "",
        `| ${cmd} | ${dsc} |`,
        "| --- | --- |",
        `| tr hello | ${desc(await t(ctx, "help_default_provider"))} |`,
        `| tr ms hello | ${desc(await t(ctx, "help_microsoft"))} |`,
        `| tr youdao hello | ${desc(await t(ctx, "help_youdao"))} |`,
        `| tr caiyun hello | ${desc(await t(ctx, "help_caiyun"))} |`,
        `| tr openai hello | ${desc(await t(ctx, "help_openai"))} |`,
        `| tr claude hello | ${desc(await t(ctx, "help_claude"))} |`,
        `| tr deepseek hello | ${desc(await t(ctx, "help_deepseek"))} |`,
        `| tr custom hello | ${desc(await t(ctx, "help_custom_llm"))} |`,
        `| tr history | ${desc(await t(ctx, "help_history"))} |`,
        `| tr history hello | ${desc(await t(ctx, "help_history_search"))} |`,
        "",
        `### ${await t(ctx, "preview_direction")}`,
        "",
        `| ${cmd} | ${dsc} |`,
        "| --- | --- |",
        `| tr zh hello | ${desc(await t(ctx, "help_lang_target"))} |`,
        `| tr en:zh hello | ${desc(await t(ctx, "help_lang_source_target"))} |`,
        `| tr :zh hello | ${desc(await t(ctx, "help_lang_colon_target"))} |`,
        `| tr ms zh hello | ${desc(await t(ctx, "help_provider_lang"))} |`,
        `| tr ms en:zh hello | ${desc(await t(ctx, "help_provider_source_target"))} |`
      ].join("\n"),
      PreviewProperties: {}
    }
  }
}

async function loadHistory(ctx: Context): Promise<TranslationHistoryEntry[]> {
  return parseHistoryEntries(await getSetting(ctx, HISTORY_SETTING_KEY, "[]"))
}

async function saveHistory(ctx: Context, entries: TranslationHistoryEntry[]): Promise<void> {
  await api.SaveSetting(ctx, HISTORY_SETTING_KEY, JSON.stringify(entries), false)
}

function buildConfigurationResult(message: string, provider: TranslationProvider): Result {
  const title = `${providerDisplayName(provider)} needs configuration`
  return {
    Title: title,
    SubTitle: message,
    Icon: PLUGIN_ICON,
    Score: 100,
    Preview: {
      PreviewType: "markdown",
      PreviewData: `# Configuration required\n\n${message}\n\nOpen Wox plugin settings and update LuxTranslate.`,
      PreviewProperties: {}
    }
  }
}

function errorMessageForProvider(error: unknown, provider: TranslationProvider): string {
  const message = error instanceof Error ? error.message : String(error)
  const suffix = provider === "microsoft" ? " The Microsoft no-setup provider uses an unofficial endpoint and may stop working." : ""
  return `${message}${suffix}`
}

async function buildResultActions(ctx: Context, translatedText: string, sourceText: string, provider: TranslationProvider): Promise<Result["Actions"]> {
  const actions: Result["Actions"] = [
    {
      Name: await t(ctx, "action_copy_translation"),
      IsDefault: true,
      Action: async (ctx: Context) => {
        await api.Copy(ctx, { type: "text", text: translatedText })
      }
    },
    {
      Name: await t(ctx, "action_copy_source"),
      Action: async (ctx: Context) => {
        await api.Copy(ctx, { type: "text", text: sourceText })
      }
    }
  ]

  for (const alternate of ["microsoft", "youdao", "caiyun", "openai", "claude", "deepseek", "llm_custom"] as TranslationProvider[]) {
    if (alternate === provider) {
      continue
    }
    actions.push({
      Name: `${await t(ctx, "action_retry_with")} ${providerDisplayName(alternate)}`,
      ContextData: { provider: alternate },
      Action: async (ctx: Context, actionContext: ActionContext) => {
        const nextProvider = (actionContext.ContextData.provider || alternate) as TranslationProvider
        await api.ChangeQuery(ctx, {
          QueryType: "input",
          QueryText: `tr ${providerCommand(nextProvider)} ${sourceText}`
        })
      }
    })
  }

  return actions
}

async function buildTranslationPreview(ctx: Context, translatedText: string, sourceText: string, providerName: string, direction: string, showDetails: boolean): Promise<string> {
  const text = collapseExtraBlankLines(translatedText)
  if (!showDetails) {
    return text
  }

  return [
    text,
    "",
    "---",
    "",
    `## ${await t(ctx, "preview_source")}`,
    sourceText,
    "",
    `## ${await t(ctx, "preview_details")}`,
    `- ${await t(ctx, "preview_provider")}: ${providerName}`,
    `- ${await t(ctx, "preview_direction")}: ${direction}`
  ].join("\n")
}

async function translateProviderResult(
  ctx: Context,
  provider: TranslationProvider,
  sourceText: string,
  settings: PluginSettings,
  score: number,
  includeProviderInTitle: boolean,
  languageOverrides?: { sourceLanguage?: LanguageCode; targetLanguage?: LanguageCode }
): Promise<Result> {
  const providerSettings = settingsForProvider(settings, provider)
  const missingConfiguration = getMissingConfiguration(provider, providerSettings)
  if (missingConfiguration) {
    return buildConfigurationResult(missingConfiguration, provider)
  }

  // 用户通过 tr 指令指定的语言覆盖优先，否则走设置项
  const effectiveSource = languageOverrides?.sourceLanguage || providerSettings.defaultSourceLanguage
  const effectiveTarget = languageOverrides?.targetLanguage || (providerSettings.defaultTargetLanguage === "auto" ? providerSettings.woxLanguage || "en" : providerSettings.defaultTargetLanguage)
  const forceFixedTarget = Boolean(languageOverrides?.targetLanguage) || providerSettings.defaultTargetLanguage !== "auto"
  const pair = forceFixedTarget ? effectiveTarget : providerSettings.pairLanguage || "auto"

  const direction = resolveLanguageDirection(sourceText, effectiveSource, effectiveTarget, pair)
  const history = await loadHistory(ctx)
  const historyEntry = history.find(entry => historyKeyMatches(entry, provider, sourceText, direction))
  if (historyEntry) {
    return buildTranslationResult(ctx, historyEntry, sourceText, providerSettings, score, includeProviderInTitle, true)
  }

  if (["openai", "deepseek", "claude", "llm_custom", "openai_compatible"].includes(provider)) {
    const resultId = `lux-tr-${provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    startStreamingTranslation(ctx, provider, sourceText, direction, providerSettings, resultId, history)
    return {
      Id: resultId,
      Title: await t(ctx, "translating_title"),
      SubTitle: `${await t(ctx, "subtitle_source")}: ${sourceText} | ${direction.sourceLanguage} → ${direction.targetLanguage}`,
      Icon: PLUGIN_ICON,
      Score: score,
      Tails: [{ Type: "text", Text: providerDisplayName(provider) }],
      Actions: []
    }
  }

  try {
    const translation = await translateText(provider, {
      text: sourceText,
      direction,
      settings: providerSettings
    })
    const entry: TranslationHistoryEntry = {
      sourceText,
      translatedText: translation.translatedText,
      provider,
      providerName: translation.providerName,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      detectedSourceLanguage: translation.detectedSourceLanguage,
      timestamp: Date.now()
    }
    await saveHistory(ctx, upsertHistoryEntry(history, entry, providerSettings.historyLimit))
    return buildTranslationResult(ctx, entry, sourceText, providerSettings, score, includeProviderInTitle, false)
  } catch (error) {
    await api.Log(ctx, "Error", error instanceof Error ? error.stack || error.message : String(error))
    return {
      Title: `${providerDisplayName(provider)}: Translation failed`,
      SubTitle: errorMessageForProvider(error, provider),
      Icon: PLUGIN_ICON,
      Score: score,
      Preview: {
        PreviewType: "markdown",
        PreviewData: `# ${providerDisplayName(provider)} translation failed\n\n${errorMessageForProvider(error, provider)}`,
        PreviewProperties: {}
      }
    }
  }
}

async function startStreamingTranslation(
  ctx: Context,
  provider: TranslationProvider,
  sourceText: string,
  direction: LanguageDirection,
  providerSettings: PluginSettings,
  resultId: string,
  history: TranslationHistoryEntry[]
): Promise<void> {
  const pName = providerDisplayName(provider)
  let accumulatedText = ""
  let lastUpdateTime = 0
  const UPDATE_INTERVAL_MS = 80

  const updateResult = async (text: string, isFinal: boolean) => {
    const now = Date.now()
    if (!isFinal && now - lastUpdateTime < UPDATE_INTERVAL_MS) return true
    lastUpdateTime = now

    const sanitized = collapseExtraBlankLines(text)
    const ok = await api.UpdateResult(ctx, {
      Id: resultId,
      Title: await t(ctx, "translating_title"),
      Preview: providerSettings.showPreviewDetails
        ? {
            PreviewType: "markdown",
            PreviewData: [
              sanitized,
              "",
              "---",
              "",
              `## ${await t(ctx, "preview_source")}`,
              sourceText,
              "",
              `## ${await t(ctx, "preview_details")}`,
              `- ${await t(ctx, "preview_provider")}: ${pName}`,
              `- ${await t(ctx, "preview_direction")}: ${direction.sourceLanguage} → ${direction.targetLanguage}`
            ].join("\n"),
            PreviewProperties: {}
          }
        : { PreviewType: "markdown", PreviewData: sanitized, PreviewProperties: {} }
    })
    return ok
  }

  const onToken = async (token: string) => {
    accumulatedText += token
    const ok = await updateResult(accumulatedText, false)
    if (!ok) {
      throw new Error("Stream cancelled: result no longer visible")
    }
  }

  const onComplete = async (fullText: string) => {
    accumulatedText = fullText
    await updateResult(fullText, true)

    const entry: TranslationHistoryEntry = {
      sourceText,
      translatedText: fullText,
      provider,
      providerName: pName,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      timestamp: Date.now()
    }
    await saveHistory(ctx, upsertHistoryEntry(history, entry, providerSettings.historyLimit))

    const sanitized = collapseExtraBlankLines(fullText)
    const actions = await buildResultActions(ctx, fullText, sourceText, provider)
    const preview = providerSettings.showPreviewDetails
      ? [
          sanitized,
          "",
          "---",
          "",
          `## ${await t(ctx, "preview_source")}`,
          sourceText,
          "",
          `## ${await t(ctx, "preview_details")}`,
          `- ${await t(ctx, "preview_provider")}: ${pName}`,
          `- ${await t(ctx, "preview_direction")}: ${direction.sourceLanguage} → ${direction.targetLanguage}`
        ].join("\n")
      : sanitized

    await api.UpdateResult(ctx, {
      Id: resultId,
      Title: await t(ctx, "translation_done_title"),
      SubTitle: `${await t(ctx, "subtitle_source")}: ${sourceText} | ${direction.sourceLanguage} → ${direction.targetLanguage} | ${await t(ctx, "subtitle_enter_to_copy")}`,
      Preview: { PreviewType: "markdown", PreviewData: preview, PreviewProperties: {} },
      Actions: actions,
      Tails: [{ Type: "text", Text: pName }]
    })
  }

  const onError = async (error: Error) => {
    await api.Log(ctx, "Error", error.stack || error.message)
    await api.UpdateResult(ctx, {
      Id: resultId,
      Title: `${pName}: Translation failed`,
      SubTitle: errorMessageForProvider(error, provider)
    })
  }

  const callbacks: StreamCallbacks = {
    onToken,
    onComplete,
    onError
  }

  const request = {
    text: sourceText,
    direction,
    settings: providerSettings
  }

  try {
    if (provider === "claude") {
      await translateWithClaudeStream(request, callbacks)
    } else {
      const name = provider === "openai" ? "OpenAI" : provider === "deepseek" ? "DeepSeek" : "OpenAI compatible"
      await translateWithOpenAICompatibleStream(request, name, callbacks)
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    await onError(err)
  }
}

async function buildTranslationResult(
  ctx: Context,
  entry: TranslationHistoryEntry,
  sourceText: string,
  settings: PluginSettings,
  score: number,
  includeProviderInTitle: boolean,
  fromHistory: boolean
): Promise<Result> {
  const subtitleParts = [`${await t(ctx, "subtitle_source")}: ${sourceText}`, `${entry.sourceLanguage} -> ${entry.targetLanguage}`, await t(ctx, "subtitle_enter_to_copy")]
  if (entry.detectedSourceLanguage) {
    subtitleParts.splice(1, 0, `${await t(ctx, "subtitle_detected")} ${entry.detectedSourceLanguage}`)
  }
  if (fromHistory) {
    subtitleParts.splice(1, 0, await t(ctx, "subtitle_history"))
  }

  return {
    Title: await t(ctx, "translation_done_title"),
    SubTitle: subtitleParts.join(" | "),
    Icon: PLUGIN_ICON,
    Score: score,
    Preview: {
      PreviewType: "markdown",
      PreviewData: await buildTranslationPreview(ctx, entry.translatedText, sourceText, entry.providerName, `${entry.sourceLanguage} -> ${entry.targetLanguage}`, settings.showPreviewDetails),
      PreviewProperties: {}
    },
    Tails: [
      {
        Type: "text",
        Text: fromHistory ? await t(ctx, "subtitle_history") : providerDisplayName(entry.provider)
      }
    ],
    Actions: await buildResultActions(ctx, entry.translatedText, sourceText, entry.provider)
  }
}

async function buildHistoryResults(ctx: Context, searchText: string, settings: PluginSettings): Promise<Result[]> {
  const entries = searchHistoryEntries(await loadHistory(ctx), searchText)
  if (entries.length === 0) {
    return [
      {
        Title: await t(ctx, "history_empty_title"),
        SubTitle: searchText.trim() === "" ? await t(ctx, "history_empty_subtitle") : `${await t(ctx, "history_no_match")}: ${searchText}`,
        Icon: PLUGIN_ICON,
        Score: 100
      }
    ]
  }

  return Promise.all(entries.map((entry, index) => buildTranslationResult(ctx, entry, entry.sourceText, settings, 100 - index, true, true)))
}

function parseHistoryQuery(search: string): string | null {
  const trimmed = search.trim()
  const match = /^(history|his)(?:\s+(.*))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return match[2]?.trim() ?? ""
}

export const plugin: Plugin = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    // Detect Wox's selected UI language through plugin i18n.
    try {
      woxLanguage = normalizeWoxLanguageProbe(await api.GetTranslation(ctx, "language_probe"))
    } catch {
      woxLanguage = "en"
    }
    await api.Log(ctx, "Info", `LuxTranslate initialized, Wox language: ${woxLanguage}`)
  },

  query: async (ctx: Context, query: Query): Promise<Result[]> => {
    const search = query.Type === "selection" ? query.Selection.Text : query.Search
    const settings = await loadSettings(ctx)
    const historySearch = parseHistoryQuery(search)
    if (historySearch !== null) {
      return buildHistoryResults(ctx, historySearch, settings)
    }
    const parsed = parseTranslationQuery(search, settings.defaultProvider)

    if (parsed.text === "") {
      return [await buildHelpResult(ctx)]
    }

    const providers = parsed.forcedProvider || settings.visibleProviders.length === 0 ? [parsed.provider] : settings.visibleProviders
    return Promise.all(providers.map((provider, index) => translateProviderResult(ctx, provider, parsed.text, settings, 100 - index, providers.length > 1, parsed)))
  }
}
