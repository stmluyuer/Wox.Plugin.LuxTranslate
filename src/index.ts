import { Context, Plugin, PluginInitParams, PublicAPI, Query, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { speakText } from "./speech"
import { randomUUID } from "node:crypto"
import {
  collapseExtraBlankLines,
  DEFAULT_SETTINGS,
  getMissingConfiguration,
  historyKeyMatches,
  IncompleteTranslationError,
  isLanguageModelProvider,
  normalizeProvider,
  parseHistoryEntries,
  parseProviderList,
  parseProviderTableRows,
  parseTranslationQuery,
  PluginSettings,
  ProviderTableRow,
  resolveLanguageDirection,
  searchHistoryEntries,
  translateText,
  TranslationHistoryEntry,
  TranslationProvider,
  translationConfigurationKey,
  LanguageDirection,
  upsertHistoryEntry,
  LanguageCode
} from "./translate"

let api: PublicAPI
let woxLanguage: LanguageCode = "en"
let historyWrites: Promise<void> = Promise.resolve()
let providerWrites: Promise<void> = Promise.resolve()
let lastProviderSelection = ""
let providerRefinementId = "translation_providers"
let lastSourceCatalog = ""

const HISTORY_SETTING_KEY = "translation_history"
const PROVIDERS_SETTING_KEY = "visible_providers"
const PROVIDERS_MIGRATED_KEY = "visible_providers_migrated"
const VISIBLE_PROVIDERS: TranslationProvider[] = ["microsoft", "youdao", "caiyun", "openai", "claude", "deepseek", "llm_custom"]

// The bundled SDK predates QueryResponse. Keep the supported Wox >= 2.0.4
// wire fields typed here without adding a runtime dependency or changing the host.
type TranslationQuery = Query & { Refinements?: Record<string, string> }
interface ProviderRefinement {
  Id: string
  Title: string
  Type: "multiSelect"
  Options: Array<{ Value: string; Title: string }>
  DefaultValue: string[]
  Hotkey: string
}
interface TranslationQueryResponse {
  Results: Result[]
  Refinements: ProviderRefinement[]
}

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

interface TranslationSource {
  id: string
  provider: TranslationProvider
  name: string
  row?: ProviderTableRow
}

function translationSources(settings: PluginSettings): TranslationSource[] {
  return [
    ...VISIBLE_PROVIDERS.filter(provider => !isLanguageModelProvider(provider)).map(provider => ({ id: provider, provider, name: providerDisplayName(provider) })),
    ...settings.providerRows
      .filter(row => isLanguageModelProvider(normalizeProvider(row.provider || "")))
      .map(row => ({
        id: row.id as string,
        provider: normalizeProvider(row.provider || ""),
        name: [row.name?.trim() || providerDisplayName(normalizeProvider(row.provider || "")), row.model?.trim()].filter(Boolean).join(" · "),
        row
      }))
  ]
}

function visibleSourceList(value: string, sources: TranslationSource[]): string[] {
  const values: string[] = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",")
  // 旧版本保存供应商类型；只映射到原来使用的第一条配置，不擅自启用新增模型。
  return Array.from(
    new Set(
      values
        .map(value => {
          const selected = value.trim()
          return sources.find(source => source.id === selected)?.id || sources.find(source => source.provider === selected)?.id
        })
        .filter((id): id is string => id !== undefined)
    )
  )
}

async function loadModelRows(ctx: Context): Promise<ProviderTableRow[]> {
  // 查询与设置页都可能同时读取新行，用已有设置写入队列保证只分配一次标识。
  const update = providerWrites.then(async () => {
    const rows = parseProviderTableRows(await getSetting(ctx, "llm_provider_table", ""))
    const ids = new Set<string>()
    let changed = false
    for (const row of rows) {
      if (!row.id || ids.has(row.id)) {
        row.id = "model_" + randomUUID()
        changed = true
      }
      ids.add(row.id)
    }
    if (changed) await api.SaveSetting(ctx, "llm_provider_table", JSON.stringify(rows), false)
    return rows
  })
  providerWrites = update.then(
    () => undefined,
    () => undefined
  )
  return update
}

