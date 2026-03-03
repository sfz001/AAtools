# Privacy Policy - AAtools

Last updated: 2026-02-27

## Overview

AAtools is a Chrome extension that provides AI-powered YouTube video summarization and cross-site text translation. This privacy policy explains how user data is handled.

## Data Collection

AAtools does **not** collect, store, or transmit any personal data to the developer or any third party.

## Data Stored Locally

The following data is stored locally on your device via `chrome.storage.sync` and IndexedDB:

- **API Keys**: Your Claude, OpenAI, and/or Gemini API keys (entered by you in the extension settings)
- **Preferences**: Selected AI provider, model, and custom prompt
- **Notion Settings**: Integration token and page ID (if configured)
- **Cached Results**: Previously generated summaries, notes, flashcards, mind maps, and vocabulary for each video

This data never leaves your browser except when sent directly to the AI service you selected.

## Third-Party API Calls

When you use AAtools, your video subtitle content or selected text is sent directly from your browser to the AI provider you selected:

- **Anthropic** (api.anthropic.com) — when using Claude
- **OpenAI** (api.openai.com) — when using OpenAI
- **Google** (generativelanguage.googleapis.com) — when using Gemini
- **Notion** (api.notion.com) — only when you explicitly export to Notion

These API calls are made directly from your browser using your own API keys. AAtools does not proxy, log, or intercept any of this data.

## Permissions

- **activeTab**: Access the current YouTube page to inject the panel and extract subtitles
- **storage**: Save your settings and API keys locally
- **scripting**: Execute a script on YouTube pages to read subtitle content from the DOM
- **Host permissions**: Make API calls to AI services and Notion as described above

## Remote Code

AAtools does not use any remote code. All JavaScript is bundled locally in the extension package.

## Changes

If this policy changes, the updated version will be posted at this URL.

## Contact

If you have questions, open an issue at https://github.com/sfz001/AAtools/issues
