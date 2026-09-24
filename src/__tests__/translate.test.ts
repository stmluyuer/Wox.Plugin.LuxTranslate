import {
  collapseExtraBlankLines,
  DEFAULT_SETTINGS,
  detectLanguage,
  getMissingConfiguration,
  historyKeyMatches,
  parseHistoryEntries,
  parseProviderList,
  parseProviderTableRows,
  parseTranslationQuery,
  resolveLanguageDirection,
  searchHistoryEntries,
  StreamCallbacks,
  translateWithCaiyun,
  translateWithDeepL,
  translateWithMicrosoft,
  translateWithClaude,
  translateWithClaudeStream,
  translateWithOpenAICompatible,
  translateWithOpenAICompatibleStream,
  translateWithYoudao,
  upsertHistoryEntry
} from "../translate"

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response
}

function firstFetchCall(fetchMock: jest.Mock): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit]
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

function caiyunEncrypt(plainText: string): string {
  const normalKey = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=.+-_/"
  const cipherKey = "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm0123456789=.+-_/"
  const map: Record<string, string> = {}
  for (let i = 0; i < normalKey.length; i++) {
    map[normalKey[i]] = cipherKey[i]
  }
  return Buffer.from(plainText, "utf8")
    .toString("base64")
    .split("")
    .map(char => map[char] ?? char)
    .join("")
}

describe("collapseExtraBlankLines", () => {
  test("collapses 3+ consecutive newlines to one", () => {
    expect(collapseExtraBlankLines("a\n\n\n\nb")).toBe("a\nb")
    expect(collapseExtraBlankLines("line1\n\n\n\n\nline2")).toBe("line1\nline2")
  })

  test("preserves single and double newlines", () => {
    expect(collapseExtraBlankLines("a\nb")).toBe("a\nb")
    expect(collapseExtraBlankLines("a\n\nb")).toBe("a\n\nb")
  })

  test("returns text without newlines unchanged", () => {
    expect(collapseExtraBlankLines("hello world")).toBe("hello world")
  })

  test("returns empty string unchanged", () => {
    expect(collapseExtraBlankLines("")).toBe("")
  })
})

describe("language detection (8 languages)", () => {
  test("detects Chinese via CJK", () => {
    expect(detectLanguage("你好世界")).toBe("zh")
    expect(detectLanguage("今天天气不错")).toBe("zh")
  })

  test("detects Japanese via Kana", () => {
    expect(detectLanguage("こんにちは")).toBe("ja")
    expect(detectLanguage("今日はいい天気ですね")).toBe("ja")
    expect(detectLanguage("私は中国人です")).toBe("ja")
  })

  test("detects Korean via Hangul", () => {
    expect(detectLanguage("안녕하세요")).toBe("ko")
    expect(detectLanguage("감사합니다")).toBe("ko")
  })

  test("detects Russian via Cyrillic", () => {
    expect(detectLanguage("Привет")).toBe("ru")
    expect(detectLanguage("Здравствуйте как дела")).toBe("ru")
  })

  test("detects Arabic via Arabic script", () => {
    expect(detectLanguage("مرحبا")).toBe("ar")
    expect(detectLanguage("كيف حالك")).toBe("ar")
  })

  test("detects German via specific chars", () => {
    expect(detectLanguage("schön und großartig")).toBe("de")
    expect(detectLanguage("für die Prüfung")).toBe("de")
  })

  test("detects French via specific chars", () => {
    expect(detectLanguage("Bonjour ça va")).toBe("fr")
    expect(detectLanguage("très bien merci")).toBe("fr")
  })

  test("detects English as default for Latin text", () => {
    expect(detectLanguage("hello world")).toBe("en")
    expect(detectLanguage("this is a test")).toBe("en")
  })

  test("returns English for empty/symbol text", () => {
    expect(detectLanguage("123")).toBe("en")
    expect(detectLanguage("")).toBe("en")
  })
})

