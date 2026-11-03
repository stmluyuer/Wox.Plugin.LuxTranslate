import { execFile } from "node:child_process"
import { ExecuteResultAction } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { DEFAULT_SETTINGS } from "../translate"
import { createSpeechPlayer, resolveDefaultSpeechPlayer } from "../speech"

jest.mock("node:child_process", () => ({
  execFile: jest.fn()
}))

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response
}

function createApi(settings: Record<string, string> = {}) {
  return {
    OnGetDynamicSetting: jest.fn(async () => undefined),
    PushResults: jest.fn(async () => true),
    UpdateResult: jest.fn(async () => true),
    GetSetting: jest.fn(async (_ctx, key: string) => settings[key] ?? ""),
    SaveSetting: jest.fn(async () => undefined),
    GetTranslation: jest.fn(async (_ctx, key: string) => key),
    Copy: jest.fn(async () => undefined),
    ChangeQuery: jest.fn(async () => undefined),
    Log: jest.fn(async () => undefined)
  }
}

const execFileMock = execFile as unknown as jest.Mock

function findExecuteAction(actions: unknown, name: string): ExecuteResultAction | undefined {
  return (actions as ExecuteResultAction[] | undefined)?.find(action => action.Name === name)
}

async function queryTranslation(settings: Record<string, string> = {}) {
  const api = createApi(settings)
  global.fetch = jest.fn(async () =>
    jsonResponse([
      {
        detectedLanguage: { language: "en" },
        translations: [{ text: "你好" }]
      }
    ])
  ) as typeof fetch

  await plugin.init({} as never, { API: api } as never)
  const results = await plugin.query({} as never, { Type: "input", Search: "hello" } as never)

  return { api, result: results.Results[0] }
}

describe("speech playback actions", () => {
  const originalFetch = global.fetch
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!

  beforeAll(() => {
    // These cases exercise Windows speech while CI itself runs on Linux.
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(process, "platform", originalPlatform)
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.clearAllMocks()
  })

  test("does not auto play speech when building translation results", async () => {
    const { result } = await queryTranslation({
      enable_speech_playback: "true"
    })

    expect(result.Actions?.map(action => action.Name)).toContain("action_play_translation")
    expect(execFile).not.toHaveBeenCalled()
  })

  test("plays the translated text only after clicking the play button", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null, "", ""))
    const { result } = await queryTranslation({
      enable_speech_playback: "true"
    })

    const playAction = findExecuteAction(result.Actions, "action_play_translation")
    await playAction?.Action({} as never, { ContextData: {} } as never)

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith("powershell.exe", expect.arrayContaining(["你好"]), expect.objectContaining({ windowsHide: true }), expect.any(Function))
  })

  test("does not add speech actions when speech playback is disabled", async () => {
    const { result } = await queryTranslation()

    expect(result.Actions?.map(action => action.Name)).not.toContain("action_play_translation")
    expect(execFile).not.toHaveBeenCalled()
  })

  test("defaults to Windows built-in speech playback on Windows", () => {
    expect(resolveDefaultSpeechPlayer("win32")).toBe("windows")
    expect(createSpeechPlayer("win32").kind).toBe("windows")
  })

  test("logs speech playback failures without removing the translation result", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(new Error("speech failed"), "", ""))
    const { api, result } = await queryTranslation({
      enable_speech_playback: "true"
    })

    const playAction = findExecuteAction(result.Actions, "action_play_translation")
    await expect(playAction?.Action({} as never, { ContextData: {} } as never)).resolves.toBeUndefined()

    expect(result.Title).toBe("Microsoft: 你好")
    expect(api.Log).toHaveBeenCalledWith(expect.anything(), "Error", expect.stringContaining("speech failed"))
  })
})

describe("speech settings", () => {
  test("keeps speech playback disabled by default", () => {
    expect(DEFAULT_SETTINGS.enableSpeechPlayback).toBe(false)
  })
})
