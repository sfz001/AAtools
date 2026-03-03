// ── 各功能默认 Prompt ────────────────────────────────────────
const DEFAULT_PROMPTS = {
  summary: `请对以下 YouTube 视频字幕内容进行总结。

## 输出格式：

### 摘要
3-5句话概述视频主要内容

### 关键要点
提取 3-5 个最重要的收获，每个一句话

### 详细内容
按内容分段，标注时间戳 [MM:SS]：
[00:00] 段落标题 - 要点描述
[02:30] 段落标题 - 要点描述

## 要求：
- 语言简洁，避免废话
- 关键要点不要跟摘要重复，要有信息增量
- 时间戳准确对应内容变化点
- 时间戳只用单个起始时间点格式 [0:00]，不要用时间范围 [0:00-0:32]

---
字幕内容：
{transcript}`,

  html: `【重要】无论字幕是什么语言，你必须全程使用简体中文，禁止使用其他任何语言。

请根据以下 YouTube 视频字幕内容，生成一个 HTML 笔记页面。

要求：
1. 必须使用简体中文，不要使用繁体中文
2. 输出完整的 HTML（包含 <style> 内联样式），不要包含 \`\`\`html 代码块标记
3. 使用现代美观的设计风格（渐变色标题、卡片布局、合理的间距和排版）
4. 包含：视频概述、关键要点（带时间戳）、详细内容分段
5. 时间戳格式 [MM:SS]，配以醒目样式
6. 配色方案使用紫色主题 (#7c3aed)
7. 响应式布局，max-width: 800px 居中

字幕内容：
{transcript}`,

  cards: `【重要】无论字幕是什么语言，你必须全程使用简体中文，禁止使用其他任何语言。

请根据以下 YouTube 视频字幕内容，生成知识卡片（Flashcards）用于学习复习。

要求：
1. 必须使用简体中文，不要使用繁体中文
2. 提取 10-20 个关键知识点
3. 每张卡片包含正面（问题/术语）和背面（解释/答案）
4. 如果有对应时间戳请标注 [MM:SS]
5. 严格按以下 JSON 格式输出，不要包含代码块标记：
[{"front":"问题或术语","back":"解释或答案","time":"MM:SS"},...]

字幕内容：
{transcript}`,

  mindmap: `【重要】无论字幕是什么语言，所有内容必须使用简体中文，禁止使用其他任何语言。

请根据以下 YouTube 视频字幕内容，生成一个结构化的思维导图 JSON 数据。

要求：
1. 输出一个嵌套的 JSON 对象树，根节点是视频主题
2. 每个节点格式：{"label": "节点标签", "time": "MM:SS", "children": [...]}
3. time 字段可选，表示该内容对应的视频时间戳，没有则留空字符串
4. 最多 4 层深度，每个节点标签不超过 30 个字
5. 第一层为主题分类（3-7个），第二层为具体要点，第三四层为细节
6. 严格输出 JSON，不要包含代码块标记或其他文字
7. 所有节点标签必须使用简体中文，不要使用繁体中文，即使原始字幕是英文也要翻译为简体中文

字幕内容：
{transcript}`,

  vocab: `请从以下 YouTube 视频英文字幕中提取约 50 个值得学习的词汇和短语。

字幕格式说明：每行格式为 [MM:SS] 文本内容，方括号内是该句在视频中的时间戳。

要求：
1. 优先选择：高级词汇、常用短语/搭配、学术词汇、地道表达、习语俚语
2. 严格跳过基础常见词汇（be/have/get/good/bad/big 等），目标难度：大学英语六级及以上
3. 每个词条包含：
   - word: 词汇或短语
   - phonetic: 音标
   - pos: 词性缩写（n./v./adj./phr. 等）
   - meaning: 简体中文释义
   - example: 该词所在的字幕原句（英文原文，不要翻译）
   - time: 必须是该词实际出现的那一行字幕前面的时间戳，直接从字幕中复制，不要编造
4. 严格按以下 JSON 格式输出，不要包含代码块标记或其他文字：
[{"word":"elaborate","phonetic":"/ɪˈlæb.ə.reɪt/","pos":"v.","meaning":"详细说明，阐述","example":"Can you elaborate on that point?","time":"2:30"}]

字幕内容：
{transcript}`,
};

