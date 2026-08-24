# CLAUDE.md

本文件给在此仓库中工作的编码代理提供约束和架构说明。事实以代码、`manifest.json` 与测试为准；修改协议或安全边界时，应同步更新本文、`README.md`、`PRIVACY.md` 和测试。

## 项目概览

AAtools 是原生 HTML/CSS/JavaScript 编写的 Chrome Manifest V3 扩展，无构建步骤、无运行时第三方依赖。最低 Chrome 版本为 140。

主要功能：

1. YouTube 总结、结构化网页笔记、思维导图、问答与字幕/视频转录
2. HTTP(S) 页面划词翻译
3. 小红书帖子弹窗滚动修复
4. 鼠标手势

支持 Claude、OpenAI、ChatGPT 订阅、Gemini、MiniMax、DeepSeek、Kimi，以及用户明确授权域名的自定义 Sub2API 网关。

## 开发与验证

加载项目根目录为“已解压的扩展程序”。修改后在 `chrome://extensions/` 重新加载扩展，并刷新已打开的目标网页；扩展不会申请全站后台脚本权限来自动重注入旧标签页。

常用验证命令：

```bash
node --test tests/*.test.js
node --check background.js
git diff --check
```

涉及多个 JavaScript 文件时，对全部文件执行 `node --check`。协议、权限、存储或 UI 隔离有变化时必须补回归测试。

## 目录结构

```text
background.js               Service Worker：消息验证、配置、路由、字幕与缓存
offscreen/
  network-host.html/js      隐藏扩展页及私有 Port 宿主
  network-worker.js         长时网络请求、SSE、OAuth 刷新、视频转录
options.html/js/css         设置页
youtube/
  core.js                   YTX 共享状态、字幕、缓存协议与通用限制
  prompts.js                内置 Prompt
  markdown.js               有界 Markdown 渲染
  export.js                 本地 Markdown/Obsidian 导出
  summary.js                总结
  html-notes.js             结构化笔记解析、模板、隔离预览
  mindmap.js                思维导图
  chat.js                   问答状态与隔离输入框宿主
  chat-frame.html/js/css    扩展来源问答输入页
  panel.js                  面板、SPA/BFCache 生命周期、消息路由；最后加载
  content.css               面板样式
translate/                  划词翻译（独立 IIFE）
xhs/                        小红书增强（独立 IIFE）
gestures/                   鼠标手势（独立 IIFE）
tests/                      Node 协议、权限、竞态和内容脚本测试
```

## 请求架构

长请求不是由 Service Worker 直接 `fetch`：

```text
content script
  -> runtime message
Service Worker（校验 sender/字段/上限，读取受信任配置，登记 requestId）
  -> 私有 runtime Port
offscreen host -> Dedicated Worker（fetch/SSE/OAuth）
  -> 有界、合并后的事件
Service Worker
  -> tabs.sendMessage(tabId, ..., {frameId, documentId})
原始发起文档
```

Service Worker 可以随时重启，因此不能把请求正确性建立在仅内存状态上。offscreen 端负责持有实际网络任务和可确认的终态；握手会协调尚存任务。offscreen 空闲后应关闭，新任务再按需创建。宿主断线重连不得形成永久唤醒循环。

YouTube timed-text 字幕抓取是短请求例外，由 Service Worker 执行并有覆盖响应头和响应体的超时。不要把其他 AI/OAuth 长请求迁回 Service Worker。

### 消息与路由约束

