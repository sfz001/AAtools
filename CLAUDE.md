# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAtools** — 自用 Chrome 扩展（Manifest V3），四大核心功能：

1. **YouTube 视频 AI 助手** — 总结/笔记/问答/卡片/导图/词汇提取
2. **全网划词翻译** — 选词即译，字典/句段双模式
3. **小红书体验增强** — 帖子弹窗滚动修复
4. **鼠标手势** — 右键拖拽：后退/前进/关闭标签页/恢复关闭页

支持 Claude / OpenAI / Gemini / MiniMax 四个 API 提供商，无字幕视频可通过 Gemini 视频模式分析。

**技术栈**: 原生 HTML/CSS/JS，零依赖，无构建步骤。

## 目录结构

```
AAtools/
├── youtube/          ← YouTube 视频助手模块
│   ├── core.js          YTX 命名空间、共享状态、工具函数
│   ├── prompts.js       默认 Prompt 模板
│   ├── markdown.js      Markdown 渲染
│   ├── export.js        Markdown / Obsidian 导出
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
├── gestures/         ← 鼠标手势模块
│   └── gestures.js        右键拖拽手势识别（独立 IIFE）
├── background.js     ← Service Worker（API 调用 + 标签页操作）
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

- **content scripts → background**: 通过 `chrome.runtime.sendMessage` 发送请求（如 `SUMMARIZE`、`CHAT_ASK`），消息体里**不携带 API key**（见下方"安全模型"）
- **background → content scripts**: 通过 `chrome.tabs.sendMessage` 流式转发 `{PREFIX}_CHUNK` / `{PREFIX}_DONE` / `{PREFIX}_ERROR`
- 流式开始前发送 `{PREFIX}_MODEL` 消息通知 content script 当前使用的 provider 和 model（显示模型徽章）
- panel.js 中的消息路由用正则 `/^(.+?)_(CHUNK|DONE|ERROR)$/` 解析前缀，分发到 `YTX.features[key]`
- 所有流式 handler 立即返回 `{ started: true }` 并 `return true` 保持消息通道
- 每个请求带 `requestId`（`YTX.makeRequestId()` 生成），background 在所有 _MODEL/_CHUNK/_DONE/_ERROR 消息里回传；panel.js 路由层在 dispatch 给 feature 之前检查 `message.requestId === feature.requestId`，不匹配则丢弃 → 防止 SPA 切视频/重复触发产生的旧 chunk 污染新结果

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
| `GESTURE_CLOSE_TAB` | — | 关闭 sender 所在标签页 |
| `GESTURE_REOPEN_TAB` | — | `chrome.sessions.restore()` 恢复刚关闭的标签页 |
| `GESTURE_RELOAD_HARD` | — | `chrome.tabs.reload(tabId, { bypassCache: true })` 强制刷新当前标签页 |

导出功能（Obsidian / Markdown）完全在 content script 端处理（生成 .md Blob 直接下载），不走 background。

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

- `YTX.makeRequestId()` — 生成形如 `r<base36ts><rand6>` 的请求 ID，用于流式响应隔离
- `YTX.getSettings()` — 返回 Promise，包含 provider/model/prompt 等**非敏感字段**；不读 `*Key` 字段（API key 完全由 background `loadProviderConfig()` 自读）
- `YTX.safeTime(str)` — 校验 AI 返回的时间戳字符串（仅允许 `H:MM:SS` / `MM:SS` / `M:SS`），不合法返回 null。cards/vocab/mindmap 渲染时间戳到 innerHTML 必须先经此校验，防 DOM 注入
- `YTX.ensureTranscript()` — 获取字幕的统一入口，有缓存则直接返回，失败自动回退 Gemini 视频模式。**in-flight 去重**：同一 videoId 的并发调用复用 `YTX._transcriptPromise`，避免多功能并行触发多次 Gemini 转录；切视频/清缓存都会清空该 promise。手动视频模式（`switchToVideoMode`）也写入同一个 `_transcriptPromise`，普通功能在视频模式运行期间调用 `ensureTranscript` 会复用同一路转录流，不会再触发新一路
- `YTX.getContentPayload()` — 返回 `{ transcript }` 用于发送到 background
- `YTX.sendToBg(message)` — Promise 包装的 `chrome.runtime.sendMessage`，所有 feature 用它与 background 通信
- `YTX.extractJSON(text, 'array'|'object')` — 健壮的 JSON 提取，6 层回退策略（直接解析 → 去尾逗号 → 修复控制字符 → 组合修复 → 截断到最后完整 `}` → 截断后再修复）
- `YTX.createDeferred()` — 返回 `{ promise, resolve, reject }`；feature `start()` 用它把流式生命周期包成可 await 的 Promise
- `YTX.generateAll()` — 并行生成所有功能（chat 除外），直接用 `Promise.all(keys.map(k => YTX.features[k].start()))`；不再 patch `onDone`/`onError`，避免 hook 残留与永不 resolve；用 try/catch/finally 包裹，字幕获取失败时面板顶部显示错误条 6 秒，按钮状态在 finally 中无条件恢复
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
  requestId: null,            // 当前请求 ID（panel.js 路由按它过滤过期 chunk）
  // 生命周期（panel.js 调用）
  reset(), actionsHtml(), contentHtml(), bindEvents(panel),
  // 生成（start 内部调用 YTX.ensureTranscript → getSettings → sendMessage）
  async start(),
  // 流式回调（panel.js 消息路由调用）
  onChunk(text), onDone(), onError(error),
};
```

