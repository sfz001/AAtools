// 自定义 Prompt 在 storage 中的 key 名（设置页 UI 已移除，保留这些 key 仅用于导入/导出兼容老配置）
const ALL_PROMPT_KEYS = ['prompt', 'promptHtml', 'promptMindmap', 'promptTranslateDict', 'promptTranslateSentence'];

// ── Provider 配置 ────────────────────────────────────────────
const PROVIDERS = AATModels.providers;
const FETCHED_MODEL_KEYS = Object.keys(PROVIDERS).map(provider => 'fetchedModels_' + provider);

function latestModel(provider, value) {
  return AATModels.sanitizeModel(provider, value) || AATModels.defaults[provider];
}

// Return only model-field changes; startup migration must never save an
// incompletely initialized form or rewrite keys, prompts, or feature toggles.
function normalizeStoredModels(data, fallbackProvider) {
  const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, data.provider)
    ? data.provider : fallbackProvider;
  const models = {};
  const changes = {};
  const hasLegacy = Object.prototype.hasOwnProperty.call(data, 'model');
  Object.keys(PROVIDERS).forEach(id => {
    const field = id + 'Model';
    const value = data[field] || (id === provider ? data.model : '');
    models[id] = latestModel(id, value);
    if ((Object.prototype.hasOwnProperty.call(data, field) || (id === provider && hasLegacy)) &&
        data[field] !== models[id]) changes[field] = models[id];
  });
  if (hasLegacy && data.model !== models[provider]) changes.model = models[provider];
  return { models, changes };
}

function filterLatestModels(provider, models) {
  const values = new Set((Array.isArray(models) ? models : [])
    .filter(model => model && typeof model.value === 'string' && AATModels.isSelectable(provider, model.value))
    .map(model => model.value));
  return PROVIDERS[provider].models.filter(model => values.has(model.value))
    .map(model => ({ value: model.value, label: model.label }));
}

function cleanFetchedModelStorage(data) {
  const filtered = {};
  const changes = {};
  FETCHED_MODEL_KEYS.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) return;
    const provider = key.slice('fetchedModels_'.length);
    filtered[key] = filterLatestModels(provider, data[key]);
    fetchedModelsCache[provider] = filtered[key];
    if (JSON.stringify(data[key]) !== JSON.stringify(filtered[key])) changes[key] = filtered[key];
  });
  if (Object.keys(changes).length) {
    chrome.storage.local.set(changes, () => {
      if (chrome.runtime.lastError) showStatus('旧模型缓存清理失败：' + chrome.runtime.lastError.message, 'error');
    });
  }
  return filtered;
}

const $ = (sel) => document.querySelector(sel);

