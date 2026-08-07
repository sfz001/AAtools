// 自定义 Prompt 在 storage 中的 key 名（设置页 UI 已移除，保留这些 key 仅用于导入/导出兼容老配置）
const ALL_PROMPT_KEYS = ['prompt', 'promptHtml', 'promptMindmap', 'promptTranslateDict', 'promptTranslateSentence'];

// ── Provider 配置 ────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    label: 'Claude API Key',
    keyField: 'claudeKey',
    placeholder: 'sk-ant-api03-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { value: 'claude-fable-5', label: 'Fable 5 — 推荐' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8 — 最强' },
    ]
  },
  openai: {
    label: 'OpenAI API Key',
    keyField: 'openaiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
    models: [
      // gpt-5.6 本身只是 gpt-5.6-sol 的别名，/v1/models 列表里只有带后缀的真名
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — 推荐（最强）' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — 均衡' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — 快速低价' },
    ]
  },
  gemini: {
    label: 'Gemini API Key',
    keyField: 'geminiKey',
    placeholder: 'AIza...',
    helpUrl: 'https://aistudio.google.com/apikey',
    models: [
      { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash — 推荐' },
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
  deepseek: {
    label: 'DeepSeek API Key',
    keyField: 'deepseekKey',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — 推荐' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — 更强' },
    ]
  },
  kimi: {
    label: 'Kimi API Key',
    keyField: 'kimiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.kimi.com/console/api-keys',
    models: [
      // kimi-k2.5 与 moonshot-v1 系列已停止向新注册用户开放，2026-08-31 全平台下线，故不预置
      { value: 'kimi-k2.6', label: 'Kimi K2.6 — 推荐（思考可关，最省）' },
      { value: 'kimi-k3', label: 'Kimi K3 — 最强（1M 上下文，思考恒开）' },
    ]
  },
  sub2api: {
    label: 'Sub2API API Key',
    keyField: 'sub2apiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://github.com/Wei-Shaw/sub2api',
    models: [
      { value: 'claude-fable-5', label: 'Claude Fable 5（走 /v1/messages）' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（走 /v1/messages）' },
      { value: 'gpt-5.6', label: 'GPT-5.6（走 /v1/responses）' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（走 /v1beta/...）' },
    ]
  }
};

const $ = (sel) => document.querySelector(sel);

let currentProvider = 'claude';
let keyCache = { claudeKey: '', openaiKey: '', geminiKey: '', minimaxKey: '', deepseekKey: '', kimiKey: '', sub2apiKey: '' };
let modelCache = { claude: '', openai: '', gemini: '', minimax: '', deepseek: '', kimi: '', sub2api: '' };
let sub2apiBaseUrl = '';

const SUB2API_BASE_INPUT = {
  sub2api: 'sub2apiBaseUrl',
};

function parseGatewayUrl(raw) {
  let url;
  try {
    url = new URL((raw || '').trim());
  } catch (_) {
    throw new Error('Base URL 格式无效');
  }
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('网关必须使用 HTTPS（localhost 可使用 HTTP）');
  }
  if (url.username || url.password) throw new Error('Base URL 不能包含用户名或密码');
  if (url.search || url.hash) throw new Error('Base URL 不能包含查询参数或锚点');
  return url;
}

function getSavedGatewayBase(provider) {
  if (provider === 'sub2api') return sub2apiBaseUrl;
  return '';
}

function setSavedGatewayBase(provider, value) {
  if (provider === 'sub2api') sub2apiBaseUrl = value;
}

function gatewayOrigin(raw) {
  if (!raw) return '';
  try { return parseGatewayUrl(raw).origin + '/*'; } catch (_) { return ''; }
}

function revokeGatewayOriginIfUnused(origin) {
  if (!origin) return;
  const requiredOrigins = new Set([
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://api.minimax.io/*',
    'https://api.deepseek.com/*',
    'https://api.moonshot.cn/*',
    'https://www.youtube.com/*',
  ]);
  if (requiredOrigins.has(origin)) return;
  const stillUsed = Object.keys(SUB2API_BASE_INPUT).some(provider => gatewayOrigin(getSavedGatewayBase(provider)) === origin);
  if (stillUsed) return;
  try {
    chrome.permissions.remove({ origins: [origin] }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
}

function validateImportedSettings(data, settingKeys, localKeys) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('设置文件格式无效');
  if (data.provider !== undefined && !Object.prototype.hasOwnProperty.call(PROVIDERS, data.provider)) {
    throw new Error('设置文件包含无效的 AI 服务商');
  }

  const booleanKeys = new Set([
    'youtubePanelDefaultCollapsed', 'generateAllSummary', 'generateAllMindmap',
    'generateAllHtml', 'enableGestures',
    'gestureKeepMenu', 'mindmapAlignTop',
  ]);
  const filtered = {};
  settingKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return;
    const value = data[key];
    if (booleanKeys.has(key)) {
      if (typeof value !== 'boolean') throw new Error('设置项 ' + key + ' 类型无效');
    } else {
      if (typeof value !== 'string' || value.length > 200000) throw new Error('设置项 ' + key + ' 类型或长度无效');
    }
    filtered[key] = value;
  });

  Object.keys(SUB2API_BASE_INPUT).forEach((provider) => {
    const key = SUB2API_BASE_INPUT[provider];
    if (filtered[key]) parseGatewayUrl(filtered[key]);
  });

  const localFiltered = {};
  localKeys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return;
    const models = data[key];
    if (!Array.isArray(models) || models.length > 1000 || models.some((model) =>
      !model || typeof model !== 'object' || typeof model.value !== 'string' ||
      typeof model.label !== 'string' || model.value.length > 500 || model.label.length > 500
    )) {
      throw new Error('模型列表 ' + key + ' 格式无效');
    }
    localFiltered[key] = models.map((model) => ({ value: model.value, label: model.label }));
  });
  return { filtered, localFiltered };
}

