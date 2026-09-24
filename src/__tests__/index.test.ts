import { Context, PluginInitParams, Query } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import * as translate from "../translate"

test("streaming UI skips throttled updates without cancelling translation", async () => {
  let resume!: () => void
  const ready = new Promise<void>(resolve => {
    resume = resolve
  })
  const stream = jest.spyOn(translate, "translateWithOpenAICompatibleStream").mockImplementation(async (_request, _name, callbacks) => {
    await ready
    await callbacks.onToken("A")
    await callbacks.onToken("B")
    await callbacks.onComplete("AB")
  })
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000)
  const settings: Record<string, string> = { visible_providers: "openai", openai_api_key: "test" }
  const api = {
    GetSetting: jest.fn(async (_ctx: Context, key: string) => settings[key] || ""),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    UpdateResult: jest.fn(async () => true),
    SaveSetting: jest.fn(async () => undefined),
    Log: jest.fn(async () => undefined)
  }
  const ctx = {} as Context
  try {
    await plugin.init(ctx, { API: api } as unknown as PluginInitParams)
    const results = await plugin.query(ctx, { Type: "input", Search: "openai hello" } as Query)
    resume()
    await stream.mock.results[0].value
    expect(api.UpdateResult).toHaveBeenCalledTimes(3)
    expect(api.UpdateResult).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Id: results[0].Id, Title: "translation_done_title" }))
    expect(api.SaveSetting).toHaveBeenCalledWith(ctx, "translation_history", expect.stringContaining('"translatedText":"AB"'), false)
    expect(api.Log).not.toHaveBeenCalledWith(ctx, "Error", expect.anything())
  } finally {
    resume()
    stream.mockRestore()
    clock.mockRestore()
  }
})