`start()` 模式：设 `isGenerating=true` → 创建 `this._deferred = YTX.createDeferred()`（旧 deferred 先 reject 让位）→ **抓 `var startVideoId = YTX.currentVideoId`**（早绑定）→ 禁用按钮显示 spinner → `await YTX.ensureTranscript()` → **校验 `YTX.currentVideoId === startVideoId` 否则 `bailSilently()`（resolve deferred 静默退出）** → `getSettings()` → 再次校验 → `this.requestId = YTX.makeRequestId()` → `sendMessage` 到 background（带 requestId）→ `return deferred.promise`，等待流式回调。`isGenerating` 与 `_deferred` 在 `onDone`(resolve) / `onError`(reject) 中才清理；`reset()` 把 `requestId` 设 null 并 `reject('视频已切换')` 释放挂起的 deferred。路由层会拒绝任何 requestId 不匹配的过期 chunk（含 feature.requestId 为 null 时的旧 chunk）。这套 deferred 机制让 `generateAll` 可以直接 `Promise.all(features.map(f => f.start()))`，无需 patch handler。

`onChunk` 差异：summary 用 80ms 节流批量渲染，chat 实时渲染，mindmap/cards/vocab 仅累积原始文本在 `onDone` 中一次性 `extractJSON` + 渲染。

加载顺序由 `manifest.json` 中 `content_scripts.js` 数组决定，`panel.js` 必须最后加载（它在顶部构建 `prefixMap`）。

### `callProvider()` — API 调用核心

`background.js` 中统一处理四家 API 的流式调用：

- **Key 自读**: `loadProviderConfig(provider)` 从 `chrome.storage.sync` 按 provider 字段名读取 key + model；content script（YouTube 模块 + translate）**完全不读取 `*Key` 字段**，缺 key 时由 background 在响应里回 `{PREFIX}_ERROR`
- **模型验证**: `sanitizeModel(provider, model)` 检查模型前缀（`claude-`/`gpt-`/`gemini-`/`minimax-`），不匹配则静默回退到默认模型
- **SSE 解析**: 统一由 `readSSEStream()` 处理，按 provider 提取文本：
  - Claude: `content_block_delta` → `delta.text`，`message_stop` 结束
  - OpenAI: `choices[0].delta.content`，`[DONE]` 行结束
  - Gemini: `candidates[0].content.parts[0].text`，流结束即完成
