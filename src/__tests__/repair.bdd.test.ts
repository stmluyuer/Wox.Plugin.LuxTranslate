import { ActionContext, Context, ExecuteResultAction, Query, Result } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { DEFAULT_SETTINGS, parseTranslationQuery, resolveLanguageDirection, translateWithMicrosoft } from "../translate"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ctx = {} as Context
const originalFetch = global.fetch

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function ms(text = "你好"): Response {
  return json([{ translations: [{ text }] }])
}

function sse(text: string, finish = "stop", done = true): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
    ...(done ? ["data: [DONE]\n\n"] : [])
  ]
  let index = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 2))
        if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]))
        else controller.close()
      }
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
}

function rows(model = "model-A", baseUrl = "https://example.invalid/v1") {
  return JSON.stringify([{ provider: "openai", name: "OpenAI", apiKey: "offline-test", model, baseUrl }])
}

async function setup(overrides: Record<string, string> = {}) {
  const settings: Record<string, string> = {
    request_timeout_ms: "300",
    llm_provider_table: JSON.stringify(
      ["openai", "claude", "deepseek", "llm_custom"].map(provider => ({
        id: "model_" + provider,
        provider,
        name: provider,
        apiKey: "offline-test",
        baseUrl: "https://example.invalid/v1",
        model: "test-model"
      }))
    ),
    ...overrides
  }
  const pushed: Result[] = []
  const updates: Result[] = []
  const api = {
    OnGetDynamicSetting: jest.fn<Promise<void>, [Context, (ctx: Context, key: string) => Promise<unknown>]>(async () => undefined),
    GetSetting: jest.fn(async (_ctx, key: string) => settings[key] ?? ""),
    SaveSetting: jest.fn(async (_ctx, key: string, value: string) => {
      await new Promise(resolve => setTimeout(resolve, 1))
      settings[key] = value
    }),
    GetTranslation: jest.fn(async (_ctx, key: string) => (key === "language_probe" ? "zh" : key)),
    Copy: jest.fn(async () => undefined),
    ChangeQuery: jest.fn(async () => undefined),
    Log: jest.fn(async () => undefined),
    UpdateResult: jest.fn(async (_ctx, update: Result) => {
      updates.push(update)
      return true
    }),
    PushResults: jest.fn(async (_ctx, _query: Query, results: Result[]) => {
      pushed.push(...results)
      return true
    })
  }
  await plugin.init(ctx, { API: api } as never)
  async function response(text: string, selection = false, refinements?: Record<string, string>) {
    pushed.length = 0
    const raw = await plugin.query(ctx, {
      Id: "probe-query",
      Type: selection ? "selection" : "input",
      Search: text,
      RawQuery: `tr ${text}`,
      Env: {} as Query["Env"],
      IsGlobalQuery: () => false,
      Selection: { Type: "text", Text: text, FilePaths: [] },
      Refinements: refinements
    } as Query & { Refinements?: Record<string, string> })
    const result = raw as unknown as Result[] | { Results: Result[]; Refinements?: Array<{ Id: string; Type: string; DefaultValue: string[]; Options: Array<{ Value: string }> }> }
    return Array.isArray(result) ? { Results: result, Refinements: [] } : { ...result, Refinements: result.Refinements || [] }
  }
  return {
    api,
    settings,
    response,
    restart: () => plugin.init(ctx, { API: api } as never),
    updates,
    history: () => JSON.parse(settings.translation_history || "[]") as Array<{ sourceText: string; provider: string; translatedText: string }>,
    async query(text: string, selection = false, refinements?: Record<string, string>): Promise<Result[]> {
      return (await response(text, selection, refinements)).Results
    },
    async finish(initial: Result): Promise<Result> {
      if (!initial.Id) return initial
      const started = Date.now()
      while (Date.now() - started < 1500) {
        const last = updates.filter(update => update.Id === initial.Id).slice(-1)[0]
        if (last && (last.Actions?.length || /failed|incomplete/i.test(last.Title || ""))) return { ...initial, ...last }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error("Stream did not finish")
    }
  }
}

function action(result: Result, predicate: (item: ExecuteResultAction) => boolean): ExecuteResultAction {
  const found = (result.Actions as ExecuteResultAction[] | undefined)?.find(predicate)
  expect(found).toBeDefined()
  return found!
}

afterEach(() => {
  global.fetch = originalFetch
  jest.clearAllMocks()
})

describe("LuxTranslate 翻译与配置回归场景", () => {
  test("空查询提供一个原生多选筛选入口并恢复当前来源", async () => {
    // Given 用户此前选择了 DeepSeek
    const h = await setup({ visible_provider_deepseek: "true" })
    global.fetch = jest.fn() as typeof fetch
    // When 打开翻译插件但尚未输入原文
    const response = await h.response("")
    // Then 只提供一个多选筛选入口且不发出翻译请求
    expect(response.Refinements).toHaveLength(1)
    expect(response.Refinements[0]).toMatchObject({ Id: expect.stringMatching(/^translation_providers_/), Type: "multiSelect", DefaultValue: ["model_deepseek"] })
    expect(response.Refinements[0].Options.map(option => option.Value)).toEqual(["microsoft", "youdao", "caiyun", "model_openai", "model_claude", "model_deepseek", "model_llm_custom"])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test("集中选择多个来源后保存并在插件重载后恢复", async () => {
    // Given 用户在无原文的翻译窗口中配置来源
    const h = await setup({ visible_provider_deepseek: "true" })
    // When 在多选筛选中选中 Microsoft 和有道再重新加载插件
    const id = (await h.response("")).Refinements[0].Id
    await h.response("", false, { [id]: "microsoft,youdao" })
    await h.restart()
    const response = await h.response("")
    // Then 新选择保留而旧的 DeepSeek 不再启用
    expect(response.Refinements[0].DefaultValue).toEqual(["microsoft", "youdao"])
    expect(h.settings.visible_providers).toBe("microsoft,youdao")
  })

  test("取消部分来源后实际翻译只请求仍然选中的来源", async () => {
    // Given 原来同时启用了 Microsoft 和有道
    const h = await setup({ visible_providers: "microsoft,youdao" })
    global.fetch = jest.fn(async () => json({ translateResult: [[{ tgt: "您好" }]] })) as typeof fetch
    // When 在多选入口取消 Microsoft 后翻译
    const id = (await h.response("")).Refinements[0].Id
    const results = await h.query("hello", false, { [id]: "youdao" })
    // Then 只请求有道且 Microsoft 偏好已关闭
    expect(results).toHaveLength(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain("youdao")
    expect(h.settings.visible_providers).toBe("youdao")
  })

  test("恢复默认操作清除多源选择且重开时不复活旧偏好", async () => {
    // Given 旧版本保存了 DeepSeek 而全局默认来源是 Microsoft
    const h = await setup({ visible_providers: "deepseek" })
    const response = await h.response("")
    // When 使用恢复默认操作并重新加载插件
    expect(response.Results[0].Actions?.some(item => item.Name === "action_use_default_provider")).toBeFalsy()
    const reset = action(response.Results[1], item => item.Name === "action_use_default_provider")
    await reset.Action(ctx, { ContextData: {} } as ActionContext)
    await h.restart()
    const reopened = await h.response("")
    // Then 仅使用默认来源且旧偏好保持关闭
    expect(reopened.Refinements[0].DefaultValue).toEqual([])
    expect(h.settings.visible_providers).toBe("")
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, { QueryType: "input", QueryText: "tr " })
  })

  test("显式指定翻译源时不改写集中选择的偏好", async () => {
    // Given 用户集中选择了 DeepSeek
    const h = await setup({ visible_provider_deepseek: "true" })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 用命令明确指定 Microsoft 且收到同一窗口遗留的筛选值
    const response = await h.response("ms hello", false, { translation_providers: "microsoft,youdao" })
    // Then 只请求 Microsoft 且不修改保存的 DeepSeek 选择
    expect(response.Refinements).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(h.settings.visible_providers).toBe("model_deepseek")
  })

  test("连续快速选择时保存最后一次完整选择", async () => {
    // Given 用户连续修改同一个来源筛选
    const h = await setup()
    // When 两次修改的保存过程发生交错
    const id = (await h.response("")).Refinements[0].Id
    await Promise.all([h.response("", false, { [id]: "microsoft,youdao" }), h.response("", false, { [id]: "youdao" })])
    // Then 最后一次选择完整保存
    const response = await h.response("")
    expect(response.Refinements[0].DefaultValue).toEqual(["youdao"])
    expect(h.settings.visible_providers).toBe("youdao")
  })

  test("在当前 Wox 中配置多个翻译源后实际按所选来源翻译", async () => {
    // Given 用户原有的两个翻译源选择已保存
    const h = await setup({ visible_provider_microsoft: "true", visible_provider_youdao: "true" })
    global.fetch = jest.fn(async (url: string | URL | Request) => (String(url).includes("youdao") ? json({ translateResult: [[{ tgt: "您好" }]] }) : ms())) as typeof fetch
    // When 保存的选择用于一次普通翻译
    const results = await h.query("hello")
    // Then 两个翻译源都被请求且设置页不再堆叠独立开关
    expect(results).toHaveLength(2)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../plugin.json"), "utf8"))
    const fields = manifest.SettingDefinitions as Array<{ Type: string; Value: { Key?: string } }>
    expect(fields.some(item => item.Type === "dynamic" && item.Value.Key === "visible_providers")).toBe(true)
    const definition = await h.api.OnGetDynamicSetting.mock.calls[0][1](ctx, "visible_providers")
    expect(definition).toMatchObject({ Type: "select", Value: { Key: "visible_providers", IsMulti: true } })
    expect(fields.filter(item => item.Type === "checkbox" && item.Value.Key?.startsWith("visible_provider_"))).toHaveLength(0)
  })

  test("各翻译源的接口和模型配置可编辑并用于对应请求", async () => {
    // Given 用户保存了 OpenAI 的接口和模型
    const h = await setup({ llm_provider_table: rows("edited-model", "https://edited.invalid/v1") })
    global.fetch = jest.fn(async (_url, init) => (JSON.parse(String(init?.body)).stream ? sse("译文") : json({ choices: [{ message: { content: "译文" } }] }))) as typeof fetch
    // When 查询对应翻译源
    const [initial] = await h.query("openai hello")
    await h.finish(initial)
    // Then 请求使用所保存的配置
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe("https://edited.invalid/v1/chat/completions")
    expect(JSON.parse(init.body).model).toBe("edited-model")
  })

  test.each(["history", "en", "ms is an abbreviation"])("选中的文本始终作为原文而不是插件命令：%s", async text => {
    // Given 用户选中一个可能与命令重名的原文
    const h = await setup()
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 通过选中文本入口查询
    await h.query(text, true)
    // Then 完整原文进入翻译
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const init = (global.fetch as jest.Mock).mock.calls[0][1]
    expect(JSON.parse(init.body)[0].Text).toBe(text)
  })

  test("切换翻译源保留已指定的源语言和目标语言", async () => {
    // Given 原文明确指定英文翻译为日文
    const h = await setup()
    global.fetch = jest.fn(async () => ms("こんにちは")) as typeof fetch
    const [result] = await h.query("ms en:ja hello")
    // When 点击另一个翻译源
    const change = action(result, item => item.ContextData?.provider === "youdao")
    await change.Action(ctx, { ResultId: "", ResultActionId: "", ContextData: { provider: "youdao" } } as ActionContext)
    // Then 新命令保留语言方向
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, expect.objectContaining({ QueryText: expect.stringContaining("en:ja hello") }))
  })

  test("多个翻译源同时完成时每份历史记录都能保留", async () => {
    // Given 两个来源同时翻译且先后完成
    const h = await setup({ visible_providers: "microsoft,youdao" })
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      await new Promise(resolve => setTimeout(resolve, String(url).includes("youdao") ? 10 : 2))
      return String(url).includes("youdao") ? json({ translateResult: [[{ tgt: "您好" }]] }) : ms()
    }) as typeof fetch
    // When 两者保存各自成功结果
    await h.query("hello")
    // Then 每份历史均被保留
    expect(
      h
        .history()
        .map(entry => entry.provider)
        .sort()
    ).toEqual(["microsoft", "youdao"])
  })

  test("更换模型或接口后不复用原配置的译文缓存", async () => {
    // Given 模型 A 已有缓存
    const h = await setup({ llm_provider_table: rows() })
    global.fetch = jest.fn(async (_url, init) => (JSON.parse(String(init?.body)).stream ? sse("译文") : json({ choices: [{ message: { content: "译文" } }] }))) as typeof fetch
    await h.finish((await h.query("openai hello"))[0])
    // When 更改模型再更改接口并重复查询
    h.settings.llm_provider_table = rows("model-B")
    await h.finish((await h.query("openai hello"))[0])
    h.settings.llm_provider_table = rows("model-B", "https://new.invalid/v1")
    await h.finish((await h.query("openai hello"))[0])
    // Then 每份新配置都产生新的请求
    expect(global.fetch).toHaveBeenCalledTimes(3)
  })

  test("保留原文换行、空行和代码缩进", () => {
    // Given 命令中的正文包含分段与缩进
    const text = "First line\n\n    code  block\nLast line"
    // When 解析正文
    const parsed = parseTranslationQuery(`ms en:zh ${text}`, "microsoft")
    // Then 正文保持不变
    expect(parsed.text).toBe(text)
  })

  test("保留已安装版本的大模型流式输出", async () => {
    // Given 大模型依次返回多个片段
    const h = await setup({ llm_provider_table: rows() })
    global.fetch = jest.fn(async () => sse("完整译文")) as typeof fetch
    // When 查询时先展示占位结果再接收片段
    const [initial] = await h.query("openai hello")
    expect(initial.Id).toBeTruthy()
    const final = await h.finish(initial)
    // Then 有逐步更新且完整译文可复制
    expect(h.updates.length).toBeGreaterThan(1)
    const copy = action(final, item => item.Name === "action_copy_translation")
    await copy.Action(ctx, { ContextData: {} } as ActionContext)
    expect(h.api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: "完整译文" })
  })

  test.each(["length", "error"])("模型异常结束的译文不会冒充完整结果：%s", async reason => {
    // Given 接口因长度限制结束
    const h = await setup({ llm_provider_table: rows() })
    global.fetch = jest.fn(async () => sse("只有前半段", reason)) as typeof fetch
    // When 处理结束原因
    const result = await h.finish((await h.query("openai hello"))[0])
    // Then 提示不完整且不保存成功缓存
    expect(`${result.Title} ${result.SubTitle}`).toMatch(/incomplete|不完整/i)
    expect(h.history()).toHaveLength(0)
  })

  test("连接中断或异常结束的流不会保存为完整译文", async () => {
    // Given 接口有正文但没有完成标记
    const h = await setup({ llm_provider_table: rows() })
    global.fetch = jest.fn(async () => sse("只有前半段", "", false)) as typeof fetch
    // When 连接结束
    const result = await h.finish((await h.query("openai hello"))[0])
    // Then 不将半份译文存入成功历史
    expect(`${result.Title} ${result.SubTitle}`).toMatch(/incomplete|不完整/i)
    expect(h.history()).toHaveLength(0)
  })

  test("请求超时也覆盖响应正文的读取", async () => {
    // Given 响应头及时到达而正文超出期限
    global.fetch = jest.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode(JSON.stringify([{ translations: [{ text: "迟到译文" }] }])))
                controller.close()
              }, 80)
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(timer)
                controller.error(new Error("aborted"))
              })
            }
          })
        )
    ) as typeof fetch
    // When 超过配置的 15 毫秒
    const request = translateWithMicrosoft({ text: "hello", direction: resolveLanguageDirection("hello", "auto", "zh"), settings: { ...DEFAULT_SETTINGS, requestTimeoutMs: 15 } })
    // Then 正文读取随请求超时结束
    await expect(request).rejects.toThrow(/timeout|timed out|abort|超时/i)
  })

  test("翻译失败后可以直接重试或切换翻译源", async () => {
    // Given 一个翻译源失败
    const h = await setup()
    global.fetch = jest.fn(async () => json({ error: "unavailable" }, 503)) as typeof fetch
    // When 显示失败结果
    const [result] = await h.query("ms en:ja hello")
    // Then 失败页面仍可重试与换源
    expect(action(result, item => item.Name === "action_retranslate")).toBeDefined()
    const change = action(result, item => item.ContextData?.provider === "youdao")
    await change.Action(ctx, { ResultId: "", ResultActionId: "", ContextData: { provider: "youdao" } } as ActionContext)
    expect(h.api.ChangeQuery).toHaveBeenCalledWith(ctx, expect.objectContaining({ QueryText: expect.stringContaining("en:ja hello") }))
  })

  test("用户可以主动重新翻译而不继续命中旧缓存", async () => {
    // Given 原文已有成功缓存
    const h = await setup()
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    const [result] = await h.query("hello")
    // When 选择重新翻译后执行生成的命令
    const retry = action(result, item => item.Name === "action_retranslate")
    await retry.Action(ctx, { ContextData: {} } as ActionContext)
    const next = h.api.ChangeQuery.mock.calls[0] as unknown as [Context, { QueryText: string }]
    await h.query(next[1].QueryText.replace(/^tr\s+/, ""))
    // Then 再次请求且不重复增加相同历史
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(h.history()).toHaveLength(1)
  })

  test("手动朗读等现有功能继续可用且不自动播放", async () => {
    // Given 用户启用手动朗读
    const h = await setup({ enable_speech_playback: "true" })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 成功翻译但尚未点击播放
    const [result] = await h.query("hello")
    // Then 手动朗读和复制操作仍可用
    expect(action(result, item => item.Name === "action_play_translation")).toBeDefined()
    expect(action(result, item => item.Name === "action_copy_translation")).toBeDefined()
    expect(h.api.Copy).not.toHaveBeenCalled()
  })

  test("保留旧版本的多源选择且取消所有勾选后使用默认来源", async () => {
    // Given 旧版本保存了两个翻译源
    const h = await setup({ visible_providers: '["microsoft","youdao"]' })
    expect(h.settings.visible_providers).toBe("microsoft,youdao")
    // When 用户在设置页清空选择
    h.settings.visible_providers = ""
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    await h.query("hello")
    // Then 不重新启用旧选择且只使用默认翻译源
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test("显式自动检测源语言覆盖全局固定源语言", async () => {
    // Given 用户全局设置源语言为英文
    const h = await setup({ default_source_language: "en" })
    global.fetch = jest.fn(async () => ms()) as typeof fetch
    // When 命令明确要求自动检测源语言
    await h.query("ms auto:ja hello")
    // Then 请求不再带全局固定的源语言
    const url = new URL((global.fetch as jest.Mock).mock.calls[0][0])
    expect(url.searchParams.has("from")).toBe(false)
  })

  test("不同查询同时完成时也不丢失历史", async () => {
    // Given 两次查询同时等待翻译
    const h = await setup()
    global.fetch = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return ms()
    }) as typeof fetch
    // When 两次查询接近同时完成
    await Promise.all([h.query("hello"), h.query("world")])
    // Then 两份历史均被保留
    expect(
      h
        .history()
        .map(entry => entry.sourceText)
        .sort()
    ).toEqual(["hello", "world"])
  })

  test.each(["end_turn", "max_tokens"])("Claude 流正确处理结束原因：%s", async reason => {
    // Given Claude 返回文本片段和明确的结束原因
    const h = await setup({ llm_provider_table: JSON.stringify([{ provider: "claude", apiKey: "offline-test", baseUrl: "https://example.invalid/v1", model: "offline-model" }]) })
    const payload = [{ type: "content_block_delta", delta: { type: "text_delta", text: "你好" } }, { type: "message_delta", delta: { stop_reason: reason } }, { type: "message_stop" }]
      .map(event => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("")
    const bytes = new TextEncoder().encode(payload)
    const split = new TextEncoder().encode(payload.slice(0, payload.indexOf("好"))).length + 1
    global.fetch = jest.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, split))
              controller.enqueue(bytes.slice(split))
              controller.close()
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    ) as typeof fetch
    // When 读取含有跨片段中文及 Windows 换行的流
    const result = await h.finish((await h.query("claude hello"))[0])
    // Then 正常完成保存完整译文而长度截断不缓存
    if (reason === "end_turn") expect(h.history()[0].translatedText).toBe("你好")
    else {
      expect(result.Title).toMatch(/incomplete/i)
      expect(h.history()).toHaveLength(0)
    }
  })

  test("结果已经失效时不启动新的付费请求", async () => {
    // Given 查询结果已不再接受新的占位项
    const h = await setup({ llm_provider_table: rows() })
    h.api.PushResults.mockResolvedValue(false)
    global.fetch = jest.fn(async () => sse("译文")) as typeof fetch
    // When 插件尝试启动大模型翻译
    const results = await h.query("openai hello")
    // Then 不发送请求且不写入历史
    expect(results).toHaveLength(0)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(h.history()).toHaveLength(0)
  })

  test("服务识别出的实际源语言纠正纯汉字日文的自动方向", async () => {
    // Given 本地字符规则将纯汉字日文误判为中文而服务识别为日文
    const h = await setup()
    global.fetch = jest.fn(async () => json([{ detectedLanguage: { language: "ja" }, translations: [{ text: "东京大学" }] }])) as typeof fetch
    // When 自动翻译后再次查询相同原文
    await h.query("東京大学", true)
    await h.query("東京大学", true)
    // Then 方向纠正为中文且第二次使用正确方向的历史
    const urls = (global.fetch as jest.Mock).mock.calls.map(call => new URL(call[0]))
    expect(urls).toHaveLength(2)
    expect(urls[1].searchParams.get("to")).toBe("zh-Hans")
    expect(h.history()).toHaveLength(1)
  })
})