describe("resolveLanguageDirection (8 languages)", () => {
  test("translates non-Wox language to Wox language", () => {
    const dir = resolveLanguageDirection("привет мир", "auto", "zh")
    expect(dir.sourceLanguage).toBe("auto")
    expect(dir.targetLanguage).toBe("zh")
    expect(dir.targetLabel).toBe("Chinese")
  })

  test("translates Wox language to paired language", () => {
    const dir = resolveLanguageDirection("你好世界", "auto", "zh")
    expect(dir.sourceLanguage).toBe("auto")
    expect(dir.targetLanguage).toBe("en")
    expect(dir.targetLabel).toBe("English")
  })

  test("can honor a fixed target through the pair language", () => {
    const dir = resolveLanguageDirection("hello", "zh", "zh", "zh")
    expect(dir.targetLanguage).toBe("zh")
    expect(dir.targetLabel).toBe("Chinese")
  })

  test("uses explicit source language", () => {
    const dir = resolveLanguageDirection("hello", "zh", "en")
    expect(dir.sourceLanguage).toBe("zh")
    expect(dir.targetLanguage).toBe("en")
  })

  test("returns correct Microsoft target codes", () => {
    expect(resolveLanguageDirection("你好", "auto", "zh").microsoftTarget).toBe("en")
    expect(resolveLanguageDirection("hello", "auto", "zh").microsoftTarget).toBe("zh-Hans")
    expect(resolveLanguageDirection("こんにちは", "auto", "zh").microsoftTarget).toBe("zh-Hans")
  })

  test("returns correct DeepL target codes", () => {
    expect(resolveLanguageDirection("안녕", "auto", "zh").deeplTarget).toBe("ZH")
    expect(resolveLanguageDirection("hello", "auto", "ko").deeplTarget).toBe("KO")
  })
})

