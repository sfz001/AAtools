# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AAtools** — 自用 Chrome 扩展（Manifest V3），四大核心功能：

1. **YouTube 视频 AI 助手** — 总结/笔记/问答/思维导图
2. **全网划词翻译** — 选词即译，字典/句段双模式
3. **小红书体验增强** — 帖子弹窗滚动修复
4. **鼠标手势** — 右键拖拽：后退/前进/关闭标签页/恢复关闭页

支持 Claude / OpenAI / ChatGPT 订阅（Codex OAuth）/ Gemini / MiniMax / DeepSeek / Kimi / Sub2API（自定义中转网关）八个提供商，无字幕视频可通过 Gemini 视频模式分析。

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
│   ├── mindmap.js       思维导图
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

没有构建或 lint 命令。测试用 Node 内置 runner：`node --test tests/*.test.js`（注意用 glob，`node --test tests/` 会 MODULE_NOT_FOUND）。开发流程：

1. `chrome://extensions/` → 开启开发者模式 → 加载已解压的扩展程序（选择项目根目录）
2. 修改代码后在扩展页点击刷新图标即可——**无需刷新已打开的页面**：`onInstalled` 时 background 会把 content scripts 重注入到所有已打开的匹配标签页（见"扩展重载免刷新"）
3. 修改 `background.js` 后需要在扩展页重新加载 Service Worker
4. 改完跑一遍 `node --test tests/*.test.js`——`tests/*.test.js` 中的测试用 `vm.createContext` 桩掉 `chrome.*`，覆盖协议、缓存迁移、设置页权限逻辑与手势的右键菜单/双击策略

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
| `GENERATE_MINDMAP` | `MINDMAP` | 思维导图 |
| `CHAT_ASK` | `CHAT` | 问答 |
| `TRANSCRIBE_VIDEO` | `TRANSCRIBE` | 视频转录（特殊：`PROGRESS`/`CHUNK`/`SEGMENT`） |
| `TRANSLATE` | `TRANSLATE` | 划词翻译 |
| `GESTURE_CLOSE_TAB` | — | 关闭 sender 所在标签页 |
| `GESTURE_REOPEN_TAB` | — | `chrome.sessions.restore()` 恢复刚关闭的标签页 |
| `GESTURE_RELOAD_HARD` | — | `chrome.tabs.reload(tabId, { bypassCache: true })` 强制刷新当前标签页 |
| `CANCEL_REQUEST` | — | 按 requestId 取消 background 中仍在进行的 fetch / 流读取 |
| `CACHE_LOAD` | — | 读某个视频的全部缓存，回 `{ ok, record }` |
| `CACHE_SAVE` | — | 按 `videoId` + `featureKey` 合并写入 |
| `CACHE_REMOVE` | — | 删除某个视频的缓存记录 |
| `CACHE_MIGRATE_RECORD` | — | 把页面 origin 旧库的一条记录迁进扩展库（一次性） |

`CACHE_*` 五类消息由 `isTrustedCacheSender()` 把关：只放行 `www.youtube.com` 的**顶层帧**（frameId 0），设置页等扩展页面发的会被拒。`videoId` 必须匹配 `/^[A-Za-z0-9_-]{11}$/`，记录序列化后不得超过 5,000,000 字符，两者都不满足时回 `{ ok:false, error }`——这类失败是永久性的，`_migrateLegacy` 会跳过该条继续迁移其余记录。记录里除各 feature 字段外还有 `updatedAt`（合并时用于判断新旧）与 `__legacyFeatures`（标记哪些字段来自旧库）。

`{PREFIX}_ERROR` 与 `FETCH_TRANSCRIPT` 的响应可带 `cancelled: true` 与 `reason: 'navigation'`：表示请求是被导航/切视频主动取消的，content 侧据此静默退出而不渲染错误。

导出功能（Obsidian / Markdown）完全在 content script 端处理（生成 .md Blob 直接下载），不走 background。

### 全局命名空间 `YTX`

所有 YouTube content scripts 共享 `var YTX` 全局对象（`youtube/core.js` 中定义）。关键状态：

- `YTX.panel` — 注入的面板 DOM 元素
- `YTX.panelCollapsed` — 当前 YouTube 标签页内的面板收起状态；启动时从 `youtubePanelDefaultCollapsed` 初始化，之后在 SPA 导航中保留手动状态
- `YTX.currentVideoId` — 当前视频 ID
- `YTX.transcriptData` — `{ segments, full, truncated }`，null 表示未获取
- `YTX.videoMode` — 是否使用 Gemini 视频模式
- `YTX.isFetchingTranscript` — 正在获取字幕时为 true，禁止生成操作
- `YTX.features` — 功能模块注册表
- `YTX.featureOrder` — 标签页排列顺序：`['summary', 'mindmap', 'html', 'chat']`

关键工具函数：