function requestGatewayPermission(provider, callback) {
  const inputId = SUB2API_BASE_INPUT[provider];
  const raw = inputId && $('#' + inputId).value.trim();
  if (!raw) {
    showStatus('请先填写 Base URL', 'error');
    callback(false, null);
    return;
  }

  let url;
  try {
    url = parseGatewayUrl(raw);
  } catch (err) {
    showStatus(err.message, 'error');
    callback(false, null);
    return;
  }

  chrome.permissions.request({ origins: [url.origin + '/*'] }, (granted) => {
    if (chrome.runtime.lastError) {
      showStatus('域名授权失败：' + chrome.runtime.lastError.message, 'error');
      callback(false, null);
      return;
    }
    if (!granted) {
      showStatus('未授权该网关域名，Sub2API 无法请求', 'error');
      callback(false, null);
      return;
    }
    callback(true, { provider: provider, baseUrl: raw, origin: url.origin });
  });
}

function saveAuthorizedGateway(authorization) {
  if (!authorization || !SUB2API_BASE_INPUT[authorization.provider]) return false;
  const input = $('#' + SUB2API_BASE_INPUT[authorization.provider]);
  const currentBaseUrl = input.value.trim();
  let currentUrl;
  try {
    currentUrl = parseGatewayUrl(currentBaseUrl);
  } catch (err) {
    showStatus(err.message, 'error');
    revokeGatewayOriginIfUnused(authorization.origin + '/*');
    return false;
  }
  if (currentUrl.origin !== authorization.origin) {
    showStatus('网关域名已变化，请重新点击“授权域名”', 'error');
    revokeGatewayOriginIfUnused(authorization.origin + '/*');
    return false;
  }
  saveSettings(true, authorization.provider, currentBaseUrl);
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  // 一次性迁移：移除旧版（已删除的 Notion / GitHub Gist 集成）残留 key
  // 这些字段现在不再被读取，但老用户的 storage.sync 里仍有，会跨设备同步占空间
  chrome.storage.sync.remove(['notionKey', 'notionPage', 'githubKey']);

  const STORAGE_KEYS = [
    'provider', 'claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'deepseekKey', 'kimiKey', 'sub2apiKey',
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel',
    'sub2apiBaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml',
    'enableGestures', 'gestureKeepMenu',
    ...ALL_PROMPT_KEYS,
  ];

  // 先加载已拉取的模型列表，再加载设置
  chrome.storage.local.get(['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini', 'fetchedModels_minimax', 'fetchedModels_deepseek', 'fetchedModels_kimi'], (local) => {
    if (local.fetchedModels_claude) fetchedModelsCache.claude = local.fetchedModels_claude;
    if (local.fetchedModels_openai) fetchedModelsCache.openai = local.fetchedModels_openai;
    if (local.fetchedModels_gemini) fetchedModelsCache.gemini = local.fetchedModels_gemini;
    if (local.fetchedModels_minimax) fetchedModelsCache.minimax = local.fetchedModels_minimax;
    if (local.fetchedModels_deepseek) fetchedModelsCache.deepseek = local.fetchedModels_deepseek;
    if (local.fetchedModels_kimi) fetchedModelsCache.kimi = local.fetchedModels_kimi;

    chrome.storage.sync.get(STORAGE_KEYS, (data) => {
      keyCache.claudeKey = data.claudeKey || '';
      keyCache.openaiKey = data.openaiKey || '';
      keyCache.geminiKey = data.geminiKey || '';
      keyCache.minimaxKey = data.minimaxKey || '';
      keyCache.deepseekKey = data.deepseekKey || '';
      keyCache.kimiKey = data.kimiKey || '';
      keyCache.sub2apiKey = data.sub2apiKey || '';

      modelCache.claude = data.claudeModel || '';
      modelCache.openai = data.openaiModel || '';
      modelCache.gemini = data.geminiModel || '';
      modelCache.minimax = data.minimaxModel || '';
      modelCache.deepseek = data.deepseekModel || '';
      modelCache.kimi = data.kimiModel || '';
      modelCache.sub2api = data.sub2apiModel || '';
      sub2apiBaseUrl = data.sub2apiBaseUrl || '';
      $('#sub2apiBaseUrl').value = sub2apiBaseUrl;

      // 一次性迁移：Sub2API #2/#3 槽位已移除。撤销其曾授权的网关域名权限
      // （若与 #1 相同则 revokeGatewayOriginIfUnused 会保留），再清掉残留 storage 键。
      // 必须放在 sub2apiBaseUrl 赋值之后，stillUsed 检查才准确。
      chrome.storage.sync.get(['sub2api2BaseUrl', 'sub2api3BaseUrl'], (legacy) => {
        [legacy.sub2api2BaseUrl, legacy.sub2api3BaseUrl].forEach((base) => {
          if (base) revokeGatewayOriginIfUnused(gatewayOrigin(base));
        });
        chrome.storage.sync.remove([
          'sub2api2Key', 'sub2api2Model', 'sub2api2BaseUrl',
          'sub2api3Key', 'sub2api3Model', 'sub2api3BaseUrl',
        ]);
      });

      currentProvider = Object.prototype.hasOwnProperty.call(PROVIDERS, data.provider) ? data.provider : 'claude';
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
    'provider', 'claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'deepseekKey', 'kimiKey', 'sub2apiKey',
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel',
    'sub2apiBaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml',
    'enableGestures', 'gestureKeepMenu',
    'mindmapAlignTop',
    ...ALL_PROMPT_KEYS,
  ];

  const LOCAL_KEYS = ['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini', 'fetchedModels_minimax', 'fetchedModels_deepseek', 'fetchedModels_kimi'];

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
        const imported = validateImportedSettings(data, SETTING_KEYS, LOCAL_KEYS);
        const filtered = imported.filtered;
        const localFiltered = imported.localFiltered;
        const previousGatewayOrigins = Object.keys(SUB2API_BASE_INPUT)
          .map(provider => gatewayOrigin(getSavedGatewayBase(provider)))
          .filter(Boolean);
        const importedGatewayBases = {};
        Object.keys(SUB2API_BASE_INPUT).forEach((provider) => {
          const key = SUB2API_BASE_INPUT[provider];
          importedGatewayBases[provider] = Object.prototype.hasOwnProperty.call(filtered, key)
            ? filtered[key]
            : getSavedGatewayBase(provider);
        });
        // 恢复已拉取的模型列表到 local（失败不阻断 sync 导入，仅提示）
        if (Object.keys(localFiltered).length > 0) {
          chrome.storage.local.set(localFiltered, () => {
            if (chrome.runtime.lastError) {
              showStatus('模型列表导入失败：' + chrome.runtime.lastError.message, 'error');
            }
          });
        }
        chrome.storage.sync.set(filtered, () => {
          if (chrome.runtime.lastError) {
            showStatus('设置导入失败：' + chrome.runtime.lastError.message, 'error');
            return;
          }
          Object.keys(importedGatewayBases).forEach(provider => setSavedGatewayBase(provider, importedGatewayBases[provider]));
          previousGatewayOrigins.forEach(revokeGatewayOriginIfUnused);
          const hasGateway = Object.values(SUB2API_BASE_INPUT).some(key => filtered[key]);
          showStatus(hasGateway ? '设置已导入；请重新授权 Sub2API 域名' : '设置已导入，正在刷新…', hasGateway ? 'error' : 'success');
          setTimeout(() => location.reload(), hasGateway ? 1800 : 600);
        });
      } catch (err) {
        showStatus(err && err.message ? err.message : '文件解析失败', 'error');
      }
    };
    reader.readAsText(file);
  });

  $('#save').addEventListener('click', () => {
    if (SUB2API_BASE_INPUT[currentProvider]) {
      if ($('#' + SUB2API_BASE_INPUT[currentProvider]).value.trim()) {
        const providerAtClick = currentProvider;
        requestGatewayPermission(providerAtClick, (granted, authorization) => {
          if (granted) saveAuthorizedGateway(authorization);
        });
      } else {
        saveSettings(true, currentProvider);
      }
    } else {
      saveSettings(true);
    }
  });

  $('#authorizeSub2api').addEventListener('click', () => {
    requestGatewayPermission('sub2api', (granted, authorization) => {
      if (granted) saveAuthorizedGateway(authorization);
    });
  });

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
// deepseek-chat / deepseek-reasoner 旧模型名已于 2026-07-24 退役（与 background.js 同款过滤）
const RETIRED_DEEPSEEK = /^deepseek-(chat|reasoner)$/;

