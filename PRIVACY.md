# Privacy Policy - AAtools

Last updated: 2026-08-24

## Overview

AAtools is a Chrome extension that provides AI-powered YouTube video summarization, cross-site text translation, Xiaohongshu scroll-fix, and mouse gestures. This privacy policy explains how user data is handled.

## Data Collection

AAtools does **not** send your data to the extension developer and the developer operates no collection server. Data is transmitted only when needed for the browser/AI services described below (for example Chrome Sync and the provider you select).

## Data Storage

Non-sensitive preferences are stored via `chrome.storage.sync` and may be synchronized to your other Chrome profiles through your Google account. Credentials and cached results stay on the current device. Older releases stored YouTube results under the `youtube.com` page origin. For security, the current version never reads or imports values from that database and makes a best-effort request at startup to delete the dedicated old database without materializing its contents; after upgrading, the extension-owned cache starts empty. If an old page connection blocks deletion, close old YouTube tabs and reload to retry, or clear `youtube.com` site data in Chrome.

- **API Keys and ChatGPT authorization**: Stored only in `chrome.storage.local`, restricted to trusted extension pages and the service worker. They are not exposed to content scripts, synchronized, or included in settings exports. Existing keys from older releases are migrated out of `chrome.storage.sync` on upgrade. A custom-gateway key is additionally bound to its exact authorized origin; ambiguous cross-device settings conflicts disable credential-bearing requests until the settings are reviewed and saved again.
- **Preferences**: Selected AI provider, model, custom prompts, and feature toggles (e.g. mouse gestures), stored in `chrome.storage.sync`.
- **Cached Results**: Previously generated transcripts, summaries, notes, and mind maps for each video, stored in the extension's IndexedDB on the current device. They are retained until you use “Clear all local cache” in the settings page, clear extension data, or uninstall the extension. Cache persistence is disabled in Incognito; Incognito cache requests neither write to nor clear the normal-window cache.

This data never leaves your browser except when request content and the required credential are sent directly to the AI service you selected. Settings export files never contain API keys or ChatGPT authorization; older exported files that contain API keys can still be imported, and those keys are placed in local trusted storage.

When YouTube “video mode” is used, the canonical YouTube video URL is sent to Google Gemini so Google can retrieve and process the video's audio track for transcription. The extension instructs Gemini to ignore visual content, but the URL and Google's processing are still a third-party transfer. The resulting transcript may then be sent to the AI provider selected for the requested summary, note, mind map, or answer.

The translation overlay does not provide a free-form editable field in the host page. It can retranslate the current selection, and copying results is done only through the explicit clipboard button; this reduces exposure to host-page capture listeners.

## Third-Party API Calls

When you use AAtools, your video subtitle content or selected text is sent directly from your browser to the AI provider you selected:

- **Anthropic** (api.anthropic.com) — when using Claude
- **OpenAI** (api.openai.com) — when using OpenAI
- **OpenAI OAuth** (auth.openai.com) — when an expired ChatGPT subscription access token is refreshed with the refresh token you supplied
- **ChatGPT/Codex service** (chatgpt.com) — when using ChatGPT subscription mode; the access token, account identifier, prompt, and relevant subtitle/selected text are sent to this endpoint
- **Google** (generativelanguage.googleapis.com) — when using Gemini; in YouTube video mode this includes the YouTube video URL so Gemini can process its audio for transcription
- **MiniMax** (api.minimax.io) — when using MiniMax
- **DeepSeek** (api.deepseek.com) — when using DeepSeek
- **Moonshot AI** (api.moonshot.cn) — when using Kimi
- **A custom Sub2API gateway chosen by you** — only after you explicitly grant access to that gateway's domain

These API calls are made directly from your browser using your own API keys, except ChatGPT subscription mode, which uses the OAuth authorization that you provide. AAtools does not proxy, log, or intercept any of this data. Obsidian export generates a `.md` file locally and downloads it via the browser — nothing is uploaded.

## Permissions

- **storage**: Save your settings and API keys locally
- **scripting**: Execute a script on YouTube pages to read subtitle content from the DOM
- **sessions**: Restore the most recently closed tab via the mouse-gesture `←↑`
- **offscreen**: Run long AI streams, Gemini video transcription, and ChatGPT token refresh in a bundled hidden document/worker; it is closed after becoming idle and does not render user-facing content
- **Host permissions**: Required host permissions have no HTTP(S) wildcard and cover only the listed built-in AI services, ChatGPT authentication/service endpoints, and YouTube. Separately, the bundled translation and mouse-gesture content scripts are declared on HTTP(S) pages so those local user-interface features can run there; this does not grant the service worker required wildcard network access
- **Optional host permissions**: Access only the custom Sub2API gateway domain you explicitly authorize in settings; public gateways must use HTTPS (localhost may use HTTP)

When upgrading from a version that required broad HTTPS access, AAtools removes any retained optional `https://*/*` grant once. A saved custom gateway must then be authorized again for its exact origin. Chrome 140 or newer is required so local credential storage can be restricted to trusted extension contexts.

## Remote Code

AAtools does not use any remote code. All JavaScript is bundled locally in the extension package.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

If you have questions, open an issue at https://github.com/sfz001/AAtools/issues