- `YTX.makeRequestId()` — 生成形如 `r<base36ts><rand6>` 的请求 ID，用于流式响应隔离
- `YTX.getSettings()` — 返回 Promise，包含 provider/model/prompt 等**非敏感字段**；不读 `*Key` 字段（API key 完全由 background `loadProviderConfig()` 自读）
- `YTX.safeTime(str)` — 校验 AI 返回的时间戳字符串（仅允许 `H:MM:SS` / `MM:SS` / `M:SS`），不合法返回 null。mindmap 渲染时间戳到 innerHTML 必须先经此校验，防 DOM 注入
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

`onChunk` 差异：summary/chat/translate 用 80ms 合批渲染；chat/translate 阅读上文时保持滚动位置。mindmap 仅累积原始文本，在 `onDone` 一次性解析和渲染。终态与重置必须刷新或取消旧计时器，避免跨请求污染。

加载顺序由 `manifest.json` 中 `content_scripts.js` 数组决定，`panel.js` 必须最后加载（它在顶部构建 `prefixMap`）。

### `callProvider()` — API 调用核心

`background.js` 中统一处理八家 API 的流式调用：

- **Key 自读**: `loadProviderConfig(provider)` 从 `chrome.storage.sync` 按 provider 字段名读取 key + model；sub2api 还会额外读 `sub2apiBaseUrl`。content script（YouTube 模块 + translate）**完全不读取 `*Key` 字段**，缺 key 时由 background 在响应里回 `{PREFIX}_ERROR`
- **共享模型目录**: `models.js` 暴露 `AATModels`，由 background 的 `importScripts` 和 options.html 的前置 script 共用。`providers/defaults` 定义各系列当前最新版与默认值，`isSelectable` 严格以当前预置列表为白名单；前缀正确或仍能调用的旧型号也不可选。`sanitizeModel` 将旧配置按系列迁移到白名单型号，直连、ChatGPT 与 Sub2API 使用同一原则。设置页初始化时写回迁移后的配置，请求侧也按共享目录归一化；不得在 options/background 再复制一套型号或正则。
- **Claude 请求体组装**: `buildClaudeBody` 从 `AATModels.getPolicy` 读取 thinking 类型、最小输出预算和 effort 字段。可选的 Sonnet 5.5 拒绝 disabled，使用 between_tools（无工具时仅正文）；Haiku 5.5 使用 disabled；Fable 5.1 / Opus 5.5 保留思考并至少分配 16000 token，翻译通过 output_config.effort=low 降低深度。模型先按当前目录归一化，再读取参数策略。
- **思考深度分档（effort）**: 翻译传 low，其余任务默认不覆盖。`AATModels.getPolicy` 按模型能力决定参数：当前 GPT-6 系用 reasoning_effort，并为思考/正文共享预算留至少 16000 token；Gemini 3 非 Flash-Lite 用 thinkingLevel；Responses API 保持 reasoning.effort。Kimi K3 默认降到 low，其余 provider 的思考开关同样集中于 policy。`getPolicy` 只处理当前目录；非白名单型号返回空参数策略，调用方须先迁移已存型号。
- **Sub2API 单槽位**: provider 为 `sub2api`，配置为 key/model/baseUrl 三个字段。`isSub2(provider)` 辅助函数判断（历史上曾有 sub2api2/sub2api3 三槽位，2026-08 移除，options.js 启动时一次性迁移清理残留 storage 键并撤销多余网关域名权限）
- **baseUrl 归一化**: `normalizeSub2ApiBase()` 自动剥离用户从 codex/opencode 配置直接复制的常见路径后缀（`/v1beta` / `/v1/messages` / `/v1/chat/completions` / `/v1/responses`），避免与代码自拼路径产生 `/v1beta/v1beta/...` 这类双前缀
- **Sub2API 路由**: `isSub2(provider)` 时按 `sub2apiFormatOf(model)` 决定走哪种格式：
  - `claude-*` → POST `{baseUrl}/v1/messages`，body 与 Anthropic 完全一致；同时附 `x-api-key` + `Authorization: Bearer` 头部以兼容不同网关
  - `gemini-*` → POST `{baseUrl}/v1beta/models/{model}:streamGenerateContent?alt=sse&key=...`；三种鉴权全附（`?key=` + `Authorization: Bearer` + `x-goog-api-key`）兼容不同网关
  - `gpt-*` → POST `{baseUrl}/v1/responses`（**Responses API**，对应 codex `wire_api = "responses"`）。请求体贴近 codex CLI：`{model, input(typed), instructions, stream:true, store:false, reasoning:{effort:"medium"（翻译 "low"）, summary:"auto"}, include:["reasoning.encrypted_content"], tools:[], parallel_tool_calls:false, tool_choice:"auto"}`，user 消息用 `input_text`，assistant 用 `output_text`；不发 `max_output_tokens`（codex 不发，部分网关会因此拒）
  - SSE 解析按 `parseAs = sub2apiFormatOf(model)`：claude/gemini 直接对应；sub2api+openai 走 `'openai-responses'` 分支（解析 `type === 'response.output_text.delta'` 的 `delta` 字段，`response.completed`/`response.done` 结束，`error`/`response.failed` 也标记 done 避免挂死）
  - baseUrl 缺失时 `callProvider` 直接回 `{PREFIX}_ERROR`，不会发出请求