function switchProvider(id) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, id)) id = 'claude';
  currentProvider = id;
  const cfg = PROVIDERS[id];

  $('#providerSelect').value = id;

  $('#keyLabel').textContent = cfg.label;
  $('#currentKey').placeholder = cfg.placeholder;
  $('#currentKey').value = keyCache[cfg.keyField] || '';
  $('#currentKey').type = 'password';
  $('#helpLink').href = cfg.helpUrl;

  // sub2api 专属 base URL 字段
  $('#sub2apiBaseUrlField').style.display = (id === 'sub2api') ? '' : 'none';

  // 预置与拉取列表合并；claude / deepseek 旧缓存里可能有已退役模型，过滤掉
  let models = mergeModels(cfg.models, fetchedModelsCache[id]);
  let selected = modelCache[id];
  if (id === 'claude') {
    models = models.filter(m => !RETIRED_CLAUDE.test(m.value));
    if (RETIRED_CLAUDE.test(selected)) selected = '';
  }
  if (id === 'deepseek') {
    models = models.filter(m => !RETIRED_DEEPSEEK.test(m.value));
    if (RETIRED_DEEPSEEK.test(selected)) selected = '';
  }
  populateModelSelect(models, selected);
}

// 预置模型与「从官网获取」的列表合并，预置在前、按 value 去重。
// 拉取列表不能直接替换预置：/v1/models 只返回该 key 有权访问的模型真名，既不含别名
// （gpt-5.6 → gpt-5.6-sol），组织未获得新模型权限时整代新模型也会整批缺席。直接替换会让
// 推荐模型从下拉里彻底消失，而且拉取结果持久缓存在 storage.local，换 key 后不重新拉取就一直被遮蔽。
function mergeModels(preset, fetched) {
  if (!fetched || !fetched.length) return preset;
  const seen = new Set(preset.map(m => m.value));
  return preset.concat(fetched.filter(m => !seen.has(m.value)));
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

    // 更新下拉框（同样与预置合并，拉不到的推荐模型不会因此消失）
    const prev = $('#model').value;
    populateModelSelect(mergeModels(PROVIDERS[currentProvider].models, models), prev);

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
function saveSettings(isManual, gatewayProvider, gatewayBaseOverride) {
  const cfg = PROVIDERS[currentProvider];

  const oldGatewayBase = gatewayProvider ? getSavedGatewayBase(gatewayProvider) : '';
  const oldGatewayOrigin = gatewayOrigin(oldGatewayBase);
  var attemptedGatewayOrigin = '';
  if (gatewayProvider) {
    var attemptedGatewayBase = gatewayBaseOverride !== undefined
      ? gatewayBaseOverride
      : $('#' + SUB2API_BASE_INPUT[gatewayProvider]).value.trim();
    attemptedGatewayOrigin = gatewayOrigin(attemptedGatewayBase);
    setSavedGatewayBase(gatewayProvider, attemptedGatewayBase);
  }

  // 把当前表单值同步到缓存
  keyCache[cfg.keyField] = $('#currentKey').value.trim();
  modelCache[currentProvider] = $('#model').value;

  const saveData = {
    provider: currentProvider,
    claudeKey: keyCache.claudeKey,
    openaiKey: keyCache.openaiKey,
    geminiKey: keyCache.geminiKey,
    minimaxKey: keyCache.minimaxKey,
    deepseekKey: keyCache.deepseekKey,
    kimiKey: keyCache.kimiKey,
    sub2apiKey: keyCache.sub2apiKey,
    claudeModel: modelCache.claude,
    openaiModel: modelCache.openai,
    geminiModel: modelCache.gemini,
    minimaxModel: modelCache.minimax,
    deepseekModel: modelCache.deepseek,
    kimiModel: modelCache.kimi,
    sub2apiModel: modelCache.sub2api,
    sub2apiBaseUrl: sub2apiBaseUrl,
    model: $('#model').value,
    youtubePanelDefaultCollapsed: $('#youtubePanelDefaultCollapsed').checked,
    generateAllSummary: $('#generateAllSummary').checked,
    generateAllMindmap: $('#generateAllMindmap').checked,
    generateAllHtml: $('#generateAllHtml').checked,
    enableGestures: $('#enableGestures').checked,
    gestureKeepMenu: $('#gestureKeepMenu').checked,
  };

  chrome.storage.sync.set(saveData, () => {
    if (chrome.runtime.lastError) {
      if (gatewayProvider) setSavedGatewayBase(gatewayProvider, oldGatewayBase);
      if (attemptedGatewayOrigin && attemptedGatewayOrigin !== oldGatewayOrigin) revokeGatewayOriginIfUnused(attemptedGatewayOrigin);
      if (isManual) showStatus('设置保存失败：' + chrome.runtime.lastError.message, 'error');
      return;
    }
    if (gatewayProvider) {
      const newGatewayOrigin = gatewayOrigin(getSavedGatewayBase(gatewayProvider));
      if (oldGatewayOrigin && oldGatewayOrigin !== newGatewayOrigin) revokeGatewayOriginIfUnused(oldGatewayOrigin);
    }
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

  async deepseek(key) {
    const resp = await fetch('https://api.deepseek.com/models', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.id)
      .map(m => ({ value: m.id, label: m.id }))
      .sort((a, b) => a.value.localeCompare(b.value));
    return models;
  },

  async kimi(key) {
    const resp = await fetch('https://api.moonshot.cn/v1/models', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    const models = (data.data || [])
      .filter(m => m.id)
      .map(m => ({ value: m.id, label: m.id }))
      // kimi-* 新模型线整体排在 legacy moonshot-*（2026-08-31 下线）之前，组内再按名称降序。
      // 单纯全局降序会因 'm' > 'k' 把 moonshot-* 顶到最前，与意图正好相反。
      .sort((a, b) => {
        const rank = m => (m.startsWith('kimi-') ? 0 : 1);
        return rank(a.value) - rank(b.value) || b.value.localeCompare(a.value);
      });
    return models;
  },

};