describe("query parsing", () => {
  test("uses default provider when no provider command is present", () => {
    expect(parseTranslationQuery("hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      forcedProvider: false
    })
  })

  test("parses provider commands", () => {
    expect(parseTranslationQuery("ms hello", "deepl")).toMatchObject({ provider: "microsoft", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("deepl hello", "microsoft")).toMatchObject({ provider: "deepl", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("ai hello", "microsoft")).toMatchObject({ provider: "microsoft", text: "ai hello", forcedProvider: false })
    expect(parseTranslationQuery("openai hello", "microsoft")).toMatchObject({ provider: "openai", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("claude hello", "microsoft")).toMatchObject({ provider: "claude", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("deepseek hello", "microsoft")).toMatchObject({ provider: "deepseek", text: "hello", forcedProvider: true })
    expect(parseTranslationQuery("custom hello", "microsoft")).toMatchObject({ provider: "llm_custom", text: "hello", forcedProvider: true })
  })

  test("parses target language from bare code", () => {
    expect(parseTranslationQuery("zh hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      targetLanguage: "zh",
      forcedProvider: false
    })
    expect(parseTranslationQuery("en hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "en"
    })
    expect(parseTranslationQuery("ja hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "ja"
    })
  })

  test("parses source:target language spec", () => {
    expect(parseTranslationQuery("en:zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      sourceLanguage: "en",
      targetLanguage: "zh"
    })
    expect(parseTranslationQuery("ja:en こんにちは", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "こんにちは",
      sourceLanguage: "ja",
      targetLanguage: "en"
    })
  })

  test("parses auto:zh and :zh syntax", () => {
    expect(parseTranslationQuery("auto:zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh",
      sourceLanguage: undefined
    })
    expect(parseTranslationQuery(":zh hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh"
    })
  })

  test("parses provider + target language combo", () => {
    expect(parseTranslationQuery("ms zh hello", "deepl")).toMatchObject({
      provider: "microsoft",
      text: "hello",
      targetLanguage: "zh",
      forcedProvider: true
    })
    expect(parseTranslationQuery("deepl en:ja hello world", "microsoft")).toMatchObject({
      provider: "deepl",
      text: "hello world",
      sourceLanguage: "en",
      targetLanguage: "ja",
      forcedProvider: true
    })
  })

  test("ignores non-language words as target spec", () => {
    expect(parseTranslationQuery("hello world", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello world",
      targetLanguage: undefined
    })
    expect(parseTranslationQuery("xx hello", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "xx hello",
      targetLanguage: undefined
    })
  })

  test("preserves newlines in text portion", () => {
    expect(parseTranslationQuery("hello\nworld\n\ntest", "microsoft")).toMatchObject({
      provider: "microsoft",
      text: "hello\nworld\n\ntest",
      forcedProvider: false
    })
    expect(parseTranslationQuery("ms zh line1\nline2\n\nline3", "deepl")).toMatchObject({
      provider: "microsoft",
      text: "line1\nline2\n\nline3",
      targetLanguage: "zh",
      forcedProvider: true
    })
  })

  test("parses visible provider lists", () => {
    expect(parseProviderList("microsoft,openai,deepseek,openai")).toEqual(["microsoft", "openai", "deepseek"])
    expect(parseProviderList(JSON.stringify(["deepl", "unknown"]))).toEqual(["deepl"])
    expect(parseProviderList("")).toEqual([])
  })

  test("parses provider configuration rows", () => {
    const rows = [{ provider: "microsoft" }, { provider: "openai", apiKey: "openai-key", baseUrl: "https://example.com/v1", model: "model-a" }, { provider: "unknown" }]
    expect(parseProviderTableRows(JSON.stringify(rows))).toHaveLength(2)
    expect(parseProviderTableRows(JSON.stringify(rows))[1]).toMatchObject({ provider: "openai", apiKey: "openai-key", baseUrl: "https://example.com/v1", model: "model-a" })
  })
})

describe("configuration checks", () => {
  test("reports missing provider settings", () => {
    expect(getMissingConfiguration("microsoft", DEFAULT_SETTINGS)).toBeNull()
    expect(getMissingConfiguration("deepl", DEFAULT_SETTINGS)).toContain("DeepL API key")
    expect(getMissingConfiguration("openai", DEFAULT_SETTINGS)).toContain("API key")
  })
})

describe("translation history", () => {
  test("parses, searches, upserts, and matches history entries", () => {
    const direction = resolveLanguageDirection("hello", "auto", "zh")
    const firstEntry = {
      sourceText: "hello",
      translatedText: "你好",
      provider: "microsoft" as const,
      providerName: "Microsoft",
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      timestamp: 1
    }
    const secondEntry = {
      ...firstEntry,
      sourceText: "world",
      translatedText: "世界",
      timestamp: 2
    }

    const entries = upsertHistoryEntry(upsertHistoryEntry([], firstEntry, 10), secondEntry, 1)
    expect(entries).toEqual([secondEntry])
    expect(searchHistoryEntries([firstEntry, secondEntry], "hell")).toEqual([firstEntry])
    expect(parseHistoryEntries(JSON.stringify([firstEntry]))).toEqual([firstEntry])
    expect(historyKeyMatches(firstEntry, "microsoft", "hello", direction)).toBe(true)
  })
})

describe("provider requests", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  test("calls Microsoft no-setup endpoint and parses response", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse([
        {
          detectedLanguage: { language: "en" },
          translations: [{ text: "你好" }]
        }
      ])
    )
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithMicrosoft({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toContain("api.cognitive.microsofttranslator.com/translate")
    expect(headersOf(init)["X-MT-Signature"]).toContain("MSTranslatorAndroidApp::")
    expect(headersOf(init).Authorization).toBeUndefined()
    expect(init.body).toBe(JSON.stringify([{ Text: "hello" }]))
    expect(result.translatedText).toBe("你好")
    expect(result.detectedSourceLanguage).toBe("en")
  })

  test("passes explicit source language to Microsoft endpoint", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse([
        {
          translations: [{ text: "world-translated" }]
        }
      ])
    )
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithMicrosoft({
      text: "world",
      direction: resolveLanguageDirection("world", "en", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url] = firstFetchCall(fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(url).toContain("from=en")
    expect(result.translatedText).toBe("world-translated")
  })

  test("calls DeepL free endpoint with auth header and target language", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ translations: [{ detected_source_language: "EN", text: "你好" }] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithDeepL({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: { ...DEFAULT_SETTINGS, deeplApiKey: "secret" }
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toBe("https://api-free.deepl.com/v2/translate")
    expect(headersOf(init).Authorization).toBe("DeepL-Auth-Key secret")
    expect(JSON.parse(init.body as string).target_lang).toBe("ZH")
    expect(result.translatedText).toBe("你好")
  })

  test("calls OpenAI-compatible chat completions endpoint", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ choices: [{ message: { content: "你好" } }] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithOpenAICompatible({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://example.com/v1/", openaiModel: "model-a" }
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toBe("https://example.com/v1/chat/completions")
    expect(headersOf(init).Authorization).toBe("Bearer token")
    expect(JSON.parse(init.body as string).model).toBe("model-a")
    expect(result.translatedText).toBe("你好")
  })

  test("calls Claude messages endpoint", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ content: [{ type: "text", text: "你好" }] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithClaude({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://api.anthropic.com/v1/", openaiModel: "claude-test" }
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    expect(headersOf(init)["x-api-key"]).toBe("token")
    expect(JSON.parse(init.body as string).model).toBe("claude-test")
    expect(result.translatedText).toBe("你好")
  })

  test("calls Youdao no-setup endpoint", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ translateResult: [[{ tgt: "你好" }]] }))
    global.fetch = fetchMock as typeof fetch

    const result = await translateWithYoudao({
      text: "hello",
      direction: resolveLanguageDirection("hello", "auto", "zh"),
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = firstFetchCall(fetchMock)
    expect(url).toContain("dict.youdao.com/dicttranslate")
    expect(init.method).toBe("POST")
    expect(init.body).toBe("i=hello")
    expect(result.translatedText).toBe("你好")
  })

  test("calls Caiyun no-setup translator endpoint", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({ jwt: "jwt-token" }))
      .mockResolvedValueOnce(jsonResponse({}, 204))
      .mockResolvedValueOnce(jsonResponse({ target: caiyunEncrypt("你好"), rc: 0 }))
    global.fetch = fetchMock as typeof fetch

    const direction = resolveLanguageDirection("hello", "auto", "zh")
    const result = await translateWithCaiyun({
      text: "hello",
      direction,
      settings: DEFAULT_SETTINGS
    })

    const [url, init] = fetchMock.mock.calls[3] as [string, RequestInit]
    expect(url).toBe("https://api.interpreter.caiyunai.com/v1/translator")
    expect(headersOf(init)["X-Authorization"]).toContain("token:")
    expect(headersOf(init)["T-Authorization"]).toBe("jwt-token")
    const body = JSON.parse(init.body as string)
    expect(body.source).toBe("hello")
    expect(body.trans_type).toBe("auto2zh")
    expect(body.detect).toBe(true)
    expect(result.translatedText).toBe("你好")
    expect(result.providerName).toBe("Caiyun")
  })

  test("rejects unsupported Caiyun target languages", async () => {
    global.fetch = jest.fn() as typeof fetch

    await expect(
      translateWithCaiyun({
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "ja"),
        settings: DEFAULT_SETTINGS
      })
    ).rejects.toThrow("Caiyun only supports Chinese and English target languages.")
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test("surfaces provider failures", async () => {
    global.fetch = jest.fn(async () => jsonResponse({ error: "bad key" }, 403)) as typeof fetch

    await expect(
      translateWithDeepL({
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, deeplApiKey: "bad" }
      })
    ).rejects.toThrow("403")
  })
})

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
  return {
    ok: true,
    status: 200,
    body: stream
  } as unknown as Response
}

function sseErrorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    body: null,
    text: async () => JSON.stringify(body)
  } as unknown as Response
}

