// 自定义 Prompt 在 storage 中的 key 名（设置页 UI 已移除，保留这些 key 仅用于导入/导出兼容老配置）
const ALL_PROMPT_KEYS = ['prompt', 'promptHtml', 'promptCards', 'promptMindmap', 'promptVocab', 'promptTranslateDict', 'promptTranslateSentence'];

// ── Provider 配置 ────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    label: 'Claude API Key',
    keyField: 'claudeKey',
    placeholder: 'sk-ant-api03-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { value: 'claude-sonnet-5', label: 'Sonnet 5 — 推荐' },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — 更快' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8 — 最强' },
      { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — 上一代' },
    ]
  },
  openai: {
    label: 'OpenAI API Key',
    keyField: 'openaiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
    models: [
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini — 推荐' },
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano — 更快' },
      { value: 'gpt-5.5', label: 'GPT-5.5 — 最强' },
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
  },
  minimax: {
    label: 'MiniMax API Key',
    keyField: 'minimaxKey',
    placeholder: 'eyJ...',
    helpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    models: [
      { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5 — 推荐' },
      { value: 'MiniMax-M2.5-highspeed', label: 'MiniMax-M2.5 高速 — 更快' },
      { value: 'MiniMax-M2.1', label: 'MiniMax-M2.1' },
      { value: 'MiniMax-M2', label: 'MiniMax-M2' },
    ]
  },
  sub2api: {
    label: 'Sub2API #1 API Key',
    keyField: 'sub2apiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://github.com/Wei-Shaw/sub2api',
    models: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5（走 /v1/messages）' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5（走 /v1/messages）' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（走 /v1/messages）' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6（走 /v1/messages）' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini（走 /v1/responses）' },
      { value: 'gpt-5.4', label: 'GPT-5.4（走 /v1/responses）' },
      { value: 'gpt-5.5', label: 'GPT-5.5（走 /v1/responses）' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash（走 /v1beta/...）' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（走 /v1beta/...）' },
    ]
  },
  sub2api2: {
    label: 'Sub2API #2 API Key',
    keyField: 'sub2api2Key',
    placeholder: 'sk-...',
    helpUrl: 'https://github.com/Wei-Shaw/sub2api',
    models: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5（走 /v1/messages）' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5（走 /v1/messages）' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（走 /v1/messages）' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6（走 /v1/messages）' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini（走 /v1/responses）' },
      { value: 'gpt-5.4', label: 'GPT-5.4（走 /v1/responses）' },
      { value: 'gpt-5.5', label: 'GPT-5.5（走 /v1/responses）' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash（走 /v1beta/...）' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（走 /v1beta/...）' },
    ]
  },
  sub2api3: {
    label: 'Sub2API #3 API Key',
    keyField: 'sub2api3Key',
    placeholder: 'sk-...',
    helpUrl: 'https://github.com/Wei-Shaw/sub2api',
    models: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5（走 /v1/messages）' },
      { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5（走 /v1/messages）' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（走 /v1/messages）' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6（走 /v1/messages）' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini（走 /v1/responses）' },
      { value: 'gpt-5.4', label: 'GPT-5.4（走 /v1/responses）' },
      { value: 'gpt-5.5', label: 'GPT-5.5（走 /v1/responses）' },
      { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash（走 /v1beta/...）' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（走 /v1beta/...）' },
    ]
  }
};

const $ = (sel) => document.querySelector(sel);

let currentProvider = 'claude';
let keyCache = { claudeKey: '', openaiKey: '', geminiKey: '', minimaxKey: '', sub2apiKey: '', sub2api2Key: '', sub2api3Key: '' };
let modelCache = { claude: '', openai: '', gemini: '', minimax: '', sub2api: '', sub2api2: '', sub2api3: '' };
let sub2apiBaseUrl = '';
let sub2api2BaseUrl = '';
let sub2api3BaseUrl = '';