let currentProvider = 'claude';
// 导入设置期间为 true：此时内存缓存尚未刷新，任何保存都会覆盖刚导入的值
let importing = false;
// 初始 storage 读取成功前为 false：此时 keyCache/modelCache 还是空串占位，
// 任何自动保存都会把全部 provider 的 key 与模型清空
// （用 var 而非 let，测试需要能从外部翻转它）
var settingsLoaded = false;
let keyCache = { claudeKey: '', openaiKey: '', geminiKey: '', minimaxKey: '', deepseekKey: '', kimiKey: '', sub2apiKey: '' };
let modelCache = { claude: '', openai: '', gemini: '', minimax: '', deepseek: '', kimi: '', sub2api: '', chatgpt: '' };
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
    'generateAllHtml', 'enableYoutube', 'enableTranslate', 'enableXhs', 'enableGestures',
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
    const provider = key.slice('fetchedModels_'.length);
    localFiltered[key] = filterLatestModels(provider, models);
  });
  Object.assign(filtered, normalizeStoredModels(filtered, currentProvider).changes);
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
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel', 'chatgptModel',
    'sub2apiBaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml',
    'enableYoutube', 'enableTranslate', 'enableXhs',
    'enableGestures', 'gestureKeepMenu',
    ...ALL_PROMPT_KEYS,
  ];

  // 先加载已拉取的模型列表，再加载设置
  chrome.storage.local.get(FETCHED_MODEL_KEYS, (local) => {
    // 读失败时 Chrome 以无参数调用回调并设置 lastError；直接解引用会抛
    // TypeError，连带跳过下面那次真正关键的 sync.get
    if (chrome.runtime.lastError || !local) local = {};
    cleanFetchedModelStorage(local);

    chrome.storage.sync.get(STORAGE_KEYS, (data) => {
      if (chrome.runtime.lastError || !data) {
        // 设置没读出来就别让自动保存动 storage：内存缓存仍是空串占位，
        // 用户随便勾一下就会把所有服务商的 key 和模型覆盖成空
        showStatus('读取设置失败：' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || '未知错误') +
          '，请重新打开设置页', 'error');
        return;
      }
      settingsLoaded = true;
      keyCache.claudeKey = data.claudeKey || '';
      keyCache.openaiKey = data.openaiKey || '';
      keyCache.geminiKey = data.geminiKey || '';
      keyCache.minimaxKey = data.minimaxKey || '';
      keyCache.deepseekKey = data.deepseekKey || '';
      keyCache.kimiKey = data.kimiKey || '';
      keyCache.sub2apiKey = data.sub2apiKey || '';

      const normalized = normalizeStoredModels(data, 'claude');
      modelCache = normalized.models;
      if (Object.keys(normalized.changes).length) {
        chrome.storage.sync.set(normalized.changes, () => {
          if (chrome.runtime.lastError) showStatus('模型升级保存失败：' + chrome.runtime.lastError.message, 'error');
        });
      }
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
      switchProvider(currentProvider);

      const panelDefaultCollapsed = data.youtubePanelDefaultCollapsed !== false;
      $('#youtubePanelDefaultCollapsed').checked = panelDefaultCollapsed;
      $('#youtubePanelDefaultOpen').checked = !panelDefaultCollapsed;

      $('#generateAllSummary').checked = data.generateAllSummary !== false;
      $('#generateAllMindmap').checked = data.generateAllMindmap !== false;
      $('#generateAllHtml').checked = data.generateAllHtml !== false;

      $('#enableYoutube').checked = data.enableYoutube !== false;
      $('#enableTranslate').checked = data.enableTranslate !== false;
      $('#enableXhs').checked = data.enableXhs !== false;
      $('#enableGestures').checked = data.enableGestures !== false;
      $('#gestureKeepMenu').checked = !!data.gestureKeepMenu;

      var vb = document.getElementById('version-badge');
      if (vb) vb.textContent = 'v' + chrome.runtime.getManifest().version;
    });
  });

  // Provider select
  $('#providerSelect').addEventListener('change', (e) => {
    const cfg = PROVIDERS[currentProvider];
    if (cfg.keyField) keyCache[cfg.keyField] = $('#currentKey').value.trim();
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
    'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel', 'chatgptModel',
    'sub2apiBaseUrl', 'model',
    'youtubePanelDefaultCollapsed',
    'generateAllSummary', 'generateAllMindmap', 'generateAllHtml',
    'enableYoutube', 'enableTranslate', 'enableXhs',
    'enableGestures', 'gestureKeepMenu',
    'mindmapAlignTop',
    ...ALL_PROMPT_KEYS,
  ];

  const LOCAL_KEYS = FETCHED_MODEL_KEYS;

  $('#exportSettings').addEventListener('click', async () => {
    if (importing) { showStatus('设置正在导入，请刷新完成后再导出', 'error'); return; }
    autoSave.cancel();
    if (!await saveSettings(true) || importing) return;
    chrome.storage.sync.get(SETTING_KEYS, (syncData) => {
      if (chrome.runtime.lastError || !syncData) {
        showStatus('设置导出失败：' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || '无法读取设置'), 'error');
        return;
      }
      chrome.storage.local.get(LOCAL_KEYS, (localData) => {
        if (chrome.runtime.lastError || !localData) {
          showStatus('设置导出失败：' + ((chrome.runtime.lastError && chrome.runtime.lastError.message) || '无法读取模型列表'), 'error');
          return;
        }
        if (importing) return;
        const data = Object.assign({}, syncData, normalizeStoredModels(syncData, currentProvider).changes);
        // Export only current catalog models and remove stale cache entries on disk.
        Object.assign(data, cleanFetchedModelStorage(localData));
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
        // 导入到 reload 之间禁止一切保存：内存缓存仍是导入前的值，任何 saveSettings
        // 都会把刚导入的配置整体写回旧值。reload 会重新读 storage 并复位该标志。
        importing = true;
        chrome.storage.sync.set(filtered, () => {
          if (chrome.runtime.lastError) {
            importing = false;
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

  // ── ChatGPT 订阅授权（粘贴 ~/.codex/auth.json，存 storage.local 不同步）──
  let chatgptAuthRevision = 0;
  let chatgptAuthWriting = false;
  const chatgptAuthWrites = [];

  // Serialize saves and clears: a late completion from an older paste must not
  // restore cleared credentials or clear a newer paste.
  function queueChatgptAuthWrite(kind, auth, revision) {
    chatgptAuthWrites.push({ kind, auth, revision });
    drainChatgptAuthWrites();
  }

  function drainChatgptAuthWrites() {
    if (chatgptAuthWriting) return;
    const next = chatgptAuthWrites.shift();
    if (!next) return;
    if (next.kind === 'set' && next.revision !== chatgptAuthRevision) {
      drainChatgptAuthWrites();
      return;
    }
    chatgptAuthWriting = true;
    const done = () => {
      const error = chrome.runtime.lastError;
      chatgptAuthWriting = false;
      if (next.revision === chatgptAuthRevision) {
        if (error) {
          showStatus((next.kind === 'set' ? '授权保存失败：' : '授权清除失败：') + error.message, 'error');
        } else {
          if (next.kind === 'set') $('#chatgptAuthPaste').value = '';
          refreshChatgptAuthStatus();
          showStatus(next.kind === 'set' ? 'ChatGPT 订阅授权已保存（仅存本机）' : '已清除 ChatGPT 订阅授权', 'success');
        }
      }
      drainChatgptAuthWrites();
    };
    if (next.kind === 'set') chrome.storage.local.set({ chatgptAuth: next.auth }, done);
    else chrome.storage.local.remove('chatgptAuth', done);
  }

  function refreshChatgptAuthStatus() {
    const revision = chatgptAuthRevision;
    chrome.storage.local.get(['chatgptAuth'], (d) => {
      if (revision !== chatgptAuthRevision) return;
      const el = $('#chatgptAuthStatus');
      if (!el) return;
      const auth = d && d.chatgptAuth;
      if (!auth || !auth.access_token) { el.textContent = '未配置'; return; }
      let expText = '';
      try {
        const payload = auth.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const exp = JSON.parse(atob(payload)).exp;
        if (exp) expText = '，access token 有效期至 ' + new Date(exp * 1000).toLocaleString();
      } catch (_) {}
      el.textContent = '已配置 ✓' + expText + (auth.refresh_token ? '（过期自动刷新）' : '（无 refresh_token，过期需重新粘贴）');
    });
  }

  const saveChatgptAuthPaste = debounce(() => {
    const raw = $('#chatgptAuthPaste').value.trim();
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      showStatus('auth.json 解析失败：不是有效的 JSON', 'error');
      return;
    }
    // 兼容两种结构：{ tokens: { access_token, ... } } 或扁平 { access_token, ... }
    const t = parsed && parsed.tokens && parsed.tokens.access_token ? parsed.tokens : parsed;
    if (!t || typeof t.access_token !== 'string' || !t.access_token) {
      showStatus('auth.json 中没有 access_token，请粘贴完整文件内容', 'error');
      return;
    }
    const auth = {
      access_token: t.access_token,
      refresh_token: t.refresh_token || '',
      id_token: t.id_token || '',
      account_id: t.account_id || parsed.account_id || '',
    };
    queueChatgptAuthWrite('set', auth, chatgptAuthRevision);
  }, 600);
  $('#chatgptAuthPaste').addEventListener('input', () => {
    chatgptAuthRevision++;
    saveChatgptAuthPaste();
  });

  $('#chatgptAuthClear').addEventListener('click', () => {
    chatgptAuthRevision++;
    saveChatgptAuthPaste.cancel();
    $('#chatgptAuthPaste').value = '';
    queueChatgptAuthWrite('remove', null, chatgptAuthRevision);
  });

  refreshChatgptAuthStatus();

  // 自动保存：监听所有表单变化，debounce 1.5 秒。
  // 排除 <input type="file">：选择导入文件也会派发 change，1.5s 后的自动保存会用
  // 导入前的 keyCache/modelCache 覆盖刚写入的设置（带网关的导入要 1800ms 才 reload）。
  const autoSave = debounce(() => saveSettings(false), 1500);
  document.querySelectorAll('input:not([type="file"]), select, textarea').forEach(el => {
    el.addEventListener('input', autoSave);
    el.addEventListener('change', autoSave);
  });

  // 设置页作为 popup 运行时，点击弹窗外部会立即销毁文档，挂起的防抖保存随之丢失。
  // 隐藏/卸载前冲刷：storage.set 的 IPC 在文档销毁前已发出，回调不执行也能落盘。
  const flushPending = () => {
    autoSave.flush();
    saveChatgptAuthPaste.flush();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPending();
  });
  window.addEventListener('pagehide', flushPending);
});

// 缓存已拉取的模型列表（从 storage.local 加载）
let fetchedModelsCache = {};

// 模型可用性、兼容别名与默认值统一由 models.js 管理。
function switchProvider(id) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, id)) id = 'claude';
  currentProvider = id;
  const cfg = PROVIDERS[id];

  $('#providerSelect').value = id;

  $('#keyLabel').textContent = cfg.label;
  $('#currentKey').placeholder = cfg.placeholder;
  $('#currentKey').value = cfg.keyField ? (keyCache[cfg.keyField] || '') : '';
  $('#currentKey').type = 'password';
  $('#helpLink').href = cfg.helpUrl;

  // sub2api 专属 base URL 字段
  $('#sub2apiBaseUrlField').style.display = (id === 'sub2api') ? '' : 'none';
  // chatgpt 专属授权粘贴区；无 API key 的 provider 隐藏通用 key 输入框
  $('#chatgptAuthField').style.display = (id === 'chatgpt') ? '' : 'none';
  $('#apiKeyField').style.display = cfg.keyField ? '' : 'none';

  // Only the latest catalog is selectable; old saved values migrate by family.
  const models = cfg.models;
  const selected = latestModel(id, modelCache[id]);
  modelCache[id] = selected;
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
  if (models.some(model => model.value === selected)) select.value = selected;
}

function showStatus(text, type) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2000);
}