describe("streaming translation", () => {
  const originalFetch = global.fetch
  let tokens: string[]
  let completed: string | null
  let errors: Error[]
  let callbacks: StreamCallbacks

  beforeEach(() => {
    tokens = []
    completed = null
    errors = []
    callbacks = {
      onToken: (token: string) => {
        tokens.push(token)
      },
      onComplete: (fullText: string) => {
        completed = fullText
      },
      onError: (error: Error) => {
        errors.push(error)
      }
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  test("streams OpenAI SSE tokens and completes", async () => {
    const fetchMock = jest.fn(async () =>
      sseResponse(['data: {"id":"1","choices":[{"delta":{"content":"你好"},"index":0}]}\n\n', 'data: {"id":"1","choices":[{"delta":{"content":"世界"},"index":0}]}\n\n', "data: [DONE]\n\n"])
    )
    global.fetch = fetchMock as typeof fetch

    await translateWithOpenAICompatibleStream(
      {
        text: "hello world",
        direction: resolveLanguageDirection("hello world", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://example.com/v1", openaiModel: "model-a" }
      },
      "OpenAI",
      callbacks
    )

    expect(tokens).toEqual(["你好", "世界"])
    expect(completed).toBe("你好世界")
    expect(errors).toHaveLength(0)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://example.com/v1/chat/completions")
    const body = JSON.parse(init.body as string)
    expect(body.stream).toBe(true)
    expect(body.model).toBe("model-a")
  })

  test("streams Claude SSE tokens and completes", async () => {
    const fetchMock = jest.fn(async () =>
      sseResponse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ])
    )
    global.fetch = fetchMock as typeof fetch

    await translateWithClaudeStream(
      {
        text: "hello world",
        direction: resolveLanguageDirection("hello world", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://api.anthropic.com/v1", openaiModel: "claude-test" }
      },
      callbacks
    )

    expect(tokens).toEqual(["你好", "世界"])
    expect(completed).toBe("你好世界")
    expect(errors).toHaveLength(0)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.anthropic.com/v1/messages")
    const body = JSON.parse(init.body as string)
    expect(body.stream).toBe(true)
  })

  test("reports error when fetch fails with non-ok status", async () => {
    const fetchMock = jest.fn(async () => sseErrorResponse(401, { error: "invalid key" }))
    global.fetch = fetchMock as typeof fetch

    await translateWithOpenAICompatibleStream(
      {
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, openaiApiKey: "bad", openaiBaseUrl: "https://example.com/v1", openaiModel: "model" }
      },
      "OpenAI",
      callbacks
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("401")
    expect(completed).toBeNull()
  })

  test("handles empty SSE stream gracefully", async () => {
    const fetchMock = jest.fn(async () => sseResponse(["data: [DONE]\n\n"]))
    global.fetch = fetchMock as typeof fetch

    await translateWithOpenAICompatibleStream(
      {
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://example.com/v1", openaiModel: "model" }
      },
      "OpenAI",
      callbacks
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("empty translation")
  })

  test("handles per-chunk timeout in SSE stream", async () => {
    const fetchMock = jest.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":"1","choices":[{"delta":{"content":"hello"},"index":0}]}\n\n'))
        }
      })
      return { ok: true, status: 200, body: stream } as unknown as Response
    })
    global.fetch = fetchMock as typeof fetch

    await translateWithOpenAICompatibleStream(
      {
        text: "hello",
        direction: resolveLanguageDirection("hello", "auto", "zh"),
        settings: { ...DEFAULT_SETTINGS, openaiApiKey: "token", openaiBaseUrl: "https://example.com/v1", openaiModel: "model", requestTimeoutMs: 50 }
      },
      "OpenAI",
      callbacks
    )

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("timed out")
  })
})