async function migrateVisibleProviders(ctx: Context): Promise<void> {
  if ((await getSetting(ctx, PROVIDERS_MIGRATED_KEY, "")) === "true") return
  const legacy = parseProviderList(await getSetting(ctx, PROVIDERS_SETTING_KEY, ""))
  const enabled = await Promise.all(VISIBLE_PROVIDERS.map(provider => getSetting(ctx, `visible_provider_${provider}`, legacy.includes(provider) ? "true" : "false")))
  const providers = VISIBLE_PROVIDERS.filter((_provider, index) => enabled[index] === "true")
  await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, providers.join(","), false)
  // Empty is a valid selection; remember migration separately so old switches
  // cannot restore cleared choices on the next startup.
  await api.SaveSetting(ctx, PROVIDERS_MIGRATED_KEY, "true", false)
}

async function saveVisibleProviders(ctx: Context, providers: string[]): Promise<void> {
  const write = providerWrites.then(async () => {
    const value = providers.join(",")
    await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, value, false)
    lastProviderSelection = value
    providerRefinementId = "translation_providers_" + randomUUID()
  })
  providerWrites = write.catch(() => undefined)
  await write
}

async function resolveVisibleProviders(ctx: Context, settings: PluginSettings, refinements?: Record<string, string>): Promise<{ providers: string[]; refinementId: string }> {
  // Serialize reads and writes together so rapid filter queries observe the
  // preceding save instead of mistaking it for an edit from the settings page.
  const update = providerWrites.then(async () => {
    const stored = await api.GetSetting(ctx, PROVIDERS_SETTING_KEY)
    const sources = translationSources(settings)
    const catalog = JSON.stringify(sources.map(source => [source.id, source.name]))
    if (stored !== lastProviderSelection || catalog !== lastSourceCatalog) {
      // Wox retains query values by refinement ID. A new ID discards stale
      // filters and lets the host apply the settings page's updated selection.
      providerRefinementId = "translation_providers_" + randomUUID()
      lastProviderSelection = stored
      lastSourceCatalog = catalog
    }
    let providers = visibleSourceList(stored, sources)
    const selected = refinements?.[providerRefinementId]
    if (typeof selected === "string") {
      const next = visibleSourceList(selected, sources)
      if (next.length || selected.trim() === "") {
        providers = next
      }
    }
    const value = providers.join(",")
    if (value !== stored) await api.SaveSetting(ctx, PROVIDERS_SETTING_KEY, value, false)
    lastProviderSelection = value
    return { providers, refinementId: providerRefinementId }
  })
  providerWrites = update.then(
    () => undefined,
    () => undefined
  )
  return update
}

async function loadSettings(ctx: Context): Promise<PluginSettings> {
  await providerWrites
  const timeoutRaw = await getSetting(ctx, "request_timeout_ms", String(DEFAULT_SETTINGS.requestTimeoutMs))
  const timeoutMs = Number.parseInt(timeoutRaw, 10)
  const historyLimitRaw = await getSetting(ctx, "history_limit", String(DEFAULT_SETTINGS.historyLimit))
  const historyLimit = Number.parseInt(historyLimitRaw, 10)
  const showPreviewDetails = (await getSetting(ctx, "show_preview_details", String(DEFAULT_SETTINGS.showPreviewDetails))) === "true"
  const enableSpeechPlayback = (await getSetting(ctx, "enable_speech_playback", String(DEFAULT_SETTINGS.enableSpeechPlayback))) === "true"
  const noSetupProviderTableValue = await getSetting(ctx, "no_setup_provider_table", "")
  const modelRows = await loadModelRows(ctx)
  const storedSelection = await getSetting(ctx, PROVIDERS_SETTING_KEY, "")
  const defaultSourceId = await getSetting(ctx, "default_provider", DEFAULT_SETTINGS.defaultProvider)

  const targetLanguageRaw = await getSetting(ctx, "default_target_language", DEFAULT_SETTINGS.defaultTargetLanguage || "auto")
  const pairLanguageRaw = await getSetting(ctx, "pair_language", DEFAULT_SETTINGS.pairLanguage || "auto")

  const settings: PluginSettings = {
    defaultProvider: normalizeProvider(defaultSourceId),
    defaultSourceId,
    visibleProviders: [],
    providerRows: [...parseProviderTableRows(noSetupProviderTableValue), ...modelRows],
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
    enableSpeechPlayback,
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? historyLimit : DEFAULT_SETTINGS.historyLimit
  }
  const sources = translationSources(settings)
  settings.visibleProviders = visibleSourceList(storedSelection, sources)
  const defaultSource = sources.find(source => source.id === defaultSourceId) || sources.find(source => source.provider === defaultSourceId)
  if (defaultSource) {
    settings.defaultProvider = defaultSource.provider
    settings.defaultSourceId = defaultSource.id
    if (defaultSourceId !== defaultSource.id) await api.SaveSetting(ctx, "default_provider", defaultSource.id, false)
  }
  return settings
}