// ── 从官网获取最新模型列表 ──────────────────────────────────
async function fetchLatestModels() {
  // 快照 provider：拉取是异步的，期间用户可能切换服务商。await 之后再读全局
  // currentProvider，会把 A 家的模型列表写进 B 家的缓存并持久化到 storage.local。
  const provider = currentProvider;
  if (provider === 'chatgpt') {
    showStatus('ChatGPT 订阅模式使用预置模型列表，无需在线获取', 'error');
    return;
  }
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
    const fetcher = MODEL_FETCHERS[provider];
    if (!fetcher) {
      showStatus('当前服务商不支持获取模型列表', 'error');
      return;
    }
    const fetched = await fetcher(key);
    // The server may still advertise older generations; retain only this catalog.
    const models = filterLatestModels(provider, fetched);

    // 保存到本地 + 内存缓存（一律按快照的 provider 落位）
    fetchedModelsCache[provider] = models;
    chrome.storage.local.set({ ['fetchedModels_' + provider]: models });

    // 用户已经切走时只落缓存，不去动当前显示的下拉框
    if (provider !== currentProvider) {
      showStatus('已获取 ' + models.length + ' 个模型（已存入该服务商）', 'success');
      return;
    }

    const prev = latestModel(provider, $('#model').value);
    populateModelSelect(PROVIDERS[provider].models, prev);

    showStatus(models.length ? '已核对 ' + models.length + ' 个最新型号' : '该账户列表未返回当前目录中的最新型号', models.length ? 'success' : 'error');
  } catch (err) {
    showStatus('获取失败: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  }
}

// ── 防抖：等用户停止操作一段时间后才执行 ──────────────────
// 带 flush()：设置页是 action.default_popup，弹窗失焦即销毁文档，挂起的
// setTimeout 会随之丢弃。页面隐藏/卸载前调 flush() 立刻落盘。
function debounce(fn, ms) {
  let timer = null;
  const wrapped = function () {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  wrapped.cancel = function () {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = function () {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    return fn();
  };
  return wrapped;
}

// ── 保存设置（isManual=true 显示提示，false 静默）─────────────
function saveSettings(isManual, gatewayProvider, gatewayBaseOverride) {
  // 导入进行中：内存缓存还是导入前的旧值，写回会整体覆盖刚导入的设置
  if (importing) return Promise.resolve(false);
  // 初始读取失败时缓存仍是空串占位，写回会清空全部 provider 的 key 与模型
  if (!settingsLoaded) {
    if (isManual) showStatus('设置尚未加载完成，请重新打开设置页后再保存', 'error');
    return Promise.resolve(false);
  }
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

  // 把当前表单值同步到缓存（chatgpt 无 keyField，授权走 storage.local 单独保存）
  if (cfg.keyField) keyCache[cfg.keyField] = $('#currentKey').value.trim();
  modelCache[currentProvider] = latestModel(currentProvider, $('#model').value);
  Object.keys(PROVIDERS).forEach(provider => {
    modelCache[provider] = latestModel(provider, modelCache[provider]);
  });

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
    chatgptModel: modelCache.chatgpt,
    sub2apiBaseUrl: sub2apiBaseUrl,
    model: modelCache[currentProvider],
    youtubePanelDefaultCollapsed: $('#youtubePanelDefaultCollapsed').checked,
    generateAllSummary: $('#generateAllSummary').checked,
    generateAllMindmap: $('#generateAllMindmap').checked,
    generateAllHtml: $('#generateAllHtml').checked,
    enableYoutube: $('#enableYoutube').checked,
    enableTranslate: $('#enableTranslate').checked,
    enableXhs: $('#enableXhs').checked,
    enableGestures: $('#enableGestures').checked,
    gestureKeepMenu: $('#gestureKeepMenu').checked,
  };

  return new Promise((resolve) => {
    chrome.storage.sync.set(saveData, () => {
      if (chrome.runtime.lastError) {
        if (gatewayProvider) setSavedGatewayBase(gatewayProvider, oldGatewayBase);
        if (attemptedGatewayOrigin && attemptedGatewayOrigin !== oldGatewayOrigin) revokeGatewayOriginIfUnused(attemptedGatewayOrigin);
        if (isManual) showStatus('设置保存失败：' + chrome.runtime.lastError.message, 'error');
        resolve(false);
        return;
      }
      if (gatewayProvider) {
        const newGatewayOrigin = gatewayOrigin(getSavedGatewayBase(gatewayProvider));
        if (oldGatewayOrigin && oldGatewayOrigin !== newGatewayOrigin) revokeGatewayOriginIfUnused(oldGatewayOrigin);
      }
      if (isManual) showStatus('设置已保存 ✓', 'success');
      resolve(true);
    });
  });
}

// Claude and Gemini list APIs paginate. Reject repeated cursors instead of
// hanging forever or persisting a partial list as a successful refresh.
async function fetchModelPages(initialUrl, requestOptions, listKey, cursorKey, cursorParam, moreKey) {
  const url = new URL(initialUrl);
  const records = [];
  const cursors = new Set();
  for (let page = 0; page < 20; page++) {
    const resp = await fetch(url.toString(), requestOptions);
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await resp.json();
    records.push(...(data[listKey] || []));
    const more = moreKey ? data[moreKey] : !!data[cursorKey];
    if (!more) return records;
    const cursor = data[cursorKey];
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
      throw new Error('模型列表分页游标无效，请稍后重试');
    }
    cursors.add(cursor);
    url.searchParams.set(cursorParam, cursor);
  }
  throw new Error('模型列表分页过多，请稍后重试');
}

const MODEL_FETCHERS = {
  async claude(key) {
    const records = await fetchModelPages('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    }, 'data', 'last_id', 'after_id', 'has_more');
    const models = records
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
      // Endpoint compatibility is filtered centrally by AATModels after fetch.
      .filter(m => m.id)
      .sort((a, b) => a.id < b.id ? 1 : -1)
      .map(m => ({ value: m.id, label: m.id }));
    return models;
  },

  async gemini(key) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('key', key);
    url.searchParams.set('pageSize', '100');
    const records = await fetchModelPages(url.toString(), undefined, 'models', 'nextPageToken', 'pageToken');
    const models = records
      // Provider metadata supplies generation support; the registry checks model families.
      .filter(m => m.name &&
        m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
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
      // 按名称降序让新模型线靠前（k3 > k2.7 > k2.6）；已退役的 moonshot-v1-* 等由 fetchLatestModels 统一剔除
      .sort((a, b) => b.value.localeCompare(a.value));
    return models;
  },

};