describe("streaming regressions", () => {
  const originalFetch = global.fetch
  const request = {
    text: "hello",
    direction: resolveLanguageDirection("hello", "auto", "zh"),
    settings: { ...DEFAULT_SETTINGS, openaiApiKey: "test", requestTimeoutMs: 50 }
  }
  const providers = [
    {
      name: "OpenAI",
      run: (callbacks: StreamCallbacks) => translateWithOpenAICompatibleStream(request, "OpenAI", callbacks),
      token: (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
    },
    {
      name: "Claude",
      run: (callbacks: StreamCallbacks) => translateWithClaudeStream(request, callbacks),
      token: (text: string) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`
    }
  ]

  afterEach(() => {
    global.fetch = originalFetch
    jest.useRealTimers()
  })

  test.each(providers)("$name awaits token and completion callbacks in order", async ({ run, token }) => {
    global.fetch = jest.fn(async () => sseResponse([token("A") + token("B")]))
    const events: string[] = []
    const onError = jest.fn()
    await run({
      onToken: async value => {
        await new Promise(resolve => setTimeout(resolve, 5))
        events.push(value)
      },
      onComplete: async value => {
        await new Promise(resolve => setTimeout(resolve, 5))
        events.push(`done:${value}`)
      },
      onError
    })
    expect(events).toEqual(["A", "B", "done:AB"])
    expect(onError).not.toHaveBeenCalled()
  })

  test.each(providers)("$name reports async callback rejection and cancels the stream", async ({ run, token }) => {
    const cancel = jest.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(token("A") + token("B")))
      },
      cancel
    })
    global.fetch = jest.fn(async () => ({ ok: true, body }) as Response)
    const onComplete = jest.fn()
    const onError = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    const failure = new SyntaxError("result no longer visible")
    await run({
      onToken: async () => {
        throw failure
      },
      onComplete,
      onError
    })
    expect(onError).toHaveBeenCalledWith(failure)
    expect(onComplete).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  test.each(providers)("$name times out while waiting for headers", async ({ run }) => {
    jest.useFakeTimers()
    let signal: AbortSignal | null | undefined
    global.fetch = jest.fn((_url, init) => {
      signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true })
      })
    })
    const onError = jest.fn()
    const onComplete = jest.fn()
    const pending = run({ onToken: jest.fn(), onComplete, onError })
    await jest.advanceTimersByTimeAsync(50)
    expect(signal?.aborted).toBe(true)
    await pending
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onComplete).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  test.each(providers)("$name allows continued output beyond the header timeout", async ({ run, token }) => {
    jest.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let signal: AbortSignal | null | undefined
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      }
    })
    global.fetch = jest.fn(async (_url, init) => {
      signal = init?.signal
      return { ok: true, body } as Response
    })
    const onComplete = jest.fn()
    const onError = jest.fn()
    const pending = run({ onToken: jest.fn(), onComplete, onError })
    for (const value of ["A", "B", "C"]) {
      await jest.advanceTimersByTimeAsync(30)
      controller.enqueue(new TextEncoder().encode(token(value)))
    }
    controller.close()
    await pending
    expect(signal?.aborted).toBe(false)
    expect(onComplete).toHaveBeenCalledWith("ABC")
    expect(onError).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  test.each(["\n\n", ""])("OpenAI rejects a mid-stream error, including trailing data (%j)", async ending => {
    global.fetch = jest.fn(async () =>
      sseResponse([providers[0].token("partial"), `data: ${JSON.stringify({ error: { message: "upstream failed" }, choices: [{ delta: {}, finish_reason: "error" }] })}${ending}`])
    )
    const onComplete = jest.fn()
    const onError = jest.fn()
    await providers[0].run({ onToken: jest.fn(), onComplete, onError })
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "OpenAI returned an error: upstream failed" }))
  })
})
