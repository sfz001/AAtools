# AAtools

Chrome 扩展 — AI 驱动的 YouTube 视频助手 & 全网划词翻译。

## 安装

### 方式一：从 Release 下载

1. 前往 [Releases](https://github.com/sfz001/AAtools/releases) 下载最新的 `AAtools-vX.X.X.zip`
2. 解压到任意文件夹
3. 打开 `chrome://extensions/` → 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」→ 选择解压后的文件夹
5. 点击浏览器工具栏的扩展图标，配置 API Key

### 方式二：从源码

```
git clone https://github.com/sfz001/AAtools.git
```

然后同上第 3-5 步。

## 配置 API Key

点击浏览器工具栏的扩展图标，打开设置页：

| 提供商 | 推荐模型 | 获取 Key |
|--------|----------|----------|
| Claude | Sonnet 4.6 | [Anthropic Console](https://console.anthropic.com/settings/keys) |
| OpenAI | GPT-5 mini | [OpenAI Platform](https://platform.openai.com/api-keys) |
| Gemini | Gemini 3 Flash | [AI Studio](https://aistudio.google.com/apikey) |

> **建议同时配置 Gemini Key**：当视频无字幕时，扩展会自动使用 Gemini 视频模式获取内容。你也可以手动点击「使用视频模式」来切换。

## 功能一：YouTube 视频助手

打开任意 YouTube 视频页面，右侧会出现 AAtools 面板：

### 全部生成

点击「全部生成」按钮，一键并行生成所有内容（总结 + 笔记 + 卡片 + 导图 + 词汇）。也可以切到单个标签页单独生成。

### 六个标签页

| 标签 | 说明 |
|------|------|
| **总结** | 生成带时间戳的结构化摘要，点击时间戳可跳转到视频对应位置 |
| **笔记** | 生成精美 HTML 笔记，可下载、在新标签打开、导出到 Notion |
| **问答** | 基于视频内容多轮对话，支持连续追问 |
| **卡片** | 提取关键概念，生成可翻转的知识闪卡 |
| **导图** | 生成交互式思维导图，支持缩放、折叠展开、新标签打开、导出 |
| **学英语** | 从英文字幕中提取高级词汇短语，附音标、释义、例句 |

### 视频模式

当视频没有字幕时，扩展会自动通过 Gemini 视频模式获取内容，面板顶部会显示提示条。

如果视频有字幕但质量较差（如自动生成的），你可以手动点击字幕区旁边的「使用视频模式」按钮切换。

> 注意：视频模式仅用 Gemini 获取字幕内容，后续的总结、卡片等分析仍然使用你选择的 AI 模型。

## 功能二：全网划词翻译

在任意网页上选中文字，即可弹出翻译窗口：

- 支持 Claude / OpenAI / Gemini 三种 AI 翻译
- 可选目标语言
- 支持固定弹窗、手动输入翻译
- 自动识别源语言

### 其他功能

- **可调分栏** — 拖拽视频和面板之间的分割条，自由调整宽度
- **历史缓存** — 已生成的结果会缓存，再次打开同一视频自动恢复
- **Notion 导出** — 在设置页填入 Notion Integration Token 和页面 ID，笔记和导图可一键导出
- **自定义 Prompt** — 在设置页可修改各功能的提示词
- **亮/暗色适配** — 自动跟随 YouTube 主题

## 许可

仅供个人使用。