- 所有 AI/转录请求都使用不可预测且格式受限的 `requestId`。
- 后台在承认启动前完成同步可验证项；拒绝返回明确错误，不得先返回 `started: true` 再静默丢失终态。
- 流式消息必须回传 `requestId`。YouTube 转录还必须回传 `videoId`。
- 后台交付必须绑定原始 `tabId`、`frameId`、`documentId`；不能把结果广播到同标签页的新文档。
- `panel.js` 只接受与当前 feature `requestId` 完全匹配的 `_MODEL/_CHUNK/_DONE/_ERROR`。
- 取消消息可能早于请求登记；后台的短期 tombstone 必须覆盖这个竞态。
- 导航、tab 关闭、BFCache `pagehide` 都要取消/失效在途工作；`pageshow.persisted` 必须重建状态，不能恢复带禁用按钮的旧快照。
- provider 小 chunk 必须在 Worker 侧按大小/时间合并；正文、错误体、JSON、SSE 行数和输出均需硬上限。
- 不完整、拒绝、超时和截断是不同终态。不得把部分输出标成完整成功或写成可信缓存。

主要 content → background 消息包括：`FETCH_TRANSCRIPT`、`SUMMARIZE`、`GENERATE_HTML`、`GENERATE_MINDMAP`、`CHAT_ASK`、`TRANSCRIBE_VIDEO`、`TRANSLATE`、`CANCEL_REQUEST`、缓存消息、设置事务消息和三个手势动作。

## YouTube 状态约定

所有 YouTube 脚本共享 `YTX`。`core.js` 必须先加载，`panel.js` 必须最后加载。

关键约束：

- 在每个异步入口早绑定 `currentVideoId`、request generation 和必要的 DOM 引用；每次 `await` 后重新校验。
- `ensureTranscript()` 同一视频复用 `_transcriptPromise`，切视频或文档离开时失效。
- `reset()` 必须取消 request、清定时器、清有界 buffer，并结算 deferred，不能留下几十分钟的悬挂 Promise。
- `generateAll()` 只组合功能模块公开的 `start()` Promise，不临时替换 handler。
- 时间戳必须先经 `safeTime`/数值校验再进入 DOM 或 URL。
- 所有模型文本都有字符/行/节点上限；不得对攻击者可控的大字符串做反复全量拼接或无界 DOM 追加。
- 面板使用 closed ShadowRoot。涉及新输入的问答框运行在 extension-origin sandbox iframe 中，并通过 capability token 与后台中继；不要退回宿主页可监听的 light-DOM 输入框。

### 字幕与视频模式

字幕先从当前 YouTube player 的 caption track/带 `pot` 的 timed-text 请求获取，再回退页面转录 DOM。请求必须校验 player/video ID，并设总 watchdog。没有可用字幕时，Gemini 视频模式在 offscreen Worker 中转录；后续总结仍用用户选定 provider。

视频转录使用 `videoId + requestId + documentId` 共同隔离。`TRANSCRIBE_SEGMENT` 是终态；终态前要刷完批处理 buffer。切视频、BFCache、超时或通信失败必须取消后台任务并 reject 对应 deferred。

### 缓存

生成结果保存在扩展来源 IndexedDB，不存进 `youtube.com` 页面来源。旧页面来源数据库只做不读取内容的 best-effort 删除，绝不迁入扩展权限域。

缓存清空使用持久化 epoch：

- 内容脚本生命周期启动时捕获 epoch。
- load 返回当前 epoch；save/remove 必须携带捕获的 epoch。
- clear 在单一事务中清记录并递增 epoch。
- 缺失或过期 epoch 的写入失败关闭，防止清空后的延迟任务复活数据。
- Incognito 不读写持久缓存，也不得修改普通窗口 epoch。

### 结构化网页笔记

`YTX.prompts.HTML` 要求模型输出结构化 JSON：`{summary, keyPoints:[{time,text}], sections:[{time,heading,text}], tags}`。`html-notes.js` 校验数据后用扩展内置模板生成页面。

兼容路径只允许通过 `isLegacyHtmlOutput()` 严格形态、长度和节点限制的历史完整 HTML，供历史缓存或仍在使用的自定义 `promptHtml`。不能把任意“JSON 解析失败”文本当原始 HTML 渲染。预览 iframe 不允许 `allow-same-origin`；生成 HTML 需 CSP 和 sanitizer。当前 sanitizer 删除 SVG/MathML/SMIL 等动态命名空间，而不是尝试维护不完整的危险属性黑名单。

