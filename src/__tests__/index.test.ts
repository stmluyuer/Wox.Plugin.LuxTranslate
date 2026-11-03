import { Context, PluginInitParams, Query, Result } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import * as translate from "../translate"

const ctx = {} as Context

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function createHost(selected = "model_openai") {
  const registered = deferred()
  const settings: Record<string, string> = {
    visible_providers: selected,
    visible_providers_migrated: "true",
    llm_provider_table: JSON.stringify([{ id: "model_openai", provider: "openai", name: "OpenAI", model: "test-model", baseUrl: "https://example.invalid/v1", apiKey: "offline-test" }])
  }
  const visible: Result[] = []
  const cached = new Map<string, Result>()
  const api = {
    OnGetDynamicSetting: jest.fn(async () => undefined),
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] || ""),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => (key === "language_probe" ? "en" : key)),
    SaveSetting: jest.fn(async (_ctx: Context, key: string, value: string) => {
      settings[key] = value
    }),
    Log: jest.fn(async () => undefined),
    PushResults: jest.fn(async (_ctx: Context, _query: Query, results: Result[]) => {
      // 复现 Wox 2.4.9：核心发全量缓存快照，界面继续追加。第二次推送就会复制旧行。
      for (const result of results) cached.set(result.Id as string, { ...result })
      visible.push(...Array.from(cached.values()).map(result => ({ ...result })))
      registered.resolve()
      return true
    }),
    UpdateResult: jest.fn(async (_ctx: Context, result: Partial<Result>) => {
      const index = visible.findIndex(row => row.Id === result.Id)
      if (index < 0) return false
      visible[index] = { ...visible[index], ...result }
      cached.set(result.Id as string, visible[index])
      return true
    })
  }
  const query = () => plugin.query(ctx, { Id: "query-one", SessionId: "session-one", Type: "input", Search: "hello" } as unknown as Query)
  return { api, settings, visible, registered, query }
}

afterEach(() => jest.restoreAllMocks())

test("streaming keeps one row from placeholder through throttled updates and final return", async () => {
  const ready = deferred()
  const h = createHost()
  jest.spyOn(translate, "translateText").mockImplementation(async (_provider, _request, onProgress) => {
    await ready.promise
    await onProgress?.("A")
    await onProgress?.("AB")
    return { translatedText: "AB", providerName: "OpenAI" }
  })
  jest.spyOn(Date, "now").mockReturnValue(1000)
  await plugin.init(ctx, { API: h.api } as unknown as PluginInitParams)
  const pending = h.query()
  await h.registered.promise
  const id = h.visible[0].Id
  expect(h.visible[0].Title).toContain("translating_title")
  ready.resolve()
  const response = await pending
  expect(h.api.PushResults).toHaveBeenCalledTimes(1)
  expect(h.api.UpdateResult).toHaveBeenCalledTimes(2)
  expect(response.Results).toHaveLength(1)
  expect(h.visible).toHaveLength(1)
  expect(response.Results[0]).toMatchObject({ Id: id, Title: "OpenAI · test-model: AB" })
  expect(h.visible[0]).toEqual(response.Results[0])
  expect(h.api.SaveSetting).toHaveBeenCalledWith(ctx, "translation_history", expect.stringContaining('"translatedText":"AB"'), false)
})

test("fast results and failures replace their rows while a slow model is still running", async () => {
  const ready = deferred()
  const fastRows = deferred()
  const h = createHost("microsoft,youdao,model_openai")
  const update = h.api.UpdateResult.getMockImplementation()!
  let fastCompleted = 0
  h.api.UpdateResult.mockImplementation(async (context, result) => {
    const accepted = await update(context, result)
    if (result.Actions?.length && result.Title?.startsWith("OpenAI") !== true && ++fastCompleted === 2) fastRows.resolve()
    return accepted
  })
  jest.spyOn(translate, "translateText").mockImplementation(async (provider, _request, onProgress) => {
    if (provider === "microsoft") return { translatedText: "你好", providerName: "Microsoft" }
    if (provider === "youdao") throw new Error("offline provider failure")
    await ready.promise
    await onProgress?.("您好")
    return { translatedText: "您好", providerName: "OpenAI" }
  })
  await plugin.init(ctx, { API: h.api } as unknown as PluginInitParams)
  const pending = h.query()
  try {
    await fastRows.promise
    expect(h.visible).toHaveLength(3)
    expect(h.visible[0].Title).toBe("Microsoft: 你好")
    expect(h.visible[1].Title).toBe("Youdao: translation_failed_title")
    expect(h.visible[2].Title).toContain("translating_title")
  } finally {
    ready.resolve()
  }
  const response = await pending
  expect(h.api.PushResults).toHaveBeenCalledTimes(1)
  expect(response.Results).toHaveLength(3)
  expect(h.visible).toHaveLength(3)
  expect(new Set(h.visible.map(result => result.Id)).size).toBe(3)
  expect(h.visible).toEqual(response.Results)
  expect(h.visible.every(result => !result.Title.includes("translating_title"))).toBe(true)
})

test("cached and missing-configuration results also update their original rows", async () => {
  const h = createHost("microsoft,model_openai")
  h.settings.llm_provider_table = JSON.stringify([{ id: "model_openai", provider: "openai", name: "OpenAI" }])
  h.settings.translation_history = JSON.stringify([
    { sourceText: "hello", translatedText: "你好", provider: "microsoft", providerName: "Microsoft", sourceLanguage: "auto", targetLanguage: "zh", timestamp: 1000 }
  ])
  const request = jest.spyOn(translate, "translateText")
  await plugin.init(ctx, { API: h.api } as unknown as PluginInitParams)
  const response = await h.query()
  expect(request).not.toHaveBeenCalled()
  expect(h.api.PushResults).toHaveBeenCalledTimes(1)
  expect(h.visible).toHaveLength(2)
  expect(h.visible).toEqual(response.Results)
  expect(h.visible[0].Title).toBe("Microsoft: 你好")
  expect(h.visible[1].Title).toBe("OpenAI: configuration_required_title")
})