- **ChatGPT 订阅（provider `chatgpt`）**: 不走付费 API，复用 codex CLI 的 OAuth 凭据消耗 ChatGPT 订阅额度。用户在设置页粘贴 `~/.codex/auth.json` 全文（需先 `codex login`），options.js 解析出 `access_token/refresh_token/id_token/account_id` 存入 **`chrome.storage.local.chatgptAuth`**（体积大且不宜跨设备同步，故不放 sync，也不随导入/导出走），粘贴框保存后即清空。请求 POST `https://chatgpt.com/backend-api/codex/responses`（Responses API，请求体与 sub2api 的 gpt 分支共用 `buildResponsesApiBody()`），头部带 `Authorization: Bearer` + `chatgpt-account-id` + `OpenAI-Beta: responses=experimental` + `originator: codex_cli_rs` + `session_id`；SSE 走 `'openai-responses'` 解析分支。`ensureChatgptAccessToken()` 在 access token 剩余有效期 <5 分钟时自动 POST `https://auth.openai.com/oauth/token`（codex 的 client_id `app_EMoamEEZ73f0CkXaXp7hrann`，grant_type=refresh_token）刷新并回写 storage.local；刷新失败/凭据缺失以 `{PREFIX}_ERROR` 中文提示（引导重新 `codex login` + 重新粘贴）。`loadProviderConfig('chatgpt')` 以 local 里是否存在凭据充当"已配置"标记（`key: 'chatgpt-oauth'`），模型仍从 sync 读 `chatgptModel`（默认 `gpt-6.1-sol`，仅接受共享目录中的当前 GPT 型号，旧配置按系列迁移）。classifyApiError 对 chatgpt 的 401/403、429 有专门文案（订阅授权失效 / 订阅额度用尽）
- **DeepSeek**: 走 OpenAI 兼容 Chat Completions，使用 max_tokens 并显式关闭 thinking。当前 Flash 系列使用 `deepseek-flash`（V4.1 Flash），Pro 系列使用 `deepseek-v4-pro`（V4 Pro）；旧 Flash 型号归一化到前者，Pro 系列迁移到后者，旧名称不保留为选项。
- **Kimi**: OpenAI 兼容 Chat Completions，POST `https://api.moonshot.cn/v1/chat/completions`，与 openai/minimax/deepseek 共用调用分支；用 `max_completion_tokens`。只提供 `kimi-k3`，旧 Kimi / Moonshot 配置迁移到 K3。K3 思考恒开，将 reasoning_effort 降至 low，max_completion_tokens 至少分配 16000，避免思考消耗全部正文预算；SSE 只取正文 delta.content。
- **MiniMax**: 走 OpenAI 兼容 Chat Completions，使用 max_completion_tokens 和 reasoning_split。普通 API 只提供正式版 `MiniMax-M3`，可关闭 thinking；旧配置迁移到 M3。M3.1 Flash Preview 目前限定渠道，不进入预置、拉取结果或已存配置的可选列表。参数策略只覆盖当前 M3，不保留 M2.x 或限定渠道 M3.1 的分支。
- **Gemini**: `buildGeminiBody(model, maxTokens, messages, systemPrompt, effort)` 为 Gemini direct 与 sub2api gemini 格式共用（`contents` + `systemInstruction` + `generationConfig.maxOutputTokens`）。Gemini 3.x 默认开思考（Flash 默认 `medium`、Pro 默认 `high`，思考 token 按输出计费），划词翻译时对非 Flash-Lite 的 3.x 传 `thinkingConfig.thinkingLevel: 'low'`；3.7 起 `temperature`/`top_p`/`top_k` 已废弃，代码从不发这些采样参数
- **SSE 解析**: 统一由 `readSSEStream()` 处理，按 provider 提取文本：
  - Claude: `content_block_delta` → `delta.text`，`message_stop` 结束
  - OpenAI / MiniMax / DeepSeek / Kimi: `choices[0].delta.content`，`[DONE]` 行结束
  - Gemini: 拼接 `candidates[0].content.parts[]` 里所有 `text`（不是只取第一个 part）；终态看 `finishReason`——`STOP` 才算正常结束，其它值转成「异常结束（finishReason=…）」的告警，流读完却从未收到终态标记则报「流式响应意外中断」
