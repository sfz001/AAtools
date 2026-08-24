# AAtools

自用 Chrome 扩展（Manifest V3）— AI 驱动的 **YouTube 视频助手** & **全网划词翻译** & **小红书体验增强** & **鼠标手势**。

原生 HTML/CSS/JS，零依赖，无构建步骤。支持 Claude / OpenAI / Gemini / MiniMax / DeepSeek / Kimi 六家 API，以及 ChatGPT 订阅模式和自定义 Sub2API 网关，共八路。

需要 Chrome 140 或更高版本；该下限用于确保 API Key 和 OAuth 凭据可被限制为只有受信任的扩展页面/后台能读取。

## 安装

### 从 Release 下载

1. 前往 [Releases](https://github.com/sfz001/AAtools/releases) 下载最新 `AAtools-vX.X.X.zip`
2. 解压到任意文件夹
3. 打开 `chrome://extensions/` → 开启「开发者模式」
4. 点击「加载已解压的扩展程序」→ 选择解压后的文件夹
5. 点击浏览器工具栏的扩展图标，配置 API Key

扩展更新或在 `chrome://extensions/` 中重新加载后，请刷新已打开的网页，让新版内容脚本生效。扩展不会为“免刷新”申请全站后台访问权限。

从旧版升级时，扩展会一次性撤销可能被 Chrome 保留的 `https://*/*` 全站权限。如已保存自定义 Sub2API 网关，请在设置页重新点击“授权域名”，以便只授权该精确域名。

### 从源码

```bash
git clone https://github.com/sfz001/AAtools.git
```

然后同上第 3–5 步。

## 配置

点击浏览器工具栏的扩展图标进入设置页。

### API Key

| 提供商 | 推荐模型 | 获取 Key |
|--------|----------|----------|
| Claude | Opus 5（通用起点；Fable 5 能力最强） | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| OpenAI | GPT-5.6 | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Gemini | Gemini 3.6 Flash | [AI Studio](https://aistudio.google.com/apikey) |
| MiniMax | MiniMax-M3 | [MiniMax Platform](https://platform.minimax.io/user-center/basic-information/interface-key) |
| DeepSeek | DeepSeek V4 Flash | [DeepSeek Platform](https://platform.deepseek.com/api_keys) |
| Kimi | Kimi K3 | [Kimi 开放平台](https://platform.kimi.com/console/api-keys) |

> 建议同时配置 Gemini Key：当视频无字幕时，扩展会自动调用 Gemini 视频模式转录内容。

API Key 与 ChatGPT 授权只保存在当前浏览器的受信任扩展存储中，不会同步到 Chrome 账号，网页内容脚本也无法读取。

### 可选配置

- **自定义 Sub2API 网关** — 填写 Base URL 后点击「授权域名」；扩展只请求该域名的可选访问权限，公网网关必须使用 HTTPS（localhost 可使用 HTTP）。网关 Key 会绑定到该精确 origin；若 Chrome Sync 并发冲突导致设置不一致，所有凭据请求会暂停，请检查设置、重新授权网关并手动保存。旧版升级后需重新授权一次
- **导出 Obsidian** — 总结/笔记/导图可一键下载为带 YAML frontmatter 的 `.md`，直接拖进 Vault 即可
- **设置导入/导出** — 导出非敏感配置与已拉取的模型列表；API Key 和 ChatGPT 授权默认且始终排除。旧版含 Key 的备份仍可导入，凭据会迁移到本机安全存储

---

## 功能一：YouTube 视频助手

打开任意 YouTube 视频页面，右侧栏顶部会注入 AAtools 面板。

### 四个标签页

| 标签 | 功能 |
|------|------|
| **总结** | 带时间戳的结构化摘要，点击时间戳跳转视频对应位置 |
| **导图** | 交互式思维导图（SVG 渲染），支持缩放、平移、折叠展开、新标签打开 |
| **笔记** | 精美 HTML 笔记（iframe 隔离渲染），可下载 / 新标签打开 / 导出 Obsidian |
| **问答** | 基于视频内容多轮对话，保留最近 40 条上下文；输入框运行在扩展来源的隔离 iframe 中 |

点击「全部生成」按钮可一键并行生成所有内容（问答除外），也可切到单个标签页单独生成。在设置页"YouTube 设置"卡片可勾选「全部生成」要包含哪些功能。

### 视频模式

无字幕视频会自动通过 Gemini 视频模式转录。有字幕但质量差（如自动生成）时，可手动点击「使用视频模式」切换。

> 视频模式仅用 Gemini 转录字幕，后续分析仍使用你选择的 AI 模型。

---

## 功能二：全网划词翻译

在任意网页选中文字，点击浮现的「译」图标即可翻译。

### 功能特性

- **智能双模式** — 自动识别单词（≤3 词）和句段，单词走词典格式（音标 + 词性 + 释义 + 搭配 + 例句），句段走纯翻译
- **语境查词** — 在翻译弹窗的原文区域中选中某个词，自动带上全文语境解释该词含义
- **多语言** — 支持自动检测、中/英/日/韩/法/德/西/俄 目标语言切换
- **弹窗交互** — 可拖拽、可固定（不随点击关闭），并可重新翻译当前选区。为防止宿主页面通过 capture 事件窃取新增输入，不提供同页自由编辑框
- **iframe 支持** — 在 HTTP(S) 子页和继承父页来源的 about:blank/blob/data 子页中处理选区；完全不透明的 sandbox 子页可能受 Chrome 资源隔离限制

---

## 功能三：小红书体验增强

在小红书浏览时自动生效，无需配置。

### 帖子弹窗滚动修复

- **问题** — 打开帖子弹窗后，滚动鼠标会导致背景页面滚动，而非帖子内容滚动到评论区
- **修复** — 自动检测帖子弹窗，拦截滚动事件穿透，确保弹窗内容正常滚动
- **检测方式** — 结构化检测（`position: fixed` 全屏覆盖），不依赖 CSS 类名，网站改版不影响

---

## 功能四：鼠标手势

任意网页按住鼠标右键拖动即可触发，可在设置页"鼠标手势设置"卡片一键启停。

| 手势 | 动作 |
|------|------|
| `←` | 后退 |
| `→` | 前进 |
| `↑` | 滚动到页面顶部 |
| `↓` | 滚动到页面底部 |
| `↑↓` | 刷新当前页面 |
| `↓→` | 关闭当前标签页 |
| `←↑` | 恢复刚关闭的标签页 |

屏幕中央实时显示手势提示；默认保留原生右键菜单，可在设置中关闭。

---

## 其他特性

- **可调分栏** — 拖拽视频与面板之间的分割条自由调整宽度
- **可配置默认状态** — 可在设置页选择 YouTube 面板默认折叠或默认打开
- **历史缓存** — 生成结果持久化到扩展自身的 IndexedDB，再次打开同一视频自动恢复；可在设置页用“清空全部本地缓存”一次删除。升级后不读取、不迁入 `youtube.com` 页面来源的旧缓存，并在启动时不读取内容地尝试删除专用旧库；新缓存从空开始。若旧 YouTube 标签的数据库连接阻塞删除，可关闭旧标签后刷新重试，或在 Chrome 站点数据中清理 `youtube.com`
- **亮/暗色适配** — 自动跟随 YouTube 主题
- **流式输出** — 所有 AI 生成均为流式渲染，实时显示进度
- **长请求稳定性** — AI 流、Gemini 视频转录和 ChatGPT 令牌刷新在扩展自带的隐藏 Worker 中执行，不依赖短生命周期 Service Worker 持续联网；空闲后自动关闭
- **自动保存** — 开关、单选等离散设置即时保存，文本输入防抖保存

## 开发

无构建、无第三方依赖。直接改代码：

1. `chrome://extensions/` → 加载已解压的扩展程序（项目根目录）
2. 修改代码后点击扩展页刷新图标，再刷新 YouTube 页面
3. 修改 `background.js` 后需在扩展页重新加载 Service Worker
4. 协议、缓存与权限测试：`node --test tests/*.test.js`

### 项目结构

```
├── background.js              # Service Worker：API 调用、字幕抓取、视频转录、缓存
├── offscreen/                 # 隐藏网络宿主 + Dedicated Worker：长请求、SSE 与 OAuth
├── manifest.json              # Manifest V3 配置
├── options.html/js/css        # 设置页
├── youtube/                   # YouTube 视频助手模块
│   ├── core.js                #   YTX 命名空间、共享状态、字幕获取、缓存
│   ├── prompts.js             #   所有功能的默认 Prompt
│   ├── markdown.js            #   Markdown 渲染
│   ├── export.js              #   导出（Markdown 下载 / Obsidian）
│   ├── summary.js             #   总结
│   ├── html-notes.js          #   HTML 笔记
│   ├── chat.js                #   问答
│   ├── chat-frame.html         #   扩展来源的隔离问答输入页
│   ├── chat-frame.js           #   问答输入与后台安全中继
│   ├── chat-frame.css          #   问答输入框样式
│   ├── mindmap.js             #   思维导图（SVG 引擎）
│   ├── panel.js               #   面板 UI + 消息路由（必须最后加载）
│   └── content.css            #   面板样式
├── translate/                 # 划词翻译模块
│   ├── translate.js           #   翻译功能（独立 IIFE，所有页面生效）
│   └── translate.css          #   翻译弹窗样式
├── xhs/                       # 小红书增强模块
│   └── xhs-scroll-fix.js      #   帖子弹窗滚动修复
└── gestures/                  # 鼠标手势模块
    └── gestures.js            #   右键拖拽手势识别（独立 IIFE）
```

## 许可

仅供个人使用。