- **请求 ID 透传**: `callProvider` + `readSSEStream` 内定义局部 `send(msg) = safeSend(tabId, {requestId, ...msg})`，所有发往 content script 的消息自动带上 requestId
- **防重复**: `doneSent` 标志防止重复发送 `{PREFIX}_DONE`
- **安全发送**: `safeSend(tabId, msg)` 包裹 try/catch + `.catch(() => {})`，tab 关闭不会崩溃
- **错误分类**: `classifyApiError()` 将 HTTP 状态码映射为中文提示（401→Key 无效，429+quota→余额不足，400+token→内容太长）
- **SW 保活**: `startKeepalive()` 每 20 秒 ping 一次防止 Service Worker 被杀（视频转录时使用）

### 安全模型

`<all_urls>` content script（translate + gestures）暴露在所有页面，恶意页面可合成 mouse/keyboard 事件触发它们。多道防线：

1. **`isTrusted` 守卫** — 所有真实用户交互入口（translate 的 mouseup/click/Ctrl+Enter，gestures 的 mousedown/mousemove/mouseup）首行 `if (!e.isTrusted) return;`，合成事件无法触发任何 API 请求或浏览器导航
2. **API key 不经 message channel，content script 不读 key** — content script（YouTube `youtube/*.js` + `<all_urls>` 的 translate.js）**完全不读取** `chrome.storage.sync` 里的 `*Key` 字段，也不再传 `activeKey`。所有 key 由 background `loadProviderConfig()` 自读，缺 key 时统一回 `{PREFIX}_ERROR`。Gemini 视频转录的"无 key 时提示用户配置"也走这条路径。即使 content script 被部分攻陷，也无法通过 message 通道或 page-context 直接劫持 key
3. **AI 输出 time 字段防注入** — cards/vocab/mindmap 的 `time` 字段直接拼到 `innerHTML`/SVG，渲染前必须经 `YTX.safeTime(str)` 校验（仅允许 `H:MM:SS`/`MM:SS`/`M:SS`），不合法 → 返回 null → 不渲染时间戳。防止恶意/被劫持的 LLM 返回带 `<script>` 或事件处理器的 time 字符串导致 DOM 注入
4. **HTML 笔记导出清洗 + 严格 CSP** — `YTX.Export.sanitizeHtml(html)` 用 DOMParser 删除所有可执行/外部加载元素：`<script>`、`<iframe>`、`<frame>`、`<object>`、`<embed>`、`<applet>`、`<link rel=stylesheet|preload|prefetch|...>`、`<link as=...>`、`<base>`；剥离所有 `on*` 事件属性、`javascript:`/`data:`/`vbscript:` 链接（仅放行 `data:image/`）。再注入严格 CSP：`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none';`。openInNewTab、downloadHtml、面板内 iframe.srcdoc 全部走它，导出文件离线打开后**不会向任何外部域发请求**
5. **请求隔离（videoId + requestId 双层）** — 见下方"请求隔离"。translate 也加了本地 `currentRequestId`，关弹窗后立刻发起下一次翻译时旧 chunk 不会污染新弹窗

### 请求隔离

YouTube SPA 切视频时旧异步操作会污染新视频结果。用四层防线封死所有竞态窗口：

