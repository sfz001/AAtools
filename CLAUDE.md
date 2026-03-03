# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAtools** — 自用 Chrome 扩展（Manifest V3），两大核心功能：① YouTube 视频 AI 助手（总结/笔记/问答/卡片/导图/词汇提取）② 全网划词翻译。支持 Claude / OpenAI / Gemini 三个 API 提供商，无字幕视频可通过 Gemini 视频模式分析。

**技术栈**: 原生 HTML/CSS/JS，零依赖，无构建步骤。

## Development

没有构建、lint 或测试命令。开发流程：

1. `chrome://extensions/` → 开启开发者模式 → 加载已解压的扩展程序（选择项目根目录）
2. 修改代码后在扩展页点击刷新图标，然后刷新 YouTube 页面
3. 修改 `background.js` 后需要在扩展页重新加载 Service Worker

## Architecture

### 双层通信模型

```
YouTube 页面 (content scripts)          Service Worker
┌────────────────────────────┐    chrome.runtime    ┌──────────────┐
│  src/*.js → YTX 命名空间    │ ◄──── sendMessage ──► │ background.js│
│  panel.js (消息路由 + UI)   │     (流式分段转发)     │ (API 调用)   │
└────────────────────────────┘                       └──────────────┘
```

- **content scripts → background**: 通过 `chrome.runtime.sendMessage` 发送请求（如 `SUMMARIZE`、`CHAT_ASK`）
- **background → content scripts**: 通过 `chrome.tabs.sendMessage` 流式转发 `{PREFIX}_CHUNK` / `{PREFIX}_DONE` / `{PREFIX}_ERROR`
- panel.js 中的消息路由按前缀（`SUMMARY`、`HTML`、`CARDS` 等）分发到对应 `YTX.features[key]`

### 全局命名空间 `YTX`

所有 content scripts 共享 `var YTX` 全局对象（`src/core.js` 中定义）。各功能模块注册到 `YTX.features` 对象：

- `YTX.features.summary` — 总结（流式 Markdown 渲染）
- `YTX.features.html` — HTML 笔记（iframe srcdoc 隔离渲染）
- `YTX.features.chat` — 多轮问答（保留最近 40 条消息）
- `YTX.features.cards` — 知识卡片（JSON 解析 → 可翻转闪卡）
- `YTX.features.mindmap` — 思维导图（JSON 解析 → SVG 引擎渲染，支持缩放/平移/折叠）
- `YTX.features.vocab` — 词汇提取（JSON 解析 → 列表渲染）

### 功能模块接口

每个 feature 必须实现统一接口：
- `tab`, `prefix`, `contentId`, `actionsId`, `displayMode` — 标签与 DOM 标识
- `reset()`, `actionsHtml()`, `contentHtml()`, `bindEvents(panel)` — 生命周期
- `start()` — 启动生成（调用 `YTX.ensureTranscript()` 获取字幕，然后发消息到 background）
- `onChunk(text)`, `onDone()`, `onError(error)` — 流式回调

加载顺序由 `manifest.json` 中 `content_scripts.js` 数组决定，`panel.js` 必须最后加载。`YTX.featureOrder` 数组控制标签页排列顺序。

### 字幕获取流程

1. content script 发送 `FETCH_TRANSCRIPT` 到 background
2. background 通过 `chrome.scripting.executeScript` 在 MAIN world 执行 DOM 抓取
3. 依次尝试：描述区转录按钮 → "..." 菜单 → 暴力搜索
4. 从 `ytd-transcript-renderer` DOM 中解析时间戳和文本
5. 失败时若有 Gemini Key，启用视频模式：调用 Gemini API 分析视频 URL 生成虚拟字幕

### 多 Provider 支持

`background.js` 中 `callProvider()` 统一处理三家 API 的流式调用：
- Claude: `api.anthropic.com/v1/messages`（SSE，`content_block_delta`）
- OpenAI: `api.openai.com/v1/chat/completions`（SSE，`choices[0].delta.content`）
- Gemini: `generativelanguage.googleapis.com` streamGenerateContent（SSE，`candidates[0].content.parts[0].text`）

### 关键约定

- 所有 prompt 常量集中在 `src/prompts.js`，用 `{transcript}` 占位符插入字幕
- 字幕截断保护：`YTX.TRANSCRIPT_MAX_CHARS = 60000`（约 15k tokens）
- JSON 输出解析使用 `YTX.extractJSON(text, 'array'|'object')`，自动剥离 markdown 围栏
- 结果缓存到 IndexedDB（`AAtoolsCache`），切换视频时自动恢复
- 导出功能统一在 `src/export.js`（Markdown 下载 / HTML→Notion blocks / 导图→Notion blocks）
- YouTube SPA 适配：监听 `yt-navigate-finish` 事件
- 面板注入位置：YouTube 右侧栏 `#secondary` 最前面
- 所有 AI 输出默认要求简体中文