- **请求 ID 透传**: `callProvider` + `readSSEStream` 内定义局部 `send(msg) = safeSend(tabId, {requestId, ...msg})`，所有发往 content script 的消息自动带上 requestId
- **终态互斥与完整性**: `createStreamEmitter` 保证 DONE/ERROR 只发一次且互斥。部分正文达到输出上限时 DONE 附带 warning/truncated，panel 透传到 feature.onDone(metadata)；总结/笔记/导图和字幕缓存保留完整性，恢复时显示警告。空正文或异常中断仍报 ERROR，不误标正常完成。
- **安全发送**: `safeSend(tabId, msg)` 包裹 try/catch + `.catch(() => {})`，tab 关闭不会崩溃
- **错误分类**: `classifyApiError()` 将 HTTP 状态码映射为中文提示（401→Key 无效，429+quota→余额不足，400+token→内容太长）
- **SW 保活**: `retainServiceWorker()` 引用计数保活，`createActiveRequest` 对**所有** callProvider 流式请求都持有一份（不只是视频转录），计数归零才释放
- **超时与中止**: 普通请求首字节 90s / 空闲 60s / 总时长 15min，视频转录为 180s / 120s / 45min；Gemini 3 非 low 档首字节放宽到 180s。ChatGPT 共享 OAuth 刷新另设独立 30s 超时（覆盖 headers 和 body）；各调用者可独立取消等待，不中止其他调用者的刷新。

### 安全模型

`<all_urls>` content script（translate + gestures）暴露在所有页面，恶意页面可合成 mouse/keyboard 事件触发它们。多道防线：

1. **`isTrusted` 守卫** — 所有真实用户交互入口（translate 的 mouseup/click/Ctrl+Enter，gestures 的 mousedown/mousemove/mouseup）首行 `if (!e.isTrusted) return;`，合成事件无法触发任何 API 请求或浏览器导航
2. **API key 不经 message channel，content script 不读 key** — content script（YouTube `youtube/*.js` + `<all_urls>` 的 translate.js）**完全不读取** `chrome.storage.sync` 里的 `*Key` 字段，也不再传 `activeKey`。所有 key 由 background `loadProviderConfig()` 自读，缺 key 时统一回 `{PREFIX}_ERROR`。Gemini 视频转录的"无 key 时提示用户配置"也走这条路径。即使 content script 被部分攻陷，也无法通过 message 通道或 page-context 直接劫持 key
3. **AI 输出 time 字段防注入** — mindmap 的 `time` 字段直接拼到 `innerHTML`/SVG，渲染前必须经 `YTX.safeTime(str)` 校验（仅允许 `H:MM:SS`/`MM:SS`/`M:SS`），不合法 → 返回 null → 不渲染时间戳。防止恶意/被劫持的 LLM 返回带 `<script>` 或事件处理器的 time 字符串导致 DOM 注入
4. **HTML 笔记导出清洗 + 严格 CSP** — `YTX.Export.sanitizeHtml(html)` 用 DOMParser 删除所有可执行/外部加载元素：`<script>`、`<iframe>`、`<frame>`、`<object>`、`<embed>`、`<applet>`、`<link rel=stylesheet|preload|prefetch|...>`、`<link as=...>`、`<base>`；剥离所有 `on*` 事件属性、`javascript:`/`data:`/`vbscript:` 链接（仅放行 `data:image/`）。再注入严格 CSP：`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none';`。openInNewTab、downloadHtml、面板内 iframe.srcdoc 全部走它，导出文件离线打开后**不会向任何外部域发请求**
5. **请求隔离（videoId + requestId 双层）** — 见下方"请求隔离"。translate 也加了本地 `currentRequestId`，关弹窗后立刻发起下一次翻译时旧 chunk 不会污染新弹窗

### 扩展重载免刷新（重注入 + 代际接管）

扩展 reload/更新后，已打开页面里的旧 content script 变成孤儿（`chrome.runtime` 失效，表现为"扩展已更新，请刷新页面后重试"）。两段机制让用户无需刷新页面：

