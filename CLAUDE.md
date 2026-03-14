# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAtools** — 自用 Chrome 扩展（Manifest V3），三大核心功能：

1. **YouTube 视频 AI 助手** — 总结/笔记/问答/卡片/导图/词汇提取
2. **全网划词翻译** — 选词即译，字典/句段双模式
3. **小红书体验增强** — 帖子弹窗滚动修复

支持 Claude / OpenAI / Gemini / MiniMax 四个 API 提供商，无字幕视频可通过 Gemini 视频模式分析。

**技术栈**: 原生 HTML/CSS/JS，零依赖，无构建步骤。

## 目录结构

```
AAtools/
├── youtube/          ← YouTube 视频助手模块
│   ├── core.js          YTX 命名空间、共享状态、工具函数
│   ├── prompts.js       默认 Prompt 模板
│   ├── markdown.js      Markdown 渲染
│   ├── export.js        Notion / Gist 导出
│   ├── summary.js       总结功能
│   ├── html-notes.js    HTML 笔记
│   ├── chat.js          问答
│   ├── cards.js         知识卡片
│   ├── mindmap.js       思维导图
│   ├── vocab.js         词汇提取
│   ├── panel.js         面板 UI + 消息路由（必须最后加载）
│   └── content.css      面板样式
├── translate/        ← 划词翻译模块
│   ├── translate.js     翻译功能（独立 IIFE，不依赖 YTX）
│   └── translate.css    翻译弹窗样式
├── xhs/              ← 小红书增强模块
│   └── xhs-scroll-fix.js  帖子弹窗滚动修复
├── background.js     ← Service Worker（API 调用，三模块共用）
├── options.html/js/css ← 设置页
├── icons/            ← 扩展图标
└── manifest.json
```

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
│  youtube/*.js → YTX 命名空间│ ◄──── sendMessage ──► │ background.js│
│  panel.js (消息路由 + UI)   │     (流式分段转发)     │ (API 调用)   │
└────────────────────────────┘                       └──────────────┘
```

- **content scripts → background**: 通过 `chrome.runtime.sendMessage` 发送请求（如 `SUMMARIZE`、`CHAT_ASK`）
- **background → content scripts**: 通过 `chrome.tabs.sendMessage` 流式转发 `{PREFIX}_CHUNK` / `{PREFIX}_DONE` / `{PREFIX}_ERROR`
- 流式开始前发送 `{PREFIX}_MODEL` 消息通知 content script 当前使用的 provider 和 model（显示模型徽章）
- panel.js 中的消息路由用正则 `/^(.+?)_(CHUNK|DONE|ERROR)$/` 解析前缀，分发到 `YTX.features[key]`
- 所有流式 handler 立即返回 `{ started: true }` 并 `return true` 保持消息通道

### 消息类型完整列表

| content → background | 前缀 | 说明 |
|---|---|---|
| `FETCH_TRANSCRIPT` | — | 同步返回字幕数据 |
| `SUMMARIZE` | `SUMMARY` | 总结 |
| `GENERATE_HTML` | `HTML` | HTML 笔记 |
| `GENERATE_CARDS` | `CARDS` | 知识卡片 |
| `GENERATE_MINDMAP` | `MINDMAP` | 思维导图 |
| `GENERATE_VOCAB` | `VOCAB` | 词汇提取 |
| `CHAT_ASK` | `CHAT` | 问答 |
| `TRANSCRIBE_VIDEO` | `TRANSCRIBE` | 视频转录（特殊：`PROGRESS`/`CHUNK`/`SEGMENT`） |
| `TRANSLATE` | `TRANSLATE` | 划词翻译 |
| `EXPORT_NOTION` | — | 同步返回 |
| `UPLOAD_GIST` | — | 同步返回 |

### 全局命名空间 `YTX`

所有 YouTube content scripts 共享 `var YTX` 全局对象（`youtube/core.js` 中定义）。关键状态：

- `YTX.panel` — 注入的面板 DOM 元素
- `YTX.currentVideoId` — 当前视频 ID
- `YTX.transcriptData` — `{ segments, full, truncated }`，null 表示未获取
- `YTX.videoMode` — 是否使用 Gemini 视频模式
- `YTX.isFetchingTranscript` — 正在获取字幕时为 true，禁止生成操作
- `YTX.features` — 功能模块注册表
- `YTX.featureOrder` — 标签页排列顺序：`['summary', 'mindmap', 'html', 'cards', 'vocab', 'chat']`

关键工具函数：

- `YTX.getSettings()` — 返回 Promise，自动从当前 provider 推导 `activeKey` 和 `model`
- `YTX.ensureTranscript()` — 获取字幕的统一入口，有缓存则直接返回，失败自动回退 Gemini 视频模式
- `YTX.getContentPayload()` — 返回 `{ transcript }` 用于发送到 background
- `YTX.sendToBg(message)` — Promise 包装的 `chrome.runtime.sendMessage`，所有 feature 用它与 background 通信
- `YTX.extractJSON(text, 'array'|'object')` — 健壮的 JSON 提取，6 层回退策略（直接解析 → 去尾逗号 → 修复控制字符 → 组合修复 → 截断到最后完整 `}` → 截断后再修复）
- `YTX.generateAll()` — 并行生成所有功能（chat 除外），临时 patch 每个 feature 的 `onDone`/`onError` 为 Promise resolve
- `YTX.fmtTime(seconds)` / `YTX.timeToSeconds(str)` — 时间格式转换
- `YTX.btnRefresh(btn)` / `YTX.btnPrimary(btn, icon)` — 按钮状态切换

### 功能模块接口

每个 feature 必须实现统一接口：

```js
YTX.features.KEY = {
  // 标识
  tab: { key, label, icon },  prefix,  contentId,  actionsId,  displayMode,
  // 状态
  isGenerating: false,
  // 生命周期（panel.js 调用）
  reset(), actionsHtml(), contentHtml(), bindEvents(panel),
  // 生成（start 内部调用 YTX.ensureTranscript → getSettings → sendMessage）
  async start(),
  // 流式回调（panel.js 消息路由调用）
  onChunk(text), onDone(), onError(error),
};
```

`start()` 模式：设 `isGenerating=true` → 禁用按钮显示 spinner → `ensureTranscript()` → `getSettings()` → `sendMessage` 到 background → 等待流式回调。`isGenerating` 在 `onDone`/`onError` 中才置回 false。

`onChunk` 差异：summary 用 80ms 节流批量渲染，chat 实时渲染，mindmap/cards/vocab 仅累积原始文本在 `onDone` 中一次性 `extractJSON` + 渲染。

加载顺序由 `manifest.json` 中 `content_scripts.js` 数组决定，`panel.js` 必须最后加载（它在顶部构建 `prefixMap`）。

### `callProvider()` — API 调用核心

`background.js` 中统一处理四家 API 的流式调用：

- **模型验证**: `sanitizeModel(provider, model)` 检查模型前缀（`claude-`/`gpt-`/`gemini-`/`minimax-`），不匹配则静默回退到默认模型
- **SSE 解析**: 统一由 `readSSEStream()` 处理，按 provider 提取文本：
  - Claude: `content_block_delta` → `delta.text`，`message_stop` 结束
  - OpenAI: `choices[0].delta.content`，`[DONE]` 行结束
  - Gemini: `candidates[0].content.parts[0].text`，流结束即完成
- **防重复**: `doneSent` 标志防止重复发送 `{PREFIX}_DONE`
- **安全发送**: `safeSend(tabId, msg)` 包裹 try/catch + `.catch(() => {})`，tab 关闭不会崩溃
- **错误分类**: `classifyApiError()` 将 HTTP 状态码映射为中文提示（401→Key 无效，429+quota→余额不足，400+token→内容太长）
- **SW 保活**: `startKeepalive()` 每 20 秒 ping 一次防止 Service Worker 被杀（视频转录时使用）

### 字幕获取流程

1. content script 发送 `FETCH_TRANSCRIPT` 到 background
2. background 通过 `chrome.scripting.executeScript` 在 MAIN world 执行 DOM 抓取
3. 依次尝试：描述区转录按钮 → "..." 菜单 → 暴力搜索
4. 从 `ytd-transcript-renderer` DOM 中解析时间戳和文本
5. 失败时若有 Gemini Key，启用视频模式：调用 Gemini API（固定使用 `gemini-flash-lite-latest`，忽略用户模型选择）分析视频 URL 生成虚拟字幕
6. 字幕截断保护：`YTX.TRANSCRIPT_MAX_CHARS = 200000`

### 划词翻译（`translate/translate.js`）

完全独立于 YTX 命名空间的 IIFE，运行在所有页面（`<all_urls>`）。

- **字典/句段模式判定**（background.js 和 translate.js 各有一份相同逻辑）：CJK ≤4 字符或 Latin ≤3 单词走字典格式，否则走纯翻译
- **语境查词**: 在翻译弹窗的原文区选中某词，自动带全文语境发送到 background
- **iframe 支持**: MutationObserver 监听 DOM 变化，自动 hook `iframe.contentDocument` 的 mouseup 事件
- **选区捕获**: mouseup 同步捕获 + 10ms setTimeout 回退，防 SPA 清空选区
- **Pin 状态**: `isPinned` 控制点击外部是否关闭弹窗，`userPinPreference` 在页面会话内持久
- **自有 Markdown 渲染器**: 不用 `YTX.renderMarkdown`，有独立的 regex 渲染规则（音标、词性、搭配等格式）

### 小红书增强（`xhs/xhs-scroll-fix.js`）

独立 IIFE，仅在 `xiaohongshu.com` 生效。

- **问题**: 打开帖子弹窗后，滚动鼠标会导致背景页面滚动而非弹窗内容滚动
- **原因**: 小红书用 JS 监听 wheel 事件驱动背景滚动
- **修复**: capture 阶段拦截 wheel 事件，`stopPropagation` 阻断背景滚动处理器
- **弹窗检测**: 结构化检测（`position: fixed` + 覆盖视口 40%+），不依赖 CSS 类名
- **边界处理**: 弹窗内可滚动区域到达顶部/底部时 `preventDefault` 阻止穿透

### Prompt 模板

- 所有默认 prompt 在 `youtube/prompts.js`（`YTX.prompts.*`），options.js 中也有一份 `DEFAULT_PROMPTS.*`（用于重置按钮）
- 占位符：YouTube 功能用 `{transcript}`，翻译用 `{langInstruction}`
- 自定义 prompt 存储约定：**空字符串表示未自定义**，`getSettings()` 读取时回退到 `YTX.prompts.*` 默认值

### 存储结构

**`chrome.storage.sync`**（跨设备同步）：
- `provider` — `'claude'` | `'openai'` | `'gemini'` | `'minimax'`
- `claudeKey`, `openaiKey`, `geminiKey`, `minimaxKey` — 各 provider 的 API Key
- `claudeModel`, `openaiModel`, `geminiModel`, `minimaxModel` — 各 provider 的模型 ID
- `prompt`, `promptHtml`, `promptCards`, `promptMindmap`, `promptVocab` — 自定义 prompt（注意 summary 的 key 是 `prompt` 而非 `promptSummary`，向后兼容）
- `promptTranslateDict`, `promptTranslateSentence` — 翻译自定义 prompt
- `notionKey`, `notionPage`, `githubKey` — 导出集成
- `generateAllSummary`, `generateAllMindmap`, `generateAllHtml` — 一键生成是否包含对应功能（boolean，默认 true，`!== false` 判断）
- `generateAllCards`, `generateAllVocab` — 一键生成是否包含卡片/词汇（boolean，默认 false）
- `mindmapAlignTop` — 导图对齐偏好

**`chrome.storage.local`**（仅本地）：
- `fetchedModels_claude`, `fetchedModels_openai`, `fetchedModels_gemini` — API 拉取的模型列表缓存

**IndexedDB**（`AAtoolsCache` → `results` store）：
- key 为 `videoId`，`cache.save(videoId, featureKey, data)` 合并写入

### 关键约定

- YouTube SPA 适配：监听 `yt-navigate-finish` 事件，同视频 + 面板已存在则跳过
- 面板注入：等待 `#secondary`/`#secondary-inner` 出现（轮询 30×500ms），prepend 到 `#secondary`
- 可调分栏：`#ytx-resizer` 拖拽手柄，默认 3:2 分割，min secondary 440px
- 时间戳点击：面板级事件委托，匹配 `.ytx-timestamp, .ytx-ts`，设 `video.currentTime` 并 `play()`
- 所有 AI 输出默认要求简体中文
- options.js 设置页：所有输入 1.5s 防抖自动保存，import 需验证 `_meta.version` 为 `'AATube'` 或 `'AAtools'`
