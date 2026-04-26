# AAtools

自用 Chrome 扩展（Manifest V3）— AI 驱动的 **YouTube 视频助手** & **全网划词翻译** & **小红书体验增强** & **鼠标手势**。

原生 HTML/CSS/JS，零依赖，无构建步骤。支持 Claude / OpenAI / Gemini / MiniMax 四家 API。

## 安装

### 从 Release 下载

1. 前往 [Releases](https://github.com/sfz001/AAtools/releases) 下载最新 `AAtools-vX.X.X.zip`
2. 解压到任意文件夹
3. 打开 `chrome://extensions/` → 开启「开发者模式」
4. 点击「加载已解压的扩展程序」→ 选择解压后的文件夹
5. 点击浏览器工具栏的扩展图标，配置 API Key

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
| Claude | Sonnet 4.6 | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| OpenAI | GPT-5 mini | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Gemini | Gemini 3 Flash | [AI Studio](https://aistudio.google.com/apikey) |

> 建议同时配置 Gemini Key：当视频无字幕时，扩展会自动调用 Gemini 视频模式转录内容。

### 可选配置

- **导出 Obsidian** — 总结/笔记/导图可一键下载为带 YAML frontmatter 的 `.md`，直接拖进 Vault 即可
- **设置导入/导出** — 支持将全部配置（含自定义 Prompt、已拉取的模型列表）导出为 JSON 文件，方便迁移

---

## 功能一：YouTube 视频助手

打开任意 YouTube 视频页面，右侧栏顶部会注入 AAtools 面板。

### 六个标签页

| 标签 | 功能 |
|------|------|
| **总结** | 带时间戳的结构化摘要，点击时间戳跳转视频对应位置 |
| **导图** | 交互式思维导图（SVG 渲染），支持缩放、平移、折叠展开、新标签打开 |
| **笔记** | 精美 HTML 笔记（iframe 隔离渲染），可下载 / 新标签打开 / 导出 Obsidian |
| **卡片** | 提取关键概念生成可翻转闪卡 |
| **单词** | 从英文字幕中提取高级词汇，附音标、词性、释义、原句、时间戳 |
| **问答** | 基于视频内容多轮对话，保留最近 40 条上下文 |

点击「全部生成」按钮可一键并行生成所有内容（问答除外），也可切到单个标签页单独生成。

### 视频模式

无字幕视频会自动通过 Gemini 视频模式转录。有字幕但质量差（如自动生成）时，可手动点击「使用视频模式」切换。

> 视频模式仅用 Gemini 转录字幕，后续分析仍使用你选择的 AI 模型。

### 自定义 Prompt

设置页可分别自定义五个功能的 Prompt 模板，用 `{transcript}` 占位符标记字幕插入位置。支持恢复单个/全部默认。

---

## 功能二：全网划词翻译

在任意网页选中文字，点击浮现的「译」图标即可翻译。

### 功能特性

- **智能双模式** — 自动识别单词（≤3 词）和句段，单词走词典格式（音标 + 词性 + 释义 + 搭配 + 例句），句段走纯翻译
- **语境查词** — 在翻译弹窗的原文区域中选中某个词，自动带上全文语境解释该词含义
- **多语言** — 支持自动检测、中/英/日/韩/法/德/西/俄 目标语言切换
- **弹窗交互** — 可拖拽、可固定（不随点击关闭）、可手动输入翻译、Ctrl+Enter 快捷发送
- **iframe 支持** — 自动 hook 页面内 iframe 中的选区

### 自定义 Prompt

设置页可分别自定义查词模式和翻译模式的 Prompt 模板，用 `{langInstruction}` 占位符标记目标语言指令插入位置。

---

## 功能三：小红书体验增强

在小红书浏览时自动生效，无需配置。

### 帖子弹窗滚动修复

- **问题** — 打开帖子弹窗后，滚动鼠标会导致背景页面滚动，而非帖子内容滚动到评论区
- **修复** — 自动检测帖子弹窗，拦截滚动事件穿透，确保弹窗内容正常滚动
- **检测方式** — 结构化检测（`position: fixed` 全屏覆盖），不依赖 CSS 类名，网站改版不影响

---

## 功能四：鼠标手势

任意网页按住鼠标右键拖动即可触发，可在设置页"功能开关"卡片一键启停。

| 手势 | 动作 |
|------|------|
| `←` | 后退 |
| `→` | 前进 |
| `↓→` | 关闭当前标签页 |
| `←↑` | 恢复刚关闭的标签页 |

屏幕中央实时显示手势提示，未达识别阈值时不影响原生右键菜单。

---

## 其他特性

- **可调分栏** — 拖拽视频与面板之间的分割条自由调整宽度
- **历史缓存** — 生成结果持久化到 IndexedDB，再次打开同一视频自动恢复
- **亮/暗色适配** — 自动跟随 YouTube 主题
- **流式输出** — 所有 AI 生成均为流式渲染，实时显示进度
- **自动保存** — 设置页所有修改 1.5 秒防抖自动保存

## 开发

无构建、无 lint、无测试。直接改代码：

1. `chrome://extensions/` → 加载已解压的扩展程序（项目根目录）
2. 修改代码后点击扩展页刷新图标，再刷新 YouTube 页面
3. 修改 `background.js` 后需在扩展页重新加载 Service Worker

### 项目结构

```
├── background.js              # Service Worker：API 调用、字幕抓取、视频转录
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
│   ├── cards.js               #   知识卡片
│   ├── mindmap.js             #   思维导图（SVG 引擎）
│   ├── vocab.js               #   词汇提取
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