// prompt 在 storage 中的 key 名
const PROMPT_STORAGE_KEYS = {
  summary: 'prompt',          // 向下兼容旧字段名
  html: 'promptHtml',
  cards: 'promptCards',
  mindmap: 'promptMindmap',
  vocab: 'promptVocab',
};

const ALL_PROMPT_KEYS = Object.values(PROMPT_STORAGE_KEYS);

// ── Provider 配置 ────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    label: 'Claude API Key',
    keyField: 'claudeKey',
    placeholder: 'sk-ant-api03-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — 推荐' },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — 更快' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6 — 最强' },
    ]
  },
  openai: {
    label: 'OpenAI API Key',
    keyField: 'openaiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
    models: [
      { value: 'gpt-5-mini', label: 'GPT-5 mini — 推荐' },
      { value: 'gpt-5-nano', label: 'GPT-5 nano — 更快' },
      { value: 'gpt-5.2', label: 'GPT-5.2 — 最强' },
    ]
  },
  gemini: {
    label: 'Gemini API Key',
    keyField: 'geminiKey',
    placeholder: 'AIza...',
    helpUrl: 'https://aistudio.google.com/apikey',
    models: [
      { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash-Lite — 最快' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash — 推荐' },
      { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro — 最强' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — 稳定' },
    ]
  }
};

const $ = (sel) => document.querySelector(sel);

let currentProvider = 'claude';
let currentPromptTab = 'summary';
let keyCache = { claudeKey: '', openaiKey: '', geminiKey: '' };
let modelCache = { claude: '', openai: '', gemini: '' };
// 各功能 prompt 缓存，切换 tab 时不丢失未保存的编辑
let promptCache = {};

function parseNotionPageId(input) {
  if (!input) return '';
  input = input.trim();
  var rawId = input.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(rawId)) return rawId;
  var match = input.match(/([0-9a-f]{32})/i);
  if (match) return match[1];
  return input;
}

