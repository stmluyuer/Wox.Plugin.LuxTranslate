# <img src="images/app.svg" alt="" width="36" height="36"> LuxTranslate

[English](README.en.md) | [中文](README.md)

> This plugin is still in beta and has not been fully tested. Sorry in advance for serious bugs; please report them through [GitHub Issues](https://github.com/stmluyuer/Wox.Plugin.LuxTranslate/issues), and I will fix them as soon as I can.

LuxTranslate is a translation plugin for [Wox](https://github.com/Wox-launcher/Wox). It uses the `tr` trigger keyword and chooses the direction from Wox's UI language and the configured pair language. With a Chinese UI, Chinese text defaults to English and other languages default to Chinese. You can also specify source and target languages explicitly.

[Download the beta](https://github.com/stmluyuer/Wox.Plugin.LuxTranslate/releases/latest) · [Report an issue](https://github.com/stmluyuer/Wox.Plugin.LuxTranslate/issues)

![Entering text and switching translation providers](screenshots/translation-demo.gif)

This 10-second demo uses Wox v2.4.7 + LuxTranslate v0.1.4: enter two related English sentences, view Microsoft's actual Chinese translation, then switch to Youdao; both translations are real responses from the services.

<details>
<summary>View the translation result</summary>

![Actual translation of two related sentences](screenshots/context-translation.png)

The preview displays the Chinese translation, full source text, and provider.

</details>

## Features

- Quick translation with `tr <text>` and Enter-to-copy result actions.
- Lightweight Chinese/English direction detection.
- Multiple providers displayed in the same query.
- Streaming LLM translations, with a clear warning for incomplete output.
- Translation history cache that changes with the model or endpoint, plus a Translate again action to bypass it.
- Optional preview details for source text, provider, and language direction.
- Provider settings grouped by category, with API keys, base URLs, and models configured from editable table rows.

## Providers

LuxTranslate groups providers into two categories:

| Category              | Providers                                                   |
| --------------------- | ----------------------------------------------------------- |
| No-setup translation  | Microsoft, Youdao, Caiyun                                   |
| Large language models | OpenAI, Claude, DeepSeek, custom OpenAI-compatible endpoint |

Notes:

- Microsoft uses the same no-setup signed translator endpoint pattern used by LunaTranslator. It is not an official Azure Translator API contract and may change.
- Youdao uses the signed desktop dictionary translation endpoint for lightweight lookups.
- Caiyun uses the web translator JWT flow: it obtains a temporary JWT before requesting a translation. The current implementation only supports Chinese or English target languages. This is intended for lightweight lookups, rather than the official API with a user-supplied token.
- OpenAI, DeepSeek, and custom LLM providers use the OpenAI-compatible chat completions format.
- Claude uses the Anthropic Messages API format.

## Installation

Requires **Wox 2.4.8 or later**. Search for **LuxTranslate** in the Wox plugin store, or download `wox.plugin.luxtranslate.wox` from [GitHub Releases](https://github.com/stmluyuer/Wox.Plugin.LuxTranslate/releases/latest) and open it with Wox. The current release is [v0.1.5](https://github.com/stmluyuer/Wox.Plugin.LuxTranslate/releases/tag/v0.1.5).

To build from source (current version: 0.1.5):

```bash
git clone https://github.com/stmluyuer/Wox.Plugin.LuxTranslate.git
cd Wox.Plugin.LuxTranslate
pnpm install
pnpm build
```

The build output is written to `dist/`. With Make installed, run `make package` to create `wox.plugin.luxtranslate.wox`; this command rebuilds the plugin and removes `dist/` after packaging.

## Usage

| Command             | Description                        |
| ------------------- | ---------------------------------- |
| `tr hello`          | Use selected providers, or the default |
| `tr 你好`           | Translate to English automatically |
| `tr ms hello`       | Force Microsoft                    |
| `tr youdao hello`   | Force Youdao                       |
| `tr caiyun hello`   | Force Caiyun                       |
| `tr openai hello`   | Force OpenAI                       |
| `tr claude hello`   | Force Claude                       |
| `tr deepseek hello` | Force DeepSeek                     |
| `tr custom hello`   | Force the custom LLM endpoint      |
| `tr ms en:ja hello` | Use Microsoft, English to Japanese |
| `tr history`        | Show recent translation history    |
| `tr history hello`  | Search translation history         |

### Tip

LuxTranslate works well with Wox's built-in quick query feature. Bind a hotkey to `tr {wox:selected_text}` to translate the currently selected text from any app without typing the query manually.

## Configuration

Release v0.1.4 selects multiple providers through Filters in the translation window (`Ctrl+F`, or `Cmd+F` on macOS).

Version 0.1.5 adds settings-page multi-select, sharing the selection with the translation window. Requires Wox 2.4.8 or later, which includes the multi-select fix ([PR #4644](https://github.com/Wox-launcher/Wox/pull/4644)).

- `Default provider`: used by normal `tr <text>` queries when no providers are selected.
- `Translation providers (multiple)` (0.1.5): the settings page and Filters in the translation window (`Ctrl+F`, or `Cmd+F` on macOS) share the same selection. Changes apply to the next query. Leave the selection empty to use the default provider, or choose “Use default provider” to clear it. Upgrading preserves the active filter selection; trial dropdown choices do not override it.
- `No-setup providers`: manage Microsoft, Youdao, and Caiyun-style providers.
- `Large language model providers`: configure API keys, base URLs, and model names for OpenAI, Claude, DeepSeek, or custom endpoints.
- `History limit`: keeps 10 entries by default.
- `Show source and provider details`: controls whether previews include source text, provider, and direction details.

Result actions include Translate again and switching providers; both preserve the original text and language direction. Selection queries treat the entire selection as literal text and preserve line breaks and indentation, including words such as `history`.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

Useful scripts:

- `pnpm test`: run Jest tests.
- `pnpm build`: run lint, format, and bundle to `dist/`.
- `pnpm run lint`: run ESLint.

## Screenshots

![Plugin basic settings](screenshots/settings-basic.jpg)

![Large language model provider settings](screenshots/settings-llm-table.jpg)

![Large language model row editor](screenshots/settings-llm-edit.jpg)

![Quick query tip](screenshots/quick-query-tip.jpg)

## AI Assistance Disclosure

This project was substantially generated, refactored, and tested with assistance from OpenAI Codex 5.5. The author was responsible for requirements, code review, validation, and release decisions.

## License

MIT License. See [LICENSE](LICENSE).