- **background 重注入**：`chrome.runtime.onInstalled` → `reinjectContentScripts()` 读 `chrome.runtime.getManifest().content_scripts`，对所有已打开的匹配标签页按组 `insertCSS` + `executeScript`（组内文件顺序与 manifest 一致，panel.js 仍最后执行）。**权限前提**：`chrome.scripting.executeScript` 和 `tabs.query` 的 url 可见性都只认 `host_permissions`（content script 的 `matches` 不算数），所以 manifest 把 `https://*/*` + `http://*/*` 列为必需 host 权限——安装警告不变（`<all_urls>` content script 本就触发"读取所有网站数据"），副作用是 Sub2API 的 `optional_host_permissions` 域名授权流程被通配权限覆盖（`permissions.request` 直接返回已授权、`permissions.remove` 对必需权限静默失败，options.js 两处均已容错，manifest 已删除 `optional_host_permissions`）。受限页（chrome://、商店、PDF viewer 等）注入失败被 try/catch 忽略（这些页面 manifest 注入本来也不生效，无回归）
- **代际接管（takeover 事件）**：4 个入口脚本（translate.js、gestures.js、xhs-scroll-fix.js、panel.js 代表 youtube 整组）顶部各有一段：先 `document.dispatchEvent(new Event('aatools-takeover-<name>'))` 广播，再注册同名监听。DOM 事件跨 isolated world 传播 → 旧实例收到后置 `destroyed = true` 并自我卸载（移除 UI/observer；youtube 组额外摘掉 `yt-navigate-finish`、`resetTranscriptState()`、重置 features、`removePanel()`/`removeResizer()`）。**dispatch 在 addEventListener 之前**，新实例不会杀死自己
- **destroyed 守卫**：旧实例无法逐个摘除全部 DOM 监听，改为在各事件入口首行 `if (destroyed) return;` 短路（translate 的 mouseup/mousedown/keydown/iframe mouseup/onMessage、gestures 的 mousedown/contextmenu、xhs 的 wheel、panel 的 onMessage/waitForContainer/injectPanel）。`chrome.runtime.onMessage` 也要守卫——重注入与 manifest 注入撞进**同一** isolated world 时（如 reload 瞬间正在加载的 tab），旧副本的 chrome 监听仍然存活
- **同 world 撞车兜底**：同 world 双注入时全局 `YTX` 被新实例覆盖，旧面板无法经 `YTX.panel` 找到 → `removePanel()` 额外按 `document.getElementById('ytx-panel')` 兜底移除。translate/gestures 的 UI 引用是闭包变量，不受影响
- **安全性**：恶意页面可伪造 takeover 事件，但效果仅是让该页上的扩展 UI 失效（页面本可用 CSS/事件拦截达到同样效果），无任何权限收益

### 请求隔离

YouTube SPA 切视频时旧异步操作会污染新视频结果。用四层防线封死所有竞态窗口：

- **videoId 早绑定（feature 层）** — 各 feature `start()` / `generateAll()` 入口立即抓 `var startVideoId = YTX.currentVideoId;`；`ensureTranscript()` / `getSettings()` 等 await 之后立即检查 `if (YTX.currentVideoId !== startVideoId) { this.isGenerating = false; return; }`，旧 promise 不会用新视频的 transcript 发出新请求
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
3. **回退**（`scrapeTranscriptFromDOM`）：快速路径失败（无字幕轨道、player 未就绪等）时走 DOM 抓取，MAIN world 执行，步骤为：等页面就绪（最多 8s）→ 读已打开的字幕面板 → 展开描述区并点「内容转文字」按钮 → 每 300ms 轮询解析面板、段数连续 3 轮不变即完成（有 transcript section 时最多 200 轮≈60s，没有则 20 轮≈6s）→ 仍失败则强制把 `engagement-panel-searchable-transcript` 置为 EXPANDED 再轮询一轮（最多 60s）。所以最好情况约 6s，最坏约 2 分钟；代码里没有点「...」菜单或暴力搜索的逻辑
4. 失败时若有 Gemini Key，启用视频模式：调用 Gemini API（固定使用 `gemini-3.5-flash-lite`，忽略用户模型选择；不用 `gemini-flash-lite-latest` 这类漂移别名——官方会随新版本热切换、可能切到预览版并收紧限速，转录链路要可预期）分析视频 URL 生成虚拟字幕。**仅走原生 Gemini direct**（`generativelanguage.googleapis.com`），不走 sub2api — sub2api 网关大多绑的是 OAuth/codeassist 账号，不支持 `file_data.file_uri` 的 YouTube URL 视频处理（虽然 sub2api 源码本身是透明转发，但上游 Google 账号没视频权限）。`_callGeminiTranscribe` 走 `TRANSCRIBE_TIMEOUTS`（首字节 180s / 空闲 120s / 总时长 45min），超时由 AbortController 中止 fetch + SSE 上游错误事件解析（`parsed.error` / `promptFeedback.blockReason` / 异常 finishReason 都会冒泡）
5. 字幕截断保护：`YTX.TRANSCRIPT_MAX_CHARS = 200000`

### 划词翻译（`translate/translate.js`）

完全独立于 YTX 命名空间的 IIFE，运行在所有页面（`<all_urls>`）。

- **`isTrusted` 守卫**: 5 个真实交互入口（document mouseup、icon click、iframe mouseup、textarea Ctrl+Enter、翻译按钮 click）首行检查，合成事件无法触发翻译请求
- **字典/句段模式判定**（background.js 和 translate.js 各有一份相同逻辑）：去掉空白/标点/数字后总长 ≤20 字符，且 CJK ≤4 字符或 Latin ≤3 单词，才走字典格式；否则走纯翻译
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

