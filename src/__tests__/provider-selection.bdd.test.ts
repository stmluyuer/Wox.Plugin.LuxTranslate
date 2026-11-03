import { ActionContext, Context, ExecuteResultAction, PluginInitParams, Query } from "@wox-launcher/wox-plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { plugin } from "../index"
import * as translate from "../translate"

const ctx = {} as Context

async function setup(initial: Record<string, string> = {}) {
  const settings = { ...initial }
  const api = {
    OnGetDynamicSetting: jest.fn<Promise<void>, [Context, (ctx: Context, key: string) => Promise<unknown>]>(async () => undefined),
    PushResults: jest.fn(async () => true),
    UpdateResult: jest.fn(async () => true),
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] ?? ""),
    SaveSetting: jest.fn(async (_ctx: Context, key: string, value: string) => {
      await Promise.resolve()
      settings[key] = value
    }),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    Log: jest.fn(async () => undefined),
    ChangeQuery: jest.fn(async () => undefined)
  }
  const restart = () => plugin.init(ctx, { API: api } as unknown as PluginInitParams)
  const query = (text = "", refinements?: Record<string, string>) => plugin.query(ctx, { Type: "input", Search: text, Refinements: refinements } as unknown as Query)
  await restart()
  return { settings, api, restart, query }
}

beforeEach(() => {
  jest.spyOn(translate, "translateText").mockImplementation(async provider => ({ translatedText: "translated", providerName: provider }))
})

afterEach(() => jest.restoreAllMocks())

// Given 设置页保存了多个翻译源
// When 发起普通翻译查询
// Then 按保存的选择翻译，筛选入口显示相同选择
test("uses saved provider selection for translation and filters", async () => {
  const h = await setup({ visible_provider_microsoft: "true" })
  h.settings.visible_providers = "microsoft,youdao"
  const response = await h.query("hello")
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["microsoft", "youdao"])
  expect(response.Refinements[0].DefaultValue).toEqual(["microsoft", "youdao"])
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"))
  expect(manifest.SettingDefinitions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Type: "dynamic",
        Value: expect.objectContaining({ Key: "visible_providers" })
      })
    ])
  )
  const definition = await h.api.OnGetDynamicSetting.mock.calls[0][1](ctx, "visible_providers")
  expect(definition).toMatchObject({ Type: "select", Value: { Key: "visible_providers", IsMulti: true } })
  expect(JSON.stringify(manifest.SettingDefinitions)).not.toContain("visible_providers_dropdown_trial")
})

// Given 翻译窗口显示当前选择
// When 用户通过筛选更改翻译源
// Then 保存到设置页使用的同一配置，后续查询使用新选择
test("persists filter changes to the shared provider setting", async () => {
  const h = await setup({ visible_providers: "microsoft" })
  const id = (await h.query()).Refinements[0].Id
  await h.query("", { [id]: "youdao" })
  expect(h.settings.visible_providers).toBe("youdao")
  await h.query("hello")
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["youdao"])
})

// Given 查询窗口仍携带旧筛选值
// When 用户在设置页更改选择后再次查询
// Then 使用新设置，不让旧筛选覆盖它，并允许后续主动筛选
test("keeps settings changes when a query carries stale filters", async () => {
  const h = await setup({ visible_providers: "microsoft" })
  const oldId = (await h.query()).Refinements[0].Id
  h.settings.visible_providers = "youdao"
  const response = await h.query("hello", { [oldId]: "microsoft" })
  expect(h.settings.visible_providers).toBe("youdao")
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["youdao"])
  expect(response.Refinements[0].DefaultValue).toEqual(["youdao"])
  const newId = response.Refinements[0].Id
  expect(newId).not.toBe(oldId)
  await h.query("", { [oldId]: "microsoft" })
  expect(h.settings.visible_providers).toBe("youdao")
  await h.query("", { [newId]: "microsoft,youdao" })
  expect(h.settings.visible_providers).toBe("microsoft,youdao")
})