- **videoId 早绑定（feature 层）** — 各 feature `start()` / `vocab.refresh()` / `generateAll()` 入口立即抓 `var startVideoId = YTX.currentVideoId;`；`ensureTranscript()` / `getSettings()` 等 await 之后立即检查 `if (YTX.currentVideoId !== startVideoId) { this.isGenerating = false; return; }`，旧 promise 不会用新视频的 transcript 发出新请求
- **videoId 早绑定（字幕层）** — `YTX.ensureTranscript()` 内部也抓 `startVideoId`，`fetchTranscript()` await 完成后校验，不匹配则丢弃结果不写 `YTX.transcriptData`，缓存写入按 `startVideoId` 而非 `currentVideoId`，避免把 A 视频的字幕落到 B
- **缓存恢复竞态防护** — `panel.js restoreFromCache(videoId)` 的 `cache.load(videoId).then(...)` 第一行 `if (videoId !== YTX.currentVideoId) return;`，IndexedDB 异步读期间切视频不会把旧记录渲染到新面板
- **requestId 透传 + 路由过滤** — 每次请求带 `requestId`（`YTX.makeRequestId()`），background 把 requestId 放到所有 `_MODEL/_CHUNK/_DONE/_ERROR` 消息里。`panel.js` 路由层在 dispatch 给 feature 之前严格校验 `message.requestId === feature.requestId`，**即使 feature.requestId 为 null 也丢弃**。`_MODEL` 消息也走同一过滤，防止旧请求的模型徽章覆盖当前
- **视频转录 videoId + requestId 双重隔离** — `TRANSCRIBE_VIDEO` 请求带 `videoId` 和 `requestId`，background 在 `TRANSCRIBE_PROGRESS/CHUNK/SEGMENT` 消息里都回传；`panel.js` 三个入口同时校验 `message.videoId !== YTX.currentVideoId` 和 `message.requestId !== YTX._transcribeRequestId`，任一不匹配则丢弃。这样即使同一视频下旧请求未取消时启动新转写（如手动取消未完成转录后再启动），旧 chunk/segment 也不会污染新结果。`_analyzeVideoWithGemini` 在 promise resolve 后再次 videoId 校验，不匹配则抛错丢弃结果
- **非视频页导航清理** — `panel.js onNavigate` 检测到 `!videoId`（首页/搜索/频道页等）时调 `resetTranscriptState()` 清空 `_transcriptPromise/_transcriptVideoId/_transcribeVideoId/_transcribeRequestId/_transcribeBuffer/_transcribeReceiving/_transcribeTimer/isFetchingTranscript`，避免 A 视频转录中跳到首页再进 B 视频时被旧 in-flight 状态错误拦截

### 字幕获取流程

1. content script 发送 `FETCH_TRANSCRIPT` 到 background
2. **快速路径**（`fastScrapeTranscriptViaPlayerAPI`，~300ms，MAIN world）：
   - 从 `#movie_player.getPlayerResponse()` 拿当前视频的 `captionTracks`（注意 `window.ytInitialPlayerResponse` SPA 切视频后不更新，只能用 player API）
   - 校验 player.videoId === 请求的 videoId（防 SPA 切视频拿到旧字幕）
   - 在 `performance.getEntriesByType('resource')` 里查带 `pot=` 的 `/api/timedtext` URL
   - 没有则触发 `player.loadModule('captions') + setOption('captions','track',{languageCode})`，让 player 自己发带 pot 的请求
   - 用户原本没开字幕的话，触发后立即 `setOption('captions','track',{}) + unloadModule('captions')` 关掉，避免污染观看体验
   - 拿到 URL 后直接 fetch（追加 `&fmt=json3`），解析 `events[].segs[].utf8` + `tStartMs` 为 segments
   - **关键约束**：YouTube `/api/timedtext` 服务端校验 `pot` (proof-of-origin token)，没有 pot 的 fetch 返回 200 + 空 body。pot 由 player 内部生成，无法逆向，所以必须借 player 发的请求
3. **回退**（`scrapeTranscriptFromDOM`，6-30s）：快速路径失败（无字幕轨道、player 未就绪等）时走 DOM 抓取——点描述区转录按钮 → "..." 菜单 → 暴力搜索 → 解析 `ytd-transcript-renderer` DOM
4. 失败时若有 Gemini Key，启用视频模式：调用 Gemini API（固定使用 `gemini-flash-lite-latest`，忽略用户模型选择）分析视频 URL 生成虚拟字幕
5. 字幕截断保护：`YTX.TRANSCRIPT_MAX_CHARS = 200000`