- 右键 `mousedown` 开始追踪 → `mousemove`（鼠标）/ `wheel`（Mac 触控板按住右键 + 另一指滑动会发 wheel 而非 mousemove）累计方向序列 → `mouseup` 匹配 `GESTURES` 表执行
- **wheel 路径仅限 macOS，且假设自然滚动开启**：handler 把 `-deltaX/-deltaY` 计入方向序列，这个取反只对 macOS 默认的自然滚动成立；Windows/Linux 上按住右键滚一格会被记成方向相反的手势，所以 `startWheelTracking()` 用 `isMac` 门控。监听还按需注册：`mousedown` 进入 tracking 时挂上、`mouseup`/`blur`/关闭总开关/代际接管时摘掉——它只在 tracking 期间需要非 passive（要 `preventDefault`），常驻一个 `<all_urls>` 的阻塞型 document 级 wheel 捕获监听会让每段滚动的首个事件等待主线程
- **totalMoved 按事件增量累加**：`prevPoint` 每次 mousemove 都前移，`lastPoint` 只作 `MIN_SEGMENT` 的分段锚点。用分段锚点算距离会把 30px 内的慢速漂移按 1+2+3+4… 叠加，把 `MIN_GESTURE` 的有效阈值压到 3-4px
- **右键菜单策略按平台自动决定，没有设置项**（`menuOnDown = !isWin`）：Chromium 只有 Windows 在 mouseup 之后派发 contextmenu，macOS 与 Linux 都在 mousedown 瞬间派发（Blink 注释 "On Mac/Linux, we handle it on mouse down, not up"），菜单一弹页面就收不到后续 mousemove/mouseup
  - **Windows**：mousedown 不抑制（`suppressContext = false`），mouseup 按位移决定：`totalMoved < MIN_GESTURE` 的短按放行原生菜单，拖动出手势并置 `suppressContext = true`（200ms 窗口）吞掉随后派发的菜单。「普通右键弹菜单、拖动出手势」在这里原生可达，不需要双击
  - **macOS / Linux**：mousedown 立即 `suppressContext = true` 进手势模式。Mac 用户配"左下角=右键"后，按住左下角 + 触控板滑动即触发手势；wheel 事件 handler 把滑动按 `-deltaX/-deltaY` 计入方向序列（自然滚动取反）。**双击右键弹原生菜单**：被吞掉菜单的短按（`totalMoved < MIN_GESTURE` 且 `suppressContext` 为 true）在 mouseup 调 `armMenu(e)` 记下 `timeStamp` 与 screen 坐标；下一次右键 mousedown 先 `isDoubleRightClick(e)`（间隔 ≤ `DOUBLE_CLICK_MS`=500ms 且位移 ≤ `DOUBLE_CLICK_DIST`=10px），命中则清 `suppressContext`（含 200ms 复位定时器）并直接 return 不进 tracking，第二次按下自带的 contextmenu 就放行了。预备状态在每次右键 mousedown 无论命中与否都消费掉；完成了手势的 mouseup 不预备（手势后紧接的右键仍是手势）。第一次的菜单在 mousedown 已被吞、无法事后补弹（content script 没有任何途径打开原生菜单，`chrome.contextMenus` 只能加项、合成事件 `isTrusted=false` 不弹、`chrome.debugger` 会常驻调试横幅），这是鼠标用户不按修饰键的唯一出路，Chrome 上的手势扩展（Smooth Gestures、crxMouse、SimpleMouseGestures 等）在 Mac 上都用这套。**`Shift+右键` 是逃生口**：mousedown 守卫 `if (menuOnDown && e.shiftKey)` 直接 return 不进 tracking，contextmenu 不被抑制，原生菜单照常弹
  - **双重判断**：mousedown 和 contextmenu listener 各自独立读 `e.shiftKey`。原因：Mac 上 mousedown→contextmenu 的派发顺序在不同 Chrome 版本/通道可能不一致，仅靠 mousedown 提前设 `suppressContext` 可能漏判；contextmenu listener 自己读 `e.shiftKey` 是兜底。mousedown 分支额外把 `suppressContext = false` 显式清掉，防止上次未拖动的 mouseup 残留把后续菜单吞掉
- **`isTrusted` 守卫**：mousedown/mousemove/wheel/mouseup 首行检查，合成事件不触发
- **单段阈值** `MIN_SEGMENT = 30` 像素：超过才记一次方向
- **总位移阈值** `MIN_GESTURE = 8` 像素：低于此值视为短按；Windows 放行原生菜单，macOS/Linux（菜单已在 mousedown 被吞）预备「双击右键」
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

**总开关 / 设置**