document.addEventListener('DOMContentLoaded', () => {
  // 一次性迁移：移除旧版（已删除的 Notion / GitHub Gist 集成）残留 key
  // 这些字段现在不再被读取，但老用户的 storage.sync 里仍有，会跨设备同步占空间
  chrome.storage.sync.remove(['notionKey', 'notionPage', 'githubKey']);

  const STORAGE_KEYS = [
    'provider', 'claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'sub2apiKey', 'sub2api2Key', 'sub2api3Key',
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'sub2apiModel', 'sub2api2Model', 'sub2api3Model',
    'sub2apiBaseUrl', 'sub2api2BaseUrl', 'sub2api3BaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml', 'generateAllCards', 'generateAllVocab',
    'enableGestures', 'gestureKeepMenu',
    ...ALL_PROMPT_KEYS,
  ];

  // 先加载已拉取的模型列表，再加载设置
  chrome.storage.local.get(['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini', 'fetchedModels_minimax'], (local) => {
    if (local.fetchedModels_claude) fetchedModelsCache.claude = local.fetchedModels_claude;
    if (local.fetchedModels_openai) fetchedModelsCache.openai = local.fetchedModels_openai;
    if (local.fetchedModels_gemini) fetchedModelsCache.gemini = local.fetchedModels_gemini;
    if (local.fetchedModels_minimax) fetchedModelsCache.minimax = local.fetchedModels_minimax;

    chrome.storage.sync.get(STORAGE_KEYS, (data) => {
      keyCache.claudeKey = data.claudeKey || '';
      keyCache.openaiKey = data.openaiKey || '';
      keyCache.geminiKey = data.geminiKey || '';
      keyCache.minimaxKey = data.minimaxKey || '';
      keyCache.sub2apiKey = data.sub2apiKey || '';
      keyCache.sub2api2Key = data.sub2api2Key || '';
      keyCache.sub2api3Key = data.sub2api3Key || '';

      modelCache.claude = data.claudeModel || '';
      modelCache.openai = data.openaiModel || '';
      modelCache.gemini = data.geminiModel || '';
      modelCache.minimax = data.minimaxModel || '';
      modelCache.sub2api = data.sub2apiModel || '';
      modelCache.sub2api2 = data.sub2api2Model || '';
      modelCache.sub2api3 = data.sub2api3Model || '';
      sub2apiBaseUrl = data.sub2apiBaseUrl || '';
      sub2api2BaseUrl = data.sub2api2BaseUrl || '';
      sub2api3BaseUrl = data.sub2api3BaseUrl || '';
      $('#sub2apiBaseUrl').value = sub2apiBaseUrl;
      $('#sub2api2BaseUrl').value = sub2api2BaseUrl;
      $('#sub2api3BaseUrl').value = sub2api3BaseUrl;

      currentProvider = data.provider || 'claude';
      if (!modelCache[currentProvider] && data.model) {
        modelCache[currentProvider] = data.model;
      }
      switchProvider(currentProvider);

      const panelDefaultCollapsed = data.youtubePanelDefaultCollapsed !== false;
      $('#youtubePanelDefaultCollapsed').checked = panelDefaultCollapsed;
      $('#youtubePanelDefaultOpen').checked = !panelDefaultCollapsed;

      $('#generateAllSummary').checked = data.generateAllSummary !== false;
      $('#generateAllMindmap').checked = data.generateAllMindmap !== false;
      $('#generateAllHtml').checked = data.generateAllHtml !== false;
      $('#generateAllCards').checked = !!data.generateAllCards;
      $('#generateAllVocab').checked = !!data.generateAllVocab;

      $('#enableGestures').checked = data.enableGestures !== false;
      $('#gestureKeepMenu').checked = !!data.gestureKeepMenu;

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

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#currentKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // 获取最新模型列表（两个按钮绑定同一逻辑）
  const handleFetchModels = () => fetchLatestModels();
  $('#fetchModels').addEventListener('click', handleFetchModels);
  $('#fetchModelsBtn').addEventListener('click', handleFetchModels);

  const SETTING_KEYS = [
    'provider', 'claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'sub2apiKey', 'sub2api2Key', 'sub2api3Key',
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'sub2apiModel', 'sub2api2Model', 'sub2api3Model',
    'sub2apiBaseUrl', 'sub2api2BaseUrl', 'sub2api3BaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml', 'generateAllCards', 'generateAllVocab',
    'enableGestures', 'gestureKeepMenu',
    'mindmapAlignTop',
    ...ALL_PROMPT_KEYS,
  ];

  const LOCAL_KEYS = ['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini', 'fetchedModels_minimax'];

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

// Claude 2.x / 3.x / instant 全系列已退役（API 返回 404）。
// 旧缓存的拉取列表里可能还留着，渲染前过滤；存量选中值命中时视为未选择，
// 让 UI 落到推荐默认值（与 background.js sanitizeModel 的回退行为一致）
const RETIRED_CLAUDE = /^claude-(2[.-]|instant|3-)/;

function switchProvider(id) {
  currentProvider = id;
  const cfg = PROVIDERS[id];

  $('#providerSelect').value = id;

  $('#keyLabel').textContent = cfg.label;
  $('#currentKey').placeholder = cfg.placeholder;
  $('#currentKey').value = keyCache[cfg.keyField] || '';
  $('#currentKey').type = 'password';
  $('#helpLink').href = cfg.helpUrl;

  // sub2api 专属 base URL 字段，每个 sub2api 实例独立显示
  $('#sub2apiBaseUrlField').style.display = (id === 'sub2api') ? '' : 'none';
  $('#sub2api2BaseUrlField').style.display = (id === 'sub2api2') ? '' : 'none';
  $('#sub2api3BaseUrlField').style.display = (id === 'sub2api3') ? '' : 'none';

  // 优先用拉取过的模型列表，否则用预设；claude 旧缓存里可能有已退役模型，过滤掉
  let models = fetchedModelsCache[id] || cfg.models;
  let selected = modelCache[id];
  if (id === 'claude') {
    models = models.filter(m => !RETIRED_CLAUDE.test(m.value));
    if (RETIRED_CLAUDE.test(selected)) selected = '';
  }
  populateModelSelect(models, selected);
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
  if (selected) {
    // 已存模型不在列表里时补一个选项显示真实值，
    // 否则 UI 会误显示第一项，随后任意 autoSave 都会把存量配置静默改写
    if (!models.some(m => m.value === selected)) {
      const opt = document.createElement('option');
      opt.value = selected;
      opt.textContent = selected + '（当前已保存）';
      select.appendChild(opt);
    }
    select.value = selected;
  }
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

  const saveData = {
    provider: currentProvider,
    claudeKey: keyCache.claudeKey,
    openaiKey: keyCache.openaiKey,
    geminiKey: keyCache.geminiKey,
    minimaxKey: keyCache.minimaxKey,
    sub2apiKey: keyCache.sub2apiKey,
    sub2api2Key: keyCache.sub2api2Key,
    sub2api3Key: keyCache.sub2api3Key,
    claudeModel: modelCache.claude,
    openaiModel: modelCache.openai,
    geminiModel: modelCache.gemini,
    minimaxModel: modelCache.minimax,
    sub2apiModel: modelCache.sub2api,
    sub2api2Model: modelCache.sub2api2,
    sub2api3Model: modelCache.sub2api3,
    sub2apiBaseUrl: $('#sub2apiBaseUrl').value.trim(),
    sub2api2BaseUrl: $('#sub2api2BaseUrl').value.trim(),
    sub2api3BaseUrl: $('#sub2api3BaseUrl').value.trim(),
    model: $('#model').value,
    youtubePanelDefaultCollapsed: $('#youtubePanelDefaultCollapsed').checked,
    generateAllSummary: $('#generateAllSummary').checked,
    generateAllMindmap: $('#generateAllMindmap').checked,
    generateAllHtml: $('#generateAllHtml').checked,
    generateAllCards: $('#generateAllCards').checked,
    generateAllVocab: $('#generateAllVocab').checked,
    enableGestures: $('#enableGestures').checked,
    gestureKeepMenu: $('#gestureKeepMenu').checked,
  };

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