### 划词翻译（`translate/translate.js`）

完全独立于 YTX 命名空间的 IIFE，运行在所有页面（`<all_urls>`）。

- **`isTrusted` 守卫**: 5 个真实交互入口（document mouseup、icon click、iframe mouseup、textarea Ctrl+Enter、翻译按钮 click）首行检查，合成事件无法触发翻译请求
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

### 鼠标手势（`gestures/gestures.js`）

独立 IIFE，运行在所有页面（`<all_urls>`），仅在顶层窗口启用（跳过 iframe，避免重复触发与跨域冲突）。

**手势映射**

| 手势 | 序列 | 动作 | 实现 |
|---|---|---|---|
| `←` | `L` | 后退 | `history.back()` |
| `→` | `R` | 前进 | `history.forward()` |
| `↑` | `U` | 滚动到顶部 | `window.scrollTo({ top: 0 })` |
| `↓` | `D` | 滚动到底部 | `window.scrollTo({ top: documentElement.scrollHeight })` |
| `↓→` | `DR` | 关闭当前标签页 | 消息 `GESTURE_CLOSE_TAB` → `chrome.tabs.remove(sender.tab.id)` |
| `←↑` | `LU` | 恢复刚关闭的标签页 | 消息 `GESTURE_REOPEN_TAB` → `chrome.sessions.restore()` |
| `↑↓` | `UD` | 强制刷新（绕过缓存） | 消息 `GESTURE_RELOAD_HARD` → `chrome.tabs.reload(tabId, { bypassCache: true })` |

注意 `D` / `↓→`、`L` / `←↑`、`U` / `↑↓` 这几对：单字母手势是较长复合手势的前缀，但执行只在 `mouseup` 时根据**最终序列**触发。所以 `DR`/`LU`/`UD` 整段一气呵成不会误触发单字母版本。

**识别逻辑**

- 右键 `mousedown` 开始追踪 → `mousemove` 累计方向序列 → `mouseup` 匹配 `GESTURES` 表执行
- **`isTrusted` 守卫**：mousedown/mousemove/mouseup 首行检查，合成事件不触发
- **单段阈值** `MIN_SEGMENT = 30` 像素：超过才记一次方向
- **总位移阈值** `MIN_GESTURE = 8` 像素：低于此值视为普通右键，放行原生菜单
- **方向去重**: 连续相同方向只记一次，所以 `LL` 不存在，长拖动也只算 `L`
- **`←↑` 不会误触发后退**: 动作只在 `mouseup` 时根据完整序列执行，一气呵成的 `←↑` 整段被识别为 `LU`
- **抑制 contextmenu**: 拖动达到阈值后置 `suppressContext = true`（200ms 窗口），下一次右键菜单被吞掉

**视觉反馈**

- 屏幕中央浮层（`z-index: 2147483647`，`pointer-events: none`），实时显示当前方向序列
- 命中合法手势时不透明度提升至 `1`，未命中维持 `0.7`
- `mouseup` 后立即隐藏；`window.blur` 时复位 tracking 状态防卡死

**所需权限**

- `sessions` — `chrome.sessions.restore()` 必需
- `chrome.tabs.remove` 不需要单独权限（通过 sender.tab.id 操作自身 tab）

**总开关**

- `chrome.storage.sync.enableGestures`（boolean，默认 true，设置页"功能开关"卡片）
- 启动时一次性读取，并监听 `chrome.storage.onChanged`：用户在设置页切换后所有页面**无需刷新**即可生效
- 关闭后 `mousedown` 直接 return，原生右键菜单完全不受影响

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
- `generateAllSummary`, `generateAllMindmap`, `generateAllHtml` — 一键生成是否包含对应功能（boolean，默认 true，`!== false` 判断）
- `generateAllCards`, `generateAllVocab` — 一键生成是否包含卡片/词汇（boolean，默认 false）
- `enableGestures` — 鼠标手势总开关（boolean，默认 true，`!== false` 判断）
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