- `chrome.storage.sync.enableGestures`（boolean，默认 true，设置页顶部"功能开关"卡片）：手势总开关，关闭后 `mousedown` 直接 return，原生右键菜单完全不受影响
- 曾有 `gestureKeepMenu`（保留原生右键菜单）开关，2026-10 随双击右键落地一并移除：菜单策略按平台自动决定（见上文「识别逻辑」），options.js 启动时把它加进一次性 `storage.sync.remove` 清单，导入旧配置时它不在 `STORAGE_KEYS` 里会被 `validateImportedSettings` 忽略
- 启动时一次性读取，并监听 `chrome.storage.onChanged`：用户在设置页切换后所有页面**无需刷新**即可生效

### Prompt 模板

- 所有默认 prompt 在 `youtube/prompts.js`（`YTX.prompts.*`），content script 通过 `YTX.prompts.*` 引用
- 占位符：YouTube 功能用 `{transcript}`，翻译用 `{langInstruction}`
- 自定义 prompt 存储约定：**空字符串表示未自定义**，`getSettings()` 读取时回退到 `YTX.prompts.*` 默认值
- 设置页 UI 已移除自定义 prompt 编辑入口（options.html 不再有该卡片，options.js 仅保留 `ALL_PROMPT_KEYS` 用于导入/导出兼容老配置），但已存储的自定义 prompt 仍会被读取生效。如需新增编辑入口需要恢复 options.html 卡片 + options.js 的 promptCache/switchPromptTab 等逻辑

### 存储结构

**`chrome.storage.sync`**（跨设备同步）：
- `provider` — `'claude'` | `'openai'` | `'chatgpt'` | `'gemini'` | `'minimax'` | `'deepseek'` | `'kimi'` | `'sub2api'`
- `claudeKey`, `openaiKey`, `geminiKey`, `minimaxKey`, `deepseekKey`, `kimiKey`, `sub2apiKey` — 各 provider 的 API Key（chatgpt 无 key，OAuth 凭据在 local）
- `claudeModel`, `openaiModel`, `geminiModel`, `minimaxModel`, `deepseekModel`, `kimiModel`, `sub2apiModel`, `chatgptModel` — 各 provider 的模型 ID
- `sub2apiBaseUrl` — Sub2API 中转网关地址（不含路径后缀，由 `normalizeSub2ApiBase()` 自动剥离）
- `prompt`, `promptHtml`, `promptMindmap` — 自定义 prompt（注意 summary 的 key 是 `prompt` 而非 `promptSummary`，向后兼容；设置页 UI 已移除编辑入口，但 storage 已写入的值仍生效）
- `promptTranslateDict`, `promptTranslateSentence` — 翻译自定义 prompt（同上，UI 已移除）
- `generateAllSummary`, `generateAllMindmap`, `generateAllHtml` — 「全部生成」是否包含对应功能（boolean，默认 true，`!== false` 判断）
- `youtubePanelDefaultCollapsed` — YouTube 面板首次加载时是否默认折叠（boolean，默认 true，`!== false` 判断）
- `enableYoutube`, `enableTranslate`, `enableXhs`, `enableGestures` — 四大模块总开关（boolean，默认 true，`!== false` 判断），设置页顶部「功能开关」卡片；各 content script 启动时读取并监听 `chrome.storage.onChanged` 即时生效无需刷新（YouTube 关闭时 panel.js `onNavigate` 走 `!videoId` 清理路径拆面板，重新开启立即重注入面板并恢复缓存）
- `mindmapAlignTop` — 导图对齐偏好

**`chrome.storage.local`**（仅本地）：
- `chatgptAuth` — ChatGPT 订阅的 OAuth 凭据 `{ access_token, refresh_token, id_token, account_id }`，来自设置页粘贴的 `~/.codex/auth.json`；token 刷新后由 background 回写。不进 sync（体积/敏感性）、不随导入导出
- `fetchedModels_claude`, `fetchedModels_openai`, `fetchedModels_gemini`, `fetchedModels_deepseek`, `fetchedModels_kimi` — API 拉取的模型列表缓存。读取、拉取、合并、导入、导出均通过 `models.js` 当前预置白名单过滤，旧型号和未知型号不得回流为选项。预置始终保留，按 value 去重；`/v1/models` 的账号权限结果不能遮蔽当前预置系列。

**IndexedDB**（`AAtoolsCache` → `results` store）：
- 库在**扩展 origin**，由 background 独占读写；content 侧的 `YTX.cache` 只是 `CACHE_*` 消息的封装，本身不开这个库
- key 为 `videoId`，`cache.save(videoId, featureKey, data)` 合并写入
- content 侧仍会碰 IndexedDB 的唯一场景是**旧库一次性迁移**：早期版本把缓存写在页面 origin（`youtube.com`）下，`_migrateLegacy()` 逐条经 `CACHE_MIGRATE_RECORD` 搬进扩展库，确认落盘后再条件删除旧记录（内容未变才删）。不调用 `deleteDatabase`——旧版标签页可能长期持有连接，blocked 的删除请求无法取消并会阻塞后续 open