document.addEventListener('DOMContentLoaded', () => {
  const STORAGE_KEYS = [
    'provider', 'claudeKey', 'openaiKey', 'geminiKey',
    'claudeModel', 'openaiModel', 'geminiModel', 'model',
    'notionKey', 'notionPage', 'githubKey',
    ...ALL_PROMPT_KEYS,
  ];

  // 先加载已拉取的模型列表，再加载设置
  chrome.storage.local.get(['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini'], (local) => {
    if (local.fetchedModels_claude) fetchedModelsCache.claude = local.fetchedModels_claude;
    if (local.fetchedModels_openai) fetchedModelsCache.openai = local.fetchedModels_openai;
    if (local.fetchedModels_gemini) fetchedModelsCache.gemini = local.fetchedModels_gemini;

    chrome.storage.sync.get(STORAGE_KEYS, (data) => {
      keyCache.claudeKey = data.claudeKey || '';
      keyCache.openaiKey = data.openaiKey || '';
      keyCache.geminiKey = data.geminiKey || '';

      modelCache.claude = data.claudeModel || '';
      modelCache.openai = data.openaiModel || '';
      modelCache.gemini = data.geminiModel || '';

      currentProvider = data.provider || 'claude';
      if (!modelCache[currentProvider] && data.model) {
        modelCache[currentProvider] = data.model;
      }
      switchProvider(currentProvider);

      // 加载各功能 prompt 到缓存
      Object.keys(PROMPT_STORAGE_KEYS).forEach(tab => {
        promptCache[tab] = data[PROMPT_STORAGE_KEYS[tab]] || '';
      });
      switchPromptTab('summary');

      $('#notionKey').value = data.notionKey || '';
      $('#notionPage').value = data.notionPage || '';
      $('#githubKey').value = data.githubKey || '';

      var vb = document.getElementById('version-badge');
      if (vb) vb.textContent = 'v' + chrome.runtime.getManifest().version;
    });
  });

  // Provider select
  $('#providerSelect').addEventListener('change', (e) => {
    const cfg = PROVIDERS[currentProvider];
    keyCache[cfg.keyField] = $('#currentKey').value.trim();
    modelCache[currentProvider] = $('#model').value;
    switchProvider(e.target.value);
  });

  // Prompt tab clicks
  document.querySelectorAll('.prompt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // 先把当前编辑存到缓存
      promptCache[currentPromptTab] = $('#prompt').value;
      switchPromptTab(tab.dataset.prompt);
    });
  });

  $('#resetPrompt').addEventListener('click', () => {
    $('#prompt').value = DEFAULT_PROMPTS[currentPromptTab] || '';
    promptCache[currentPromptTab] = $('#prompt').value;
    showStatus('已恢复当前默认 Prompt', 'success');
  });

  $('#resetAllPrompts').addEventListener('click', () => {
    Object.keys(DEFAULT_PROMPTS).forEach(tab => {
      promptCache[tab] = DEFAULT_PROMPTS[tab];
    });
    $('#prompt').value = promptCache[currentPromptTab];
    showStatus('已恢复所有默认 Prompt', 'success');
  });

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#currentKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // 获取最新模型列表（两个按钮绑定同一逻辑）
  const handleFetchModels = () => fetchLatestModels();
  $('#fetchModels').addEventListener('click', handleFetchModels);
  $('#fetchModelsBtn').addEventListener('click', handleFetchModels);

  $('#toggleNotionKey').addEventListener('click', () => {
    const input = $('#notionKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#toggleGithubKey').addEventListener('click', () => {
    const input = $('#githubKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  const SETTING_KEYS = [
    'provider', 'claudeKey', 'openaiKey', 'geminiKey',
    'claudeModel', 'openaiModel', 'geminiModel', 'model',
    'notionKey', 'notionPage', 'githubKey',
    'mindmapAlignTop',
    ...ALL_PROMPT_KEYS,
  ];

  const LOCAL_KEYS = ['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini'];

  $('#exportSettings').addEventListener('click', () => {
    chrome.storage.sync.get(SETTING_KEYS, (syncData) => {
      chrome.storage.local.get(LOCAL_KEYS, (localData) => {
        const data = Object.assign({}, syncData);
        // 已拉取的模型列表也导出
        LOCAL_KEYS.forEach(k => { if (localData[k]) data[k] = localData[k]; });
        data._meta = { exportedAt: new Date().toISOString(), version: 'AAtools' };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'aatools-settings.json';
        a.click();
        URL.revokeObjectURL(a.href);
        showStatus('设置已导出', 'success');
      });
    });
  });

  $('#importSettings').addEventListener('click', () => {
    $('#importFile').value = '';
    $('#importFile').click();
  });

  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data._meta || !['AATube', 'AAtools'].includes(data._meta.version)) {
          showStatus('无效的设置文件', 'error');
          return;
        }
        const filtered = {};
        SETTING_KEYS.forEach(k => { if (k in data) filtered[k] = data[k]; });
        // 恢复已拉取的模型列表到 local
        const localFiltered = {};
        LOCAL_KEYS.forEach(k => { if (k in data) localFiltered[k] = data[k]; });
        if (Object.keys(localFiltered).length > 0) chrome.storage.local.set(localFiltered);
        chrome.storage.sync.set(filtered, () => {
          showStatus('设置已导入，正在刷新…', 'success');
          setTimeout(() => location.reload(), 600);
        });
      } catch {
        showStatus('文件解析失败', 'error');
      }
    };
    reader.readAsText(file);
  });

  $('#save').addEventListener('click', () => saveSettings(true));

  // 自动保存：监听所有表单变化，debounce 1.5 秒
  const autoSave = debounce(() => saveSettings(false), 1500);
  document.querySelectorAll('input, select, textarea').forEach(el => {
    el.addEventListener('input', autoSave);
    el.addEventListener('change', autoSave);
  });
});

// 缓存已拉取的模型列表（从 storage.local 加载）
let fetchedModelsCache = {};

function switchProvider(id) {
  currentProvider = id;
  const cfg = PROVIDERS[id];

  $('#providerSelect').value = id;

  $('#keyLabel').textContent = cfg.label;
  $('#currentKey').placeholder = cfg.placeholder;
  $('#currentKey').value = keyCache[cfg.keyField] || '';
  $('#currentKey').type = 'password';
  $('#helpLink').href = cfg.helpUrl;

  // 优先用拉取过的模型列表，否则用预设
  const models = fetchedModelsCache[id] || cfg.models;
  populateModelSelect(models, modelCache[id]);
}