Markdown/Obsidian 导出视为跨信任边界：转义 YAML，去活图片、链接、reference definition、wiki embed、自动链接和编码/转义后的危险协议。新增导出语法时补协议绕过测试。

## 其他内容脚本

### 划词翻译

- 只在可信用户选区动作后发送请求。
- 弹窗使用 closed ShadowRoot；宿主页内不提供自由编辑 textarea/contenteditable。
- 重新翻译使用当前页面选区；复制只能由明确按钮调用 Clipboard API。
- 支持可访问的 HTTP(S) frame，但 frame 结果必须回到原始 `documentId`。
- partial completion 显示“不完整”警告，不得使用成功状态颜色/文字。

### 小红书

仅在确认为 fixed overlay 且目标位于其可滚动区域时拦截 wheel。不要全页 capture 阻断普通滚动；DOM 变化需增量检查且 observer 工作量有界。

### 鼠标手势

仅顶层 frame 工作。所有动作要求可信事件；扩展特权动作必须检查后台 `{ok: true}`，失败给用户可见反馈。手势事件如果来自 AAtools 自身 Shadow/iframe UI，应直接忽略。关闭/恢复/强刷必须只作用于经过后台 sender 校验的目标。

## 安全、权限与存储

### 凭据

- API Key、ChatGPT access/refresh token 和 account ID 只存 `chrome.storage.local`。
- 启动时调用 `storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`；失败时敏感操作应 fail closed。
- 非敏感偏好放 `storage.sync`。旧版 sync 凭据在后台串行迁移并删除。
- 不持久化 ChatGPT `id_token`；导入时也只保留最小所需字段。
- 设置导出永远排除凭据；旧备份中的凭据可迁入 local，但不能重新写回 sync。

### 设置事务与网关授权

`storage.local` 和 `storage.sync` 没有跨 area 原子事务。设置保存/导入由后台串行事务处理：使用持久 revision/CAS、分区快照与冲突感知回滚，并把自定义网关权限的申请/撤销纳入成功或失败路径。外部 Chrome Sync 与回滚重叠时必须保留远端代际；若无法证明两区仍配对，持久 consistency fuse 会让所有 provider 读取 fail-closed。只有设置页明确发起的手动恢复事务才可清除 fuse；普通自动保存、模型缓存和 ChatGPT 单独授权事务均不得清除。Sub2API Key 只可在匹配的精确授权事务中绑定或改绑 origin，导入自定义网关必须重新精确授权。

必需 host permissions 只包含内置 provider、ChatGPT 和 YouTube；自定义网关通过 optional permission 精确授权。公网只允许 HTTPS，HTTP 仅允许 localhost/127.0.0.1。旧版遗留 `https://*/*` 授权在启动迁移中撤销。不要为了免刷新或自定义网关便利恢复必需的全站 host permission。

注意：content script 的 HTTP(S) `matches` 让本地 UI 在页面运行，不等同于允许 Service Worker 对任意网站发跨域请求。

### Web 内容边界

- 模型、字幕、页面 DOM、缓存和导入文件均视为不可信输入。
- 禁止远程代码、`eval`、内联事件 handler 和未清洗的 `innerHTML`。
- 对 extension iframe/Port/options 消息验证 sender URL、extension ID、frame/document 和 capability；不能只验证可伪造字段。
- UI 隔离不能只依赖 `stopPropagation`：宿主页 capture listener 更早执行，所以敏感输入必须放 extension-origin iframe。
- Offscreen 通信只使用经过身份验证的私有 Port，不使用页面可观察的广播通道。

## 文档维护

用户可见行为、最低 Chrome 版本、数据留存、第三方传输或权限变化时，必须同步更新 README 与隐私政策。不要在文档中声称尚未由代码和测试保证的生命周期、安全或兼容行为。