### 关键约定

- YouTube SPA 适配：监听 `yt-navigate-finish` 事件，同视频 + 面板已存在则跳过
- 面板注入：等待 `#secondary`/`#secondary-inner` 出现（轮询 30×500ms），prepend 到 `#secondary`
- 面板收起：保留 `YTX.panel` DOM 以继续接收流式消息，移除 resizer 恢复 YouTube 原布局；恢复时重建 resizer
- 可调分栏：`#ytx-resizer` 拖拽手柄，默认 3:2 分割，min secondary 440px
- 时间戳点击：面板级事件委托，匹配 `.ytx-timestamp, .ytx-ts`，设 `video.currentTime` 并 `play()`
- 时间线列表项：`YTX.renderMarkdown` 把以时间戳开头的列表项渲染成 `<li class="ytx-ts-item">时间戳<span class="ytx-ts-body">正文</span></li>`，content.css 用 flex 把它排成「时间戳 | 正文」两列，长句换行后与正文左缘对齐。总结模板（`YTX.prompts.DEFAULT`）的「时间线」栏目正是靠这一约定排版：一句话总结（加粗）→ `## 要点` → `## 时间线`，全文限 350 字（长视频 500 字）
- 所有 AI 输出默认要求简体中文
- options.js 设置页：所有输入 1.5s 防抖自动保存，import 需验证 `_meta.version` 为 `'AATube'` 或 `'AAtools'`
- 模型预置由 `models.js` 统一维护：Claude Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5，OpenAI 与 ChatGPT 的 GPT-6.1 Sol / GPT-6 Astra / GPT-6 Luna，Gemini 3.8 Flash / 3.5 Flash-Lite / 3.1 Pro Preview，MiniMax M3，DeepSeek V4.1 Flash / V4 Pro，Kimi K3。Sub2API 提供相同的 Claude 四系列、GPT 三系列和 Gemini 三系列最新选项，标注需要网关支持，移除 Gemini 2.5；视频转录仍固定 3.5 Flash-Lite。各系列发布节奏不同，版本数字不同不代表历史兼容选项。
- options.js 模型下拉框：只显示共享白名单，不追加“当前已保存”选项。初始化设置页、载入本地列表缓存、在线拉取、导入与导出均保持该约束；旧配置在初始化时迁移并写回，不能宣称仅修改代码就已更新用户浏览器中的 storage。Claude 与 Gemini 拉取完整分页，出现重复游标或超过 20 页时报错、不覆盖缓存。


### 旧模型配置迁移

更新后设置页初始化时，按以下规则迁移已存型号；后台请求也使用共享归一化规则。迁移后的可选型号仍必须属于该 provider 的当前白名单。

| 系列 | 当前迁移目标 |
|---|---|
| GPT Sol / Terra / 其他可迁移的旧 GPT 文本型号 | `gpt-6.1-sol` |
| GPT Astra / Pro | `gpt-6-astra` |
| GPT Luna / Mini / Nano | `gpt-6-luna` |
| Claude Fable / Mythos / 1.x / 2.x | `claude-fable-5-1` |
| Claude Opus / Sonnet | 各自对应的 5.5 型号 |
| Claude Haiku / Instant | `claude-haiku-5-5` |
| Gemini Flash / Flash-Lite / Pro | 分别为 3.8 Flash / 3.5 Flash-Lite / 3.1 Pro Preview（含 Sub2API） |
| Kimi / Moonshot | `kimi-k3` |
| MiniMax | `MiniMax-M3` |
| DeepSeek Flash / Pro | 分别为 `deepseek-flash` / `deepseek-v4-pro` |

无法映射到当前系列的型号回退到提供商默认值；网关自定义旧别名、已拉取列表和导入文件都不能扩展可选白名单；参数策略仅覆盖当前目录。

### 设置页保存与回归验证

- 授权粘贴保存可取消防抖，清除时先清输入框；授权写入/删除串行执行并带修订号，旧回调不得恢复已清除凭据或抹掉新粘贴。
- `saveSettings()` 返回 Promise<boolean>；导出先等待当前表单落盘，失败/初始化未完成/导入中不下载旧配置。
- `tests/options-events.test.js` 执行实际 DOMContentLoaded 事件链，覆盖授权清除、延迟保存、导出与分页；`tests/models.test.js` 验证当前型号白名单、按系列迁移与端点过滤。
- `tests/gestures.test.js` 用假 `document`/`chrome`/定时器把 gestures.js 跑在 vm 里，按平台驱动 mousedown/mousemove/mouseup/contextmenu 序列，覆盖双击右键放行、窗口过期与距离超限、手势后不预备、Shift 逃生口、Linux 同策略、Windows 短按弹菜单/拖动吞菜单与总开关关闭。
- 验证命令仍为 `node --test tests/*.test.js`，使用桩验证协议，不向真实付费 API 发请求。
