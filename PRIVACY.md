# Privacy Policy - AAtools

Last updated: 2026-04-26

## Overview

AAtools is a Chrome extension that provides AI-powered YouTube video summarization, cross-site text translation, Xiaohongshu scroll-fix, and mouse gestures. This privacy policy explains how user data is handled.

## Data Collection

AAtools does **not** collect, store, or transmit any personal data to the developer or any third party.

## Data Storage

The following data is stored via `chrome.storage.sync` and IndexedDB. Note: `chrome.storage.sync` is **synchronized to your other Chrome profiles via your Google account** when you are signed in to Chrome — it is not strictly local. Cached results (IndexedDB) stay on the current device only.

- **API Keys**: Your Claude, OpenAI, Gemini, and/or MiniMax API keys (entered by you in the extension settings)
- **Preferences**: Selected AI provider, model, custom prompts, and feature toggles (e.g. mouse gestures)
- **Cached Results**: Previously generated summaries, notes, flashcards, mind maps, and vocabulary for each video

This data never leaves your browser except when sent directly to the AI service you selected.

## Third-Party API Calls

When you use AAtools, your video subtitle content or selected text is sent directly from your browser to the AI provider you selected:

- **Anthropic** (api.anthropic.com) — when using Claude
- **OpenAI** (api.openai.com) — when using OpenAI
- **Google** (generativelanguage.googleapis.com) — when using Gemini
- **MiniMax** (api.minimax.io) — when using MiniMax

These API calls are made directly from your browser using your own API keys. AAtools does not proxy, log, or intercept any of this data. Obsidian export generates a `.md` file locally and downloads it via the browser — nothing is uploaded.

## Permissions

- **activeTab**: Access the current YouTube page to inject the panel and extract subtitles
- **storage**: Save your settings and API keys locally
- **scripting**: Execute a script on YouTube pages to read subtitle content from the DOM
- **sessions**: Restore the most recently closed tab via the mouse-gesture `←↑`
- **Host permissions**: Make API calls to AI services as described above

## Remote Code

AAtools does not use any remote code. All JavaScript is bundled locally in the extension package.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

If you have questions, open an issue at https://github.com/sfz001/AAtools/issues