function populateModelSelect(models, selected) {
  const select = $('#model');
  select.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    select.appendChild(opt);
  });
  if (selected && models.some(m => m.value === selected)) {
    select.value = selected;
  }
}

function switchPromptTab(id) {
  currentPromptTab = id;
  document.querySelectorAll('.prompt-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.prompt === id);
  });
  // 显示缓存的值，空则显示默认
  $('#prompt').value = promptCache[id] || DEFAULT_PROMPTS[id] || '';
}

function showStatus(text, type) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2000);
}

// ── 从官网获取最新模型列表 ──────────────────────────────────
async function fetchLatestModels() {
  const key = $('#currentKey').value.trim();
  if (!key) {
    showStatus('请先填入 API Key', 'error');
    return;
  }

  const btn = $('#fetchModelsBtn');
  btn.disabled = true;
  btn.innerHTML = '<svg class="ytx-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>';
  showStatus('正在获取模型列表...', 'success');

  try {
    const fetcher = MODEL_FETCHERS[currentProvider];
    if (!fetcher) {
      showStatus('当前服务商不支持获取模型列表', 'error');
      return;
    }
    const models = await fetcher(key);
    if (!models || models.length === 0) {
      showStatus('未获取到可用模型', 'error');
      return;
    }

    // 保存到本地 + 内存缓存
    fetchedModelsCache[currentProvider] = models;
    const storageKey = 'fetchedModels_' + currentProvider;
    chrome.storage.local.set({ [storageKey]: models });

    // 更新下拉框
    const prev = $('#model').value;
    populateModelSelect(models, prev);

    showStatus('已获取 ' + models.length + ' 个模型', 'success');
  } catch (err) {
    showStatus('获取失败: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  }
}

// ── 防抖：等用户停止操作一段时间后才执行 ──────────────────
function debounce(fn, ms) {
  let timer;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// ── 保存设置（isManual=true 显示提示，false 静默）─────────────
function saveSettings(isManual) {
  const cfg = PROVIDERS[currentProvider];

  // 把当前表单值同步到缓存
  keyCache[cfg.keyField] = $('#currentKey').value.trim();
  modelCache[currentProvider] = $('#model').value;
  promptCache[currentPromptTab] = $('#prompt').value;

  const saveData = {
    provider: currentProvider,
    claudeKey: keyCache.claudeKey,
    openaiKey: keyCache.openaiKey,
    geminiKey: keyCache.geminiKey,
    claudeModel: modelCache.claude,
    openaiModel: modelCache.openai,
    geminiModel: modelCache.gemini,
    model: $('#model').value,
    notionKey: $('#notionKey').value.trim(),
    notionPage: parseNotionPageId($('#notionPage').value),
    githubKey: $('#githubKey').value.trim(),
  };

  // 各功能 prompt：空值不存（使用默认），有值才写入
  Object.keys(PROMPT_STORAGE_KEYS).forEach(tab => {
    const val = promptCache[tab] || '';
    const storageKey = PROMPT_STORAGE_KEYS[tab];
    if (val && val !== DEFAULT_PROMPTS[tab]) {
      saveData[storageKey] = val;
    } else {
      saveData[storageKey] = '';
    }
  });

  chrome.storage.sync.set(saveData, () => {
    if (isManual) showStatus('设置已保存 ✓', 'success');
  });
}

const MODEL_FETCHERS = {
  async claude(key) {
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.id && !m.id.includes('legacy'))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(m => ({ value: m.id, label: m.display_name || m.id }));
    return models;
  },

  async openai(key) {
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.id && /^(gpt-|o[1-9]|chatgpt-)/.test(m.id) && !m.id.includes('instruct') && !m.id.includes('realtime') && !m.id.includes('audio'))
      .sort((a, b) => a.id < b.id ? 1 : -1)
      .map(m => ({ value: m.id, label: m.id }));
    return models;
  },

  async gemini(key) {
    const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key);
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    const models = (data.models || [])
      .filter(m => m.name && m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => {
        const id = m.name.replace('models/', '');
        return { value: id, label: m.displayName || id };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    return models;
  },
};