// Given 旧版已保存实际筛选选择及独立的试用选择
// When 首次加载升级后的插件
// Then 迁移实际筛选选择，试用值不覆盖它，后续加载不重复迁移
test("migrates active legacy selections only once", async () => {
  const h = await setup({ visible_providers: "microsoft", visible_provider_microsoft: "false", visible_provider_youdao: "true", visible_providers_dropdown_trial: "caiyun" })
  expect(h.settings.visible_providers).toBe("youdao")
  h.settings.visible_providers = "microsoft,youdao"
  await h.restart()
  expect((await h.query()).Refinements[0].DefaultValue).toEqual(["microsoft", "youdao"])
  expect(h.settings.visible_providers_dropdown_trial).toBe("caiyun")
})

// Given 用户清空已选翻译源
// When 查询或重新初始化插件后查询
// Then 使用默认翻译源，不恢复旧选择
test("preserves an empty selection and falls back to the default provider", async () => {
  const h = await setup({ visible_provider_youdao: "true", default_provider: "microsoft" })
  const oldId = (await h.query()).Refinements[0].Id
  h.settings.visible_providers = ""
  expect((await h.query("hello", { [oldId]: "youdao" })).Refinements[0].DefaultValue).toEqual([])
  await h.restart()
  await h.query("world")
  expect(h.settings.visible_providers).toBe("")
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["microsoft", "microsoft"])
})

// Given 已保存多个翻译源
// When 查询中明确指定一个翻译源
// Then 仅本次使用指定来源，保留已保存的多选
test("keeps explicit provider commands as one-shot overrides", async () => {
  const h = await setup({ visible_providers: "microsoft,youdao" })
  const id = (await h.query()).Refinements[0].Id
  expect((await h.query("ms hello", { [id]: "caiyun" })).Refinements).toEqual([])
  expect(h.settings.visible_providers).toBe("microsoft,youdao")
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["microsoft"])
})

// Given 筛选已保存多个翻译源
// When 插件重新初始化后发起查询
// Then 恢复同一选择并用于翻译
test("restores the shared selection after initialization", async () => {
  const h = await setup()
  const id = (await h.query()).Refinements[0].Id
  await h.query("", { [id]: "microsoft,youdao" })
  await h.restart()
  const response = await h.query("hello")
  expect(h.settings.visible_providers).toBe("microsoft,youdao")
  expect(response.Refinements[0].DefaultValue).toEqual(["microsoft", "youdao"])
  expect(jest.mocked(translate.translateText).mock.calls.map(call => call[0])).toEqual(["microsoft", "youdao"])
})

// Given 用户快速连续改变同一筛选入口
// When 两次查询的保存发生交错
// Then 保存最后一次完整选择，不把自己的写入误认成设置页修改
test("keeps the last rapid filter change", async () => {
  const h = await setup()
  const id = (await h.query()).Refinements[0].Id
  await Promise.all([h.query("", { [id]: "microsoft,youdao" }), h.query("", { [id]: "youdao" })])
  expect(h.settings.visible_providers).toBe("youdao")
  expect((await h.query()).Refinements[0].DefaultValue).toEqual(["youdao"])
})

// Given 已保存选择且查询窗口保留旧筛选值
// When 用户点击使用默认翻译源
// Then 清空统一设置，并使遗留筛选失效
test("reset clears the shared setting without reviving stale filters", async () => {
  const h = await setup({ visible_providers: "youdao" })
  const response = await h.query()
  const id = response.Refinements[0].Id
  const reset = response.Results[1].Actions!.find(action => action.Name === "action_use_default_provider")! as ExecuteResultAction
  await reset.Action(ctx, {} as ActionContext)
  expect(h.settings.visible_providers).toBe("")
  expect((await h.query("", { [id]: "youdao" })).Refinements[0].DefaultValue).toEqual([])
  expect(h.settings.visible_providers).toBe("")
})