function settingsForSource(settings: PluginSettings, source: TranslationSource): PluginSettings {
  if (!isLanguageModelProvider(source.provider)) return { ...settings, sourceId: source.id }
  // 每条配置独立使用自己的凭据、地址和模型，空字段必须显示配置提示。
  return {
    ...settings,
    sourceId: source.id,
    openaiBaseUrl: source.row?.baseUrl?.trim() || "",
    openaiApiKey: source.row?.apiKey?.trim() || "",
    openaiModel: source.row?.model?.trim() || "",
    temperature: source.row?.temperature?.trim() || undefined,
    reasoningEffort: source.row?.reasoningEffort?.trim() || undefined,
    requestTimeoutMs: source.row?.requestTimeoutMs?.trim() ? Number(source.row.requestTimeoutMs) : settings.requestTimeoutMs
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

async function buildProviderRefinement(ctx: Context, settings: PluginSettings, refinementId: string): Promise<ProviderRefinement> {
  const sources = translationSources(settings)
  return {
    Id: refinementId,
    Title: await t(ctx, "refinement_provider_title"),
    Type: "multiSelect",
    Options: sources.map(source => ({ Value: source.id, Title: source.name })),
    DefaultValue: settings.visibleProviders,
    Hotkey: ""
  }
}

async function buildDefaultProviderAction(ctx: Context, queryText = "tr "): Promise<NonNullable<Result["Actions"]>[number]> {
  return {
    Name: await t(ctx, "action_use_default_provider"),
    PreventHideAfterAction: true,
    Action: async (ctx: Context) => {
      await saveVisibleProviders(ctx, [])
      // Replacing the query also clears the host's old refinement map. An empty
      // multi-select otherwise reuses its defaults in Wox 2.4.7.
      await api.ChangeQuery(ctx, { QueryType: "input", QueryText: queryText })
    }
  }
}

async function buildHelpResult(ctx: Context, settings: PluginSettings): Promise<Result> {
  const cmd = await t(ctx, "help_preview_command")
  const dsc = await t(ctx, "help_preview_description")
  return {
    Title: await t(ctx, "help_title"),
    SubTitle: `${await t(ctx, "help_provider_selection")} · ${await t(ctx, "selected_providers")}: ${(settings.visibleProviders.length ? settings.visibleProviders : [settings.defaultSourceId]).map(id => translationSources(settings).find(source => source.id === id)?.name || id).join(", ")}`,
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

async function saveHistoryEntry(ctx: Context, entry: TranslationHistoryEntry, historyLimit: number): Promise<void> {
  // Only serialize the read/merge/write, not the network requests. Each completion must
  // merge the latest history rather than overwriting a snapshot from before translation.
  const write = historyWrites.then(async () => saveHistory(ctx, upsertHistoryEntry(await loadHistory(ctx), entry, historyLimit)))
  historyWrites = write.catch(() => undefined)
  return write
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

async function buildResultActions(
  ctx: Context,
  translatedText: string,
  sourceText: string,
  provider: TranslationProvider,
  settings: PluginSettings,
  direction: Pick<LanguageDirection, "sourceLanguage" | "targetLanguage">
): Promise<Result["Actions"]> {
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

  if (settings.enableSpeechPlayback) {
    actions.push({
      Name: await t(ctx, "action_play_translation"),
      Action: async (ctx: Context) => {
        try {
          await speakText(translatedText, direction.targetLanguage)
        } catch (error) {
          await api.Log(ctx, "Error", error instanceof Error ? error.stack || error.message : String(error))
        }
      }
    })
  }

  return actions.concat(await buildRetryActions(ctx, sourceText, provider, direction, settings))
}

async function buildRetryActions(
  ctx: Context,
  sourceText: string,
  provider: TranslationProvider,
  direction: Pick<LanguageDirection, "sourceLanguage" | "targetLanguage">,
  settings: PluginSettings
): Promise<NonNullable<Result["Actions"]>> {
  // 重试携带具体配置和语言，避免同一供应商的另一个模型接管请求。
  const queryFor = (source: { provider: TranslationProvider; id?: string }, refresh = false) =>
    `tr ${providerCommand(source.provider)} ${source.id ? "--config=" + source.id + " " : ""}${refresh ? "--refresh " : ""}${direction.sourceLanguage}:${direction.targetLanguage} ${sourceText}`
  const actions: NonNullable<Result["Actions"]> = [
    {
      Name: await t(ctx, "action_retranslate"),
      ContextData: { provider, configurationId: settings.sourceId || "" },
      Action: async (ctx: Context) => {
        await api.ChangeQuery(ctx, { QueryType: "input", QueryText: queryFor({ provider, id: settings.sourceId }, true) })
      }
    }
  ]
  for (const alternate of translationSources(settings)) {
    if (alternate.id === settings.sourceId) continue
    actions.push({
      Name: `${await t(ctx, "action_retry_with")} ${alternate.name}`,
      ContextData: { provider: alternate.provider, configurationId: alternate.id },
      Action: async (ctx: Context) => {
        await api.ChangeQuery(ctx, { QueryType: "input", QueryText: queryFor(alternate) })
      }
    })
  }

  actions.push(await buildDefaultProviderAction(ctx, `tr ${direction.sourceLanguage}:${direction.targetLanguage} ${sourceText}`))
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
  source: TranslationSource,
  sourceText: string,
  settings: PluginSettings,
  score: number,
  includeProviderInTitle: boolean,
  languageOverrides?: { sourceLanguage?: LanguageCode; targetLanguage?: LanguageCode; forceRefresh?: boolean },
  resultId?: string
): Promise<Result | undefined> {
  const provider = source.provider
  const providerSettings = settingsForSource(settings, source)

  // 用户通过 tr 指令指定的语言覆盖优先，否则走设置项
  const effectiveSource = languageOverrides?.sourceLanguage || providerSettings.defaultSourceLanguage
  const effectiveTarget = languageOverrides?.targetLanguage || (providerSettings.defaultTargetLanguage === "auto" ? providerSettings.woxLanguage || "en" : providerSettings.defaultTargetLanguage)
  const forceFixedTarget = Boolean(languageOverrides?.targetLanguage) || providerSettings.defaultTargetLanguage !== "auto"
  const pair = forceFixedTarget ? effectiveTarget : providerSettings.pairLanguage || "auto"

  let direction = resolveLanguageDirection(sourceText, effectiveSource, effectiveTarget, pair)
  const missingConfiguration = getMissingConfiguration(provider, providerSettings)
  if (missingConfiguration) {
    return {
      ...buildConfigurationResult(missingConfiguration, provider),
      Title: `${source.name}: ${await t(ctx, "configuration_required_title")}`,
      Score: score,
      Actions: await buildRetryActions(ctx, sourceText, provider, direction, providerSettings)
    }
  }
  const configurationKey = translationConfigurationKey(provider, providerSettings)
  const history = await loadHistory(ctx)
  const directionFromDetectedLanguage = (detectedLanguage?: string): LanguageDirection | undefined => {
    if (forceFixedTarget || effectiveSource !== "auto" || !detectedLanguage) return undefined
    const detected = normalizeLanguageCode(detectedLanguage.toLowerCase().replace("_", "-").split("-")[0])
    if (detected === "auto") return undefined
    return { ...resolveLanguageDirection(sourceText, detected, effectiveTarget, pair), sourceLanguage: "auto" }
  }
  // Script heuristics cannot distinguish Chinese from Japanese written only in kanji.
  // Reuse a provider's earlier detection before choosing the cached target direction.
  const detectedHistory = history.find(
    entry => entry.provider === provider && entry.sourceText === sourceText && entry.sourceLanguage === "auto" && entry.configurationKey === configurationKey && entry.detectedSourceLanguage
  )
  direction = directionFromDetectedLanguage(detectedHistory?.detectedSourceLanguage) || direction
  const historyEntry = languageOverrides?.forceRefresh ? undefined : history.find(entry => historyKeyMatches(entry, provider, sourceText, direction, configurationKey))
  if (historyEntry) {
    return buildTranslationResult(ctx, { ...historyEntry, providerName: source.name, configurationId: source.id }, sourceText, providerSettings, score, includeProviderInTitle, true)
  }

  const finishTranslation = async (onProgress?: (text: string) => Promise<void>): Promise<Result> => {
    let translation = await translateText(
      provider,
      {
        text: sourceText,
        direction,
        settings: providerSettings
      },
      onProgress
    )
    const correctedDirection = directionFromDetectedLanguage(translation.detectedSourceLanguage)
    if (correctedDirection && correctedDirection.targetLanguage !== direction.targetLanguage) {
      const detectedSourceLanguage = translation.detectedSourceLanguage
      direction = correctedDirection
      translation = {
        ...(await translateText(provider, { text: sourceText, direction, settings: providerSettings }, onProgress)),
        detectedSourceLanguage
      }
    }
    const entry: TranslationHistoryEntry = {
      sourceText,
      translatedText: translation.translatedText,
      provider,
      providerName: source.name,
      configurationId: source.id,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      detectedSourceLanguage: translation.detectedSourceLanguage,
      timestamp: Date.now(),
      configurationKey
    }
    await saveHistoryEntry(ctx, entry, providerSettings.historyLimit)
    return buildTranslationResult(ctx, entry, sourceText, providerSettings, score, includeProviderInTitle, false)
  }

  const failureResult = async (error: unknown): Promise<Result> => {
    await api.Log(ctx, "Error", error instanceof Error ? error.message : String(error))
    const message = errorMessageForProvider(error, provider)
    const title = `${source.name}: ${await t(ctx, error instanceof IncompleteTranslationError ? "translation_incomplete_title" : "translation_failed_title")}`
    return {
      Title: title,
      SubTitle: message,
      Icon: PLUGIN_ICON,
      Score: score,
      Preview: {
        PreviewType: "markdown",
        PreviewData: `${message}\n\n${error instanceof IncompleteTranslationError ? error.partialText : ""}`,
        PreviewProperties: {}
      },
      Actions: await buildRetryActions(ctx, sourceText, provider, direction, providerSettings)
    }
  }

  try {
    let lastUpdate = 0
    return await finishTranslation(
      resultId && isLanguageModelProvider(provider)
        ? async text => {
            if (lastUpdate !== 0 && Date.now() - lastUpdate < 80) return
            lastUpdate = Date.now()
            const visible = await api.UpdateResult(ctx, {
              Id: resultId,
              Title: `${source.name}: ${collapseExtraBlankLines(text)}`,
              Preview: { PreviewType: "markdown", PreviewData: collapseExtraBlankLines(text), PreviewProperties: {} }
            })
            if (!visible) throw new Error("Query no longer visible")
          }
        : undefined
    )
  } catch (error) {
    if (error instanceof Error && error.message === "Query no longer visible") return undefined
    return failureResult(error)
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
    Title: includeProviderInTitle ? `${entry.providerName}: ${entry.translatedText}` : entry.translatedText,
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
        Text: fromHistory ? await t(ctx, "subtitle_history") : entry.providerName
      }
    ],
    Actions: await buildResultActions(
      ctx,
      entry.translatedText,
      sourceText,
      entry.provider,
      { ...settings, sourceId: entry.configurationId },
      { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage }
    )
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

export const plugin: Omit<Plugin, "query"> & { query: (ctx: Context, query: TranslationQuery) => Promise<TranslationQueryResponse> } = {
  init: async (ctx: Context, initParams: PluginInitParams) => {
    api = initParams.API
    historyWrites = Promise.resolve()
    providerWrites = Promise.resolve()
    await migrateVisibleProviders(ctx)
    lastProviderSelection = await api.GetSetting(ctx, PROVIDERS_SETTING_KEY)
    providerRefinementId = "translation_providers"
    lastSourceCatalog = ""
    const settings = await loadSettings(ctx)
    await resolveVisibleProviders(ctx, settings)
    // 宿主支持异步动态设置；旧 SDK 的回调类型尚未包含 Promise。
    const dynamicApi = api as unknown as Omit<PublicAPI, "OnGetDynamicSetting"> & {
      OnGetDynamicSetting(ctx: Context, callback: (ctx: Context, key: string) => Promise<{ Type: "select"; Value: object }>): Promise<void>
    }
    await dynamicApi.OnGetDynamicSetting(ctx, async (ctx, key) => {
      const settings = await loadSettings(ctx)
      const sources = translationSources(settings)
      const isMulti = key === PROVIDERS_SETTING_KEY
      return {
        Type: "select",
        DisabledInPlatforms: [],
        IsPlatformSpecific: false,
        Value: {
          Key: key,
          Label: isMulti ? "i18n:settings_visible_providers" : "i18n:settings_provider",
          Tooltip: isMulti ? "i18n:settings_visible_providers_tip" : "i18n:settings_provider_tip",
          DefaultValue: isMulti ? "" : "microsoft",
          IsMulti: isMulti,
          Options: sources.map(source => ({ Value: source.id, Label: source.name })),
          Style: { Width: 640 }
        }
      }
    })
    // Detect Wox's selected UI language through plugin i18n.
    try {
      woxLanguage = normalizeWoxLanguageProbe(await api.GetTranslation(ctx, "language_probe"))
    } catch {
      woxLanguage = "en"
    }
    await api.Log(ctx, "Info", `LuxTranslate initialized, Wox language: ${woxLanguage}`)
  },

  query: async (ctx: Context, query: TranslationQuery): Promise<TranslationQueryResponse> => {
    const search = query.Type === "selection" ? query.Selection.Text : query.Search
    const settings = await loadSettings(ctx)
    const historySearch = query.Type === "selection" ? null : parseHistoryQuery(search)
    if (historySearch !== null) {
      return { Results: await buildHistoryResults(ctx, historySearch, settings), Refinements: [] }
    }
    // Selection contents are literal data, even when they begin with a command alias.
    const parsed =
      query.Type === "selection" ? { provider: settings.defaultProvider, text: search, forcedProvider: false, configurationId: undefined } : parseTranslationQuery(search, settings.defaultProvider)

    const selection = await resolveVisibleProviders(ctx, settings, parsed.forcedProvider ? undefined : query.Refinements)
    settings.visibleProviders = selection.providers
    // Explicit provider commands remain one-shot overrides; hiding the picker
    // avoids showing controls that would not affect those translation results.
    const refinements = parsed.forcedProvider ? [] : [await buildProviderRefinement(ctx, settings, selection.refinementId)]
    if (parsed.text === "") {
      const reset = await buildDefaultProviderAction(ctx)
      // Give reset its own explicit row. A sole help action becomes the
      // default Enter action in Wox and would silently erase preferences.
      return {
        Results: [
          await buildHelpResult(ctx, settings),
          {
            Title: reset.Name,
            SubTitle:
              (await t(ctx, "settings_provider")) + ": " + (translationSources(settings).find(source => source.id === settings.defaultSourceId)?.name || providerDisplayName(settings.defaultProvider)),
            Icon: PLUGIN_ICON,
            Score: 90,
            Actions: [reset]
          }
        ],
        Refinements: refinements
      }
    }

    const available = [...translationSources(settings), { id: "deepl", provider: "deepl" as TranslationProvider, name: "DeepL" }]
    let sources: TranslationSource[]
    if (parsed.configurationId) {
      sources = available.filter(source => source.id === parsed.configurationId)
      if (sources.length === 0) return { Results: [{ Title: await t(ctx, "configuration_removed_title"), SubTitle: parsed.configurationId, Icon: PLUGIN_ICON }], Refinements: refinements }
    } else if (parsed.forcedProvider) {
      sources = available.filter(source => source.provider === parsed.provider)
      if (sources.length === 0) sources = [{ id: parsed.provider, provider: parsed.provider, name: providerDisplayName(parsed.provider) }]
    } else {
      const ids = settings.visibleProviders.length ? settings.visibleProviders : [settings.defaultSourceId]
      sources = available.filter(source => ids.includes(source.id))
      if (sources.length === 0) return { Results: [{ Title: await t(ctx, "configuration_removed_title"), Icon: PLUGIN_ICON }], Refinements: refinements }
    }
    const pendingTitle = await t(ctx, "translating_title")
    const placeholders: Result[] = sources.map((source, index) => ({
      Id: `lux-tr-${randomUUID()}`,
      Title: `${source.name}: ${pendingTitle}`,
      SubTitle: parsed.text,
      Icon: PLUGIN_ICON,
      Score: 100 - index,
      Actions: [],
      Preview: { PreviewType: "markdown", PreviewData: pendingTitle, PreviewProperties: {} }
    }))
    // Wox 2.4.9 的推送会携带当前全部结果，但界面按追加处理。
    // 一次注册全部来源，之后只更新原行，避免旧占位被快照反复追加。
    if (!(await api.PushResults(ctx, query, placeholders))) return { Results: [], Refinements: refinements }
    const results = await Promise.all(
      sources.map(async (source, index): Promise<Result | undefined> => {
        const resultId = placeholders[index].Id as string
        const result = await translateProviderResult(ctx, source, parsed.text, settings, 100 - index, true, parsed, resultId)
        if (!result) return undefined
        const completed = { ...result, Id: resultId }
        // 缓存命中和配置错误也更新对应原行，不等待其他模型完成。
        await api.UpdateResult(ctx, completed)
        return completed
      })
    )
    // 正式返回保留同一组 ID，宿主最终快照才会保留已完成的流式结果。
    return { Results: results.filter((result): result is Result => result !== undefined), Refinements: refinements }
  }
}
