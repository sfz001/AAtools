// 自定义 Prompt 在 storage 中的 key 名（设置页 UI 已移除，保留这些 key 仅用于导入/导出兼容老配置）
const ALL_PROMPT_KEYS = ['prompt', 'promptHtml', 'promptMindmap', 'promptTranslateDict', 'promptTranslateSentence'];
const SECRET_SETTING_KEYS = ['claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'deepseekKey', 'kimiKey', 'sub2apiKey'];
const MODEL_CACHE_KEYS = ['fetchedModels_claude', 'fetchedModels_openai', 'fetchedModels_gemini', 'fetchedModels_minimax', 'fetchedModels_deepseek', 'fetchedModels_kimi'];
const GATEWAY_REAUTH_MARKER = 'gatewayPermissionReauthorizationRequired';
const SETTINGS_CONSISTENCY_ERROR_FIELD = 'settingsConsistencyErrorV1';
const SUB2API_KEY_ORIGIN_FIELD = 'sub2apiKeyOriginV1';
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CHATGPT_PASTE_CHARS = 1_000_000;
const SYNC_SETTING_KEYS = [
  'provider',
  'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel', 'chatgptModel',
  'sub2apiBaseUrl', 'model',
  'youtubePanelDefaultCollapsed',
  'generateAllSummary', 'generateAllMindmap', 'generateAllHtml',
  'enableYoutube', 'enableTranslate', 'enableXhs',
  'enableGestures', 'gestureKeepMenu',
  'mindmapAlignTop',
  ...ALL_PROMPT_KEYS,
];

function optionsStorageGet(area, fields) {
  return new Promise((resolve, reject) => {
    try {
      area.get(fields, (data) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || '读取设置失败'));
        else resolve(data || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function optionsStorageWrite(area, method, value) {
  return new Promise((resolve, reject) => {
    try {
      area[method](value, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || '写入设置失败'));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function decodeJwtClaims(token) {
  try {
    let payload = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    if (!payload || payload.length % 4 === 1) return null;
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(payload));
  } catch (_) {
    return null;
  }
}

function normalizeChatgptAuthInput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('auth.json 格式无效');
  const nested = parsed.tokens;
  const tokens = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : parsed;
  const source = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token == null ? '' : tokens.refresh_token,
    account_id: tokens.account_id == null ? (parsed.account_id == null ? '' : parsed.account_id) : tokens.account_id,
  };
  const limits = { access_token: 200000, refresh_token: 200000, account_id: 500 };
  for (const [field, limit] of Object.entries(limits)) {
    if (typeof source[field] !== 'string' || source[field].length > limit || (field === 'access_token' && !source[field])) {
      throw new Error(`auth.json 字段 ${field} 缺失、类型无效或过长`);
    }
  }
  return source;
}

let optionsSecretsMigrationPromise = null;
function migrateLegacySecrets() {
  if (optionsSecretsMigrationPromise) return optionsSecretsMigrationPromise;
  optionsSecretsMigrationPromise = new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'MIGRATE_SECRETS' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || '无法联系扩展后台'));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || '凭据迁移失败'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  }).catch((error) => {
    optionsSecretsMigrationPromise = null;
    throw error;
  });
  return optionsSecretsMigrationPromise;
}

function loadSettingsSnapshot() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'LOAD_SETTINGS_SNAPSHOT' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || '无法联系扩展后台'));
          return;
        }
        if (!response?.ok || !Number.isSafeInteger(response.revision) || response.revision < 0 ||
            !response.local || typeof response.local !== 'object' || Array.isArray(response.local) ||
            !response.sync || typeof response.sync !== 'object' || Array.isArray(response.sync)) {
          reject(new Error(response?.error || '设置快照格式无效'));
          return;
        }
        const warnings = Array.isArray(response.warnings)
          ? response.warnings.filter((warning) => typeof warning === 'string')
            .slice(0, 10).map((warning) => warning.slice(0, 1000))
          : [];
        resolve({ ...response, warnings });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// ── Provider 配置 ────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    label: 'Claude API Key',
    keyField: 'claudeKey',
    placeholder: 'sk-ant-api03-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { value: 'claude-opus-5', label: 'Opus 5 — 推荐（通用起点）' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5 — 速度/能力均衡' },
      { value: 'claude-fable-5', label: 'Fable 5 — 能力最强' },
      { value: 'claude-opus-4-8', label: 'Opus 4.8 — 旧版兼容' },
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
  chatgpt: {
    // ChatGPT 订阅（Codex OAuth）：无 API key，凭据为粘贴的 ~/.codex/auth.json（存 storage.local）
    label: 'ChatGPT 订阅授权',
    keyField: null,
    placeholder: '',
    helpUrl: 'https://developers.openai.com/codex/cli/',
    models: [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol — 推荐（最强）' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — 均衡' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — 快速' },
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
      { value: 'MiniMax-M3', label: 'MiniMax-M3 — 推荐（1M，多模态）' },
      { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7 — 兼容' },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax-M2.7 Highspeed — 更快' },
      { value: 'MiniMax-M2.5', label: 'MiniMax-M2.5 — 旧版兼容' },
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
      { value: 'kimi-k3', label: 'Kimi K3 — 推荐（1M 上下文）' },
      { value: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed — 代码高速度' },
      { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code — 代码场景' },
      { value: 'kimi-k2.6', label: 'Kimi K2.6 — 旧版兼容（思考可关）' },
    ]
  },
  sub2api: {
    label: 'Sub2API API Key',
    keyField: 'sub2apiKey',
    placeholder: 'sk-...',
    helpUrl: 'https://github.com/Wei-Shaw/sub2api',
    models: [
      { value: 'claude-opus-5', label: 'Claude Opus 5（走 /v1/messages）' },
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5（走 /v1/messages）' },
      { value: 'claude-fable-5', label: 'Claude Fable 5（走 /v1/messages）' },
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8（旧版兼容）' },
      { value: 'gpt-5.6', label: 'GPT-5.6（走 /v1/responses）' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash（走 /v1beta/...）' },
    ]
  }
};

const $ = (sel) => document.querySelector(sel);

let currentProvider = 'claude';
let keyCache = { claudeKey: '', openaiKey: '', geminiKey: '', minimaxKey: '', deepseekKey: '', kimiKey: '', sub2apiKey: '' };
let modelCache = { claude: '', openai: '', gemini: '', minimax: '', deepseek: '', kimi: '', sub2api: '', chatgpt: '' };
let sub2apiBaseUrl = '';
let settingsLoaded = false;
let settingsRevision = null;
let settingsRevisionConflictDetected = false;
let providerChangedDuringSettingsLoad = false;
const modelSelectionsDuringSettingsLoad = {};
let persistentStartupWarnings = [];
let settingsCommitTail = Promise.resolve();

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

function createGatewayPermissionAttemptId() {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
    if (typeof crypto?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch (_) {}
  return 'attempt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
}

function endGatewayPermissionAttempt(attemptId) {
  if (!attemptId) return;
  try {
    chrome.runtime.sendMessage({ type: 'GATEWAY_PERMISSION_ATTEMPT_END', attemptId }, () => {
      void chrome.runtime.lastError;
    });
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
      let maxLength = 200000;
      if (SECRET_SETTING_KEYS.includes(key)) maxLength = 10000;
      else if (key === 'sub2apiBaseUrl') maxLength = 2048;
      else if (key === 'model' || /Model$/.test(key)) maxLength = 500;
      else if (ALL_PROMPT_KEYS.includes(key)) maxLength = 50000;
      else if (key === 'provider') maxLength = 30;
      if (typeof value !== 'string' || value.length > maxLength) throw new Error('设置项 ' + key + ' 类型或长度无效');
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
    if (!Array.isArray(models) || models.length > MAX_FETCHED_MODELS || models.some((model) =>
      !model || typeof model !== 'object' || typeof model.value !== 'string' ||
      typeof model.label !== 'string' || model.value.length > 500 || model.label.length > 500
    )) {
      throw new Error('模型列表 ' + key + ' 格式无效');
    }
    localFiltered[key] = models.map((model) => ({ value: model.value, label: model.label }));
  });
  return { filtered, localFiltered };
}

function storageItemBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).byteLength;
}

function validateImportStorageQuota(syncData, localData) {
  let syncBytes = 0;
  for (const [key, value] of Object.entries(syncData)) {
    const bytes = storageItemBytes(key, value);
    if (bytes > 8000) throw new Error('设置项 ' + key + ' 超过 Chrome 同步单项配额');
    syncBytes += bytes;
  }
  if (syncBytes > 100000) throw new Error('导入的同步设置超过 Chrome 存储配额');
  const localBytes = storageItemBytes('import', localData);
  if (localBytes > MAX_IMPORT_FILE_BYTES) throw new Error('导入的本地设置超过 5 MiB 安全上限');
}

let settingsSaveVersion = 0;
function queueRevisionedOptionsMutation(buildMessage) {
  const run = settingsCommitTail.catch(() => {}).then(() => new Promise((resolve, reject) => {
    if (settingsRevisionConflictDetected) {
      reject(new Error('设置已在另一个页面中更改，请重新打开本页'));
      return;
    }
    if (!Number.isSafeInteger(settingsRevision) || settingsRevision < 0) {
      reject(new Error('设置版本尚未加载，请重新打开本页'));
      return;
    }
    const expectedRevision = settingsRevision;
    let message;
    try {
      message = buildMessage(expectedRevision);
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || '无法联系扩展后台'));
          return;
        }
        if (!response?.ok) {
          if (response?.conflict) settingsRevisionConflictDetected = true;
          reject(new Error(response?.error || '设置写入失败'));
          return;
        }
        if (!Number.isSafeInteger(response.revision) || response.revision !== expectedRevision + 1) {
          settingsRevisionConflictDetected = true;
          reject(new Error('后台返回的设置版本无效，请重新打开本页'));
          return;
        }
        settingsRevision = response.revision;
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  }));
  settingsCommitTail = run.catch(() => {});
  return run;
}

function commitStorageTransaction(transaction) {
  return queueRevisionedOptionsMutation((expectedRevision) => ({
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: { ...transaction, expectedRevision },
  }));
}

function commitChatgptAuthMutation(type, auth) {
  return queueRevisionedOptionsMutation((expectedRevision) => ({
    type,
    expectedRevision,
    ...(auth ? { auth } : {}),
  }));
}

function clearAllCachedResults() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({
        type: 'CACHE_CLEAR',
        incognito: chrome.extension?.inIncognitoContext === true,
      }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !response?.ok) {
          reject(new Error(runtimeError?.message || response?.error || '缓存清理失败'));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function commitImportedSettings(localImport, syncImport, gatewayPermissionChange) {
  validateImportStorageQuota(syncImport, localImport);
  try {
    await commitStorageTransaction({
      localSet: localImport,
      syncSet: syncImport,
      syncRemove: SECRET_SETTING_KEYS,
      localRemove: gatewayPermissionChange && !gatewayPermissionChange.newOrigin ? [GATEWAY_REAUTH_MARKER] : [],
      ...(gatewayPermissionChange ? { gatewayPermissionChange } : {}),
    });
  } catch (error) {
    throw new Error('导入' + (error.message || error));
  }
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

  const permissionAttemptId = createGatewayPermissionAttemptId();
  // Prompt 前先 best-effort 登记，尽量避免当前 SW 的 reconcile 误删。
  // 不等待回调，才能保留 permissions.request 要求的用户手势。
  try {
    chrome.runtime.sendMessage({
      type: 'GATEWAY_PERMISSION_ATTEMPT_BEGIN',
      attemptId: permissionAttemptId,
      origin: url.origin + '/*',
    }, () => { void chrome.runtime.lastError; });
  } catch (_) {}
  chrome.permissions.request({ origins: [url.origin + '/*'] }, (granted) => {
    if (chrome.runtime.lastError) {
      endGatewayPermissionAttempt(permissionAttemptId);
      showStatus('域名授权失败：' + chrome.runtime.lastError.message, 'error');
      callback(false, null);
      return;
    }
    if (!granted) {
      endGatewayPermissionAttempt(permissionAttemptId);
      showStatus('未授权该网关域名，Sub2API 无法请求', 'error');
      callback(false, null);
      return;
    }
    // 授权弹窗可以持续很久，期间 SW 可能重启并丢失上面的
    // 内存标记。授权成功后必须再登记一次并等待 ACK，然后才允许
    // 页面发起设置事务。后台提交时还会二次校验精确权限。
    try {
      chrome.runtime.sendMessage({
        type: 'GATEWAY_PERMISSION_ATTEMPT_BEGIN',
        attemptId: permissionAttemptId,
        origin: url.origin + '/*',
      }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError || !response?.ok) {
          endGatewayPermissionAttempt(permissionAttemptId);
          showStatus('无法确认网关授权：' + (runtimeError?.message || response?.error || '后台无响应'), 'error');
          callback(false, null);
          return;
        }
        callback(true, { provider: provider, baseUrl: raw, origin: url.origin, permissionAttemptId });
      });
    } catch (error) {
      endGatewayPermissionAttempt(permissionAttemptId);
      showStatus('无法确认网关授权：' + (error?.message || error), 'error');
      callback(false, null);
    }
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
    endGatewayPermissionAttempt(authorization.permissionAttemptId);
    return false;
  }
  if (currentUrl.origin !== authorization.origin) {
    showStatus('网关域名已变化，请重新点击“授权域名”', 'error');
    endGatewayPermissionAttempt(authorization.permissionAttemptId);
    return false;
  }
  const started = saveSettings(true, authorization.provider, currentBaseUrl, undefined, authorization.permissionAttemptId);
  if (started === false) {
    endGatewayPermissionAttempt(authorization.permissionAttemptId);
  }
  return started !== false;
}

function handleProviderChange(event) {
  const cfg = PROVIDERS[currentProvider];
  if (cfg.keyField) keyCache[cfg.keyField] = $('#currentKey').value.trim();
  modelCache[currentProvider] = $('#model').value;
  if (!settingsLoaded) providerChangedDuringSettingsLoad = true;
  switchProvider(event.target.value);
}

function handleModelChangeDuringLoad(event) {
  if (settingsLoaded) return;
  const model = boundedStoredString(event.target.value, 500);
  if (model) modelSelectionsDuringSettingsLoad[currentProvider] = model;
}

function setSettingsControlsReady(ready) {
  document.querySelectorAll('input, select, textarea, button').forEach((element) => {
    if (element.id === 'providerSelect' || element.id === 'model') return;
    element.disabled = !ready;
  });
  updateModelFetchButtons();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Provider rendering only depends on static presets, so make it usable before
  // contacting the service worker. A stale/restarting extension context must not
  // leave the page stuck on the HTML fallback label with an empty model list.
  const providerSelect = $('#providerSelect');
  providerSelect.addEventListener('change', handleProviderChange);
  $('#model').addEventListener('change', handleModelChangeDuringLoad);
  setSettingsControlsReady(false);
  switchProvider(Object.prototype.hasOwnProperty.call(PROVIDERS, providerSelect.value)
    ? providerSelect.value
    : 'claude');
  try {
    const versionBadge = document.getElementById('version-badge');
    if (versionBadge) versionBadge.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (_) {}

  let snapshot;
  try {
    snapshot = await loadSettingsSnapshot();
  } catch (error) {
    $('#currentKey').value = '';
    showPersistentStatus('设置安全加载失败；当前服务商和模型仅供查看，无法保存。请重新加载扩展后再打开本页：' + (error.message || error), 'error');
    return;
  }

  const local = snapshot.local;
  const data = snapshot.sync;
  const startupWarnings = Array.isArray(snapshot.warnings)
    ? snapshot.warnings.map((text) => ({ kind: 'background', text }))
    : [];
  settingsRevision = snapshot.revision;
  settingsRevisionConflictDetected = false;
  for (const provider of ['claude', 'openai', 'gemini', 'minimax', 'deepseek', 'kimi']) {
    const models = normalizeFetchedModels(local['fetchedModels_' + provider]);
    if (models.length) fetchedModelsCache[provider] = models;
  }

  keyCache.claudeKey = boundedStoredString(local.claudeKey, 10000);
  keyCache.openaiKey = boundedStoredString(local.openaiKey, 10000);
  keyCache.geminiKey = boundedStoredString(local.geminiKey, 10000);
  keyCache.minimaxKey = boundedStoredString(local.minimaxKey, 10000);
  keyCache.deepseekKey = boundedStoredString(local.deepseekKey, 10000);
  keyCache.kimiKey = boundedStoredString(local.kimiKey, 10000);
  keyCache.sub2apiKey = boundedStoredString(local.sub2apiKey, 10000);

  modelCache.claude = boundedStoredString(data.claudeModel, 500);
  modelCache.openai = boundedStoredString(data.openaiModel, 500);
  modelCache.gemini = boundedStoredString(data.geminiModel, 500);
  modelCache.minimax = boundedStoredString(data.minimaxModel, 500);
  modelCache.deepseek = boundedStoredString(data.deepseekModel, 500);
  modelCache.kimi = boundedStoredString(data.kimiModel, 500);
  modelCache.sub2api = boundedStoredString(data.sub2apiModel, 500);
  modelCache.chatgpt = boundedStoredString(data.chatgptModel, 500);
  for (const [provider, model] of Object.entries(modelSelectionsDuringSettingsLoad)) {
    if (Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) modelCache[provider] = model;
  }
  sub2apiBaseUrl = boundedStoredString(data.sub2apiBaseUrl, 2048);
  $('#sub2apiBaseUrl').value = sub2apiBaseUrl;
  if (keyCache.sub2apiKey && sub2apiBaseUrl && local[SUB2API_KEY_ORIGIN_FIELD] !== gatewayOrigin(sub2apiBaseUrl)) {
    startupWarnings.push({ kind: 'gateway', text: 'Sub2API Key 尚未绑定当前网关；请重新点击“授权域名”并保存' });
  }
  if (local[GATEWAY_REAUTH_MARKER] && sub2apiBaseUrl) {
    startupWarnings.push({ kind: 'gateway', text: '已移除旧版全站权限；请选择 Sub2API 并重新点击“授权域名”' });
  }
  if (local[SETTINGS_CONSISTENCY_ERROR_FIELD]) {
    startupWarnings.push({ kind: 'consistency', text: '检测到设置同步冲突；请检查当前服务商与网关地址，然后手动保存一次以恢复请求' });
  }

  const savedProvider = Object.prototype.hasOwnProperty.call(PROVIDERS, data.provider) ? data.provider : 'claude';
  if (!modelCache[savedProvider]) modelCache[savedProvider] = boundedStoredString(data.model, 500);
  const displayProvider = providerChangedDuringSettingsLoad ? currentProvider : savedProvider;
  switchProvider(displayProvider);

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
  $('#gestureKeepMenu').checked = data.gestureKeepMenu !== false;

  settingsLoaded = true;
  setSettingsControlsReady(true);
  setPersistentWarnings(startupWarnings);

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#currentKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // 获取最新模型列表（两个按钮绑定同一逻辑）
  const handleFetchModels = () => fetchLatestModels();
  $('#fetchModels').addEventListener('click', handleFetchModels);
  $('#fetchModelsBtn').addEventListener('click', handleFetchModels);

  const SETTING_KEYS = SYNC_SETTING_KEYS;
  const IMPORT_SETTING_KEYS = [...SYNC_SETTING_KEYS, ...SECRET_SETTING_KEYS];
  const LOCAL_KEYS = MODEL_CACHE_KEYS;
  let importInProgress = false;

  $('#exportSettings').addEventListener('click', () => {
    autoSave.cancel();
    // 先提交当前表单，再读取同步区；导出列表从定义上排除了 API Key/OAuth 凭据。
    saveSettings(false, undefined, undefined, (saveError) => {
      if (saveError) {
        showStatus('导出前保存失败：' + saveError.message, 'error');
        return;
      }
      (async () => {
        try {
          const [syncData, localData] = await Promise.all([
            optionsStorageGet(chrome.storage.sync, SETTING_KEYS),
            optionsStorageGet(chrome.storage.local, LOCAL_KEYS),
          ]);
          const data = Object.assign({}, syncData);
          // 已拉取的模型列表不含凭据，可安全导出。
          LOCAL_KEYS.forEach(k => { if (localData[k]) data[k] = localData[k]; });
          data._meta = { exportedAt: new Date().toISOString(), version: 'AAtools', credentialsIncluded: false };
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'aatools-settings.json';
          a.click();
          URL.revokeObjectURL(a.href);
          showStatus('设置已导出（不含 API Key/授权）', 'success');
        } catch (error) {
          showStatus('导出失败：' + (error.message || error), 'error');
        }
      })();
    });
  });

  $('#importSettings').addEventListener('click', () => {
    autoSave.cancel();
    $('#importFile').value = '';
    $('#importFile').click();
  });

  $('#clearAllCache').addEventListener('click', async () => {
    autoSave.cancel();
    if (!confirm('确定清空所有 YouTube 视频的本地字幕、总结、笔记和思维导图缓存吗？')) return;
    try {
      await clearAllCachedResults();
      showStatus('全部本地缓存已清空', 'success');
    } catch (error) {
      showStatus('缓存清理失败：' + (error.message || error), 'error');
    }
  });

  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!Number.isFinite(file.size) || file.size > MAX_IMPORT_FILE_BYTES) {
      importInProgress = false;
      showStatus('设置文件超过 5 MiB 安全上限', 'error');
      e.target.value = '';
      return;
    }
    importInProgress = true;
    autoSave.cancel();
    const reader = new FileReader();
    const handleReadFailure = (message) => {
      importInProgress = false;
      e.target.value = '';
      showStatus(message, 'error');
    };
    reader.onerror = () => handleReadFailure('设置文件读取失败');
    reader.onabort = () => handleReadFailure('设置文件读取已取消');
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data._meta || !['AATube', 'AAtools'].includes(data._meta.version)) {
          showStatus('无效的设置文件', 'error');
          importInProgress = false;
          e.target.value = '';
          return;
        }
        const imported = validateImportedSettings(data, IMPORT_SETTING_KEYS, LOCAL_KEYS);
        const filtered = imported.filtered;
        const localFiltered = imported.localFiltered;
        const importedSecrets = {};
        SECRET_SETTING_KEYS.forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(filtered, key)) return;
          importedSecrets[key] = filtered[key];
          delete filtered[key];
        });
        const importsGatewaySetting = Object.values(SUB2API_BASE_INPUT)
          .some(key => Object.prototype.hasOwnProperty.call(filtered, key));
        const importedGatewayBases = {};
        Object.keys(SUB2API_BASE_INPUT).forEach((provider) => {
          const key = SUB2API_BASE_INPUT[provider];
          importedGatewayBases[provider] = Object.prototype.hasOwnProperty.call(filtered, key)
            ? filtered[key]
            : getSavedGatewayBase(provider);
        });
        const hasGateway = Object.values(SUB2API_BASE_INPUT).some(key => Boolean(filtered[key]));
        const localImport = Object.assign({}, localFiltered, importedSecrets);
        if (hasGateway) localImport[GATEWAY_REAUTH_MARKER] = true;
        // storage.local/sync 没有跨 area 事务；辅助函数会快照并在任一步
        // 失败时回滚两个 area，避免凭据与非秘密设置处于半提交状态。
        const gatewayPermissionChange = importsGatewaySetting ? {
          provider: 'sub2api',
          oldOrigin: gatewayOrigin(getSavedGatewayBase('sub2api')),
          newOrigin: gatewayOrigin(filtered.sub2apiBaseUrl),
          attemptedOrigin: '',
          forceReauthorize: hasGateway,
        } : null;
        await commitImportedSettings(localImport, filtered, gatewayPermissionChange);

        Object.keys(importedGatewayBases).forEach(provider => setSavedGatewayBase(provider, importedGatewayBases[provider]));
        importInProgress = false;
        showStatus(hasGateway ? '设置已导入；请重新授权 Sub2API 域名' : '设置已导入，正在刷新…', hasGateway ? 'error' : 'success');
        e.target.value = '';
        setTimeout(() => location.reload(), hasGateway ? 1800 : 600);
      } catch (err) {
        importInProgress = false;
        e.target.value = '';
        showStatus(err && err.message ? err.message : '文件解析失败', 'error');
      }
    };
    reader.readAsText(file);
  });

  $('#save').addEventListener('click', () => {
    autoSave.cancel();
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
    autoSave.cancel();
    requestGatewayPermission('sub2api', (granted, authorization) => {
      if (granted) saveAuthorizedGateway(authorization);
    });
  });

  // ── ChatGPT 订阅授权（粘贴 ~/.codex/auth.json，存 storage.local 不同步）──
  function refreshChatgptAuthStatus() {
    chrome.storage.local.get(['chatgptAuth'], (d) => {
      const el = $('#chatgptAuthStatus');
      if (!el) return;
      const auth = d && d.chatgptAuth;
      if (!auth || !auth.access_token) { el.textContent = '未配置'; return; }
      let normalized;
      try { normalized = normalizeChatgptAuthInput(auth); } catch (_) {
        el.textContent = '授权数据无效，请清除后重新粘贴';
        return;
      }
      let expText = '';
      try {
        const exp = decodeJwtClaims(normalized.access_token)?.exp;
        if (exp) expText = '，access token 有效期至 ' + new Date(exp * 1000).toLocaleString();
      } catch (_) {}
      el.textContent = '已配置 ✓' + expText + (normalized.refresh_token ? '（过期自动刷新）' : '（无 refresh_token，过期需重新粘贴）');
    });
  }

  const saveChatgptAuthPaste = debounce(() => {
    const raw = $('#chatgptAuthPaste').value.trim();
    if (!raw) return;
    if (raw.length > MAX_CHATGPT_PASTE_CHARS) {
      showStatus('auth.json 超过 1 MiB 安全上限', 'error');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      showStatus('auth.json 解析失败：不是有效的 JSON', 'error');
      return;
    }
    let auth;
    try {
      auth = normalizeChatgptAuthInput(parsed);
    } catch (error) {
      showStatus(error.message || 'auth.json 字段无效', 'error');
      return;
    }
    commitChatgptAuthMutation('CHATGPT_AUTH_SET', auth).then(() => {
      $('#chatgptAuthPaste').value = ''; // 保存后清空，避免 token 明文留在输入框
      refreshChatgptAuthStatus();
      showStatus('ChatGPT 订阅授权已保存（仅存本机）', 'success');
    }).catch((error) => showStatus('授权保存失败：' + (error.message || error), 'error'));
  }, 600);
  $('#chatgptAuthPaste').addEventListener('input', saveChatgptAuthPaste);

  $('#chatgptAuthClear').addEventListener('click', () => {
    saveChatgptAuthPaste.cancel();
    $('#chatgptAuthPaste').value = '';
    commitChatgptAuthMutation('CHATGPT_AUTH_CLEAR').then(() => {
      refreshChatgptAuthStatus();
      showStatus('已清除 ChatGPT 订阅授权', 'success');
    }).catch((error) => showStatus('授权清除失败：' + (error.message || error), 'error'));
  });

  refreshChatgptAuthStatus();

  // 离散设置立即保存；文本输入防抖，并在 popup 关闭前 flush。
  const autoSave = debounce(() => saveSettings(false), 1500);
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!shouldAutoSaveElement(el)) return;
    const immediate = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio';
    if (immediate) {
      el.addEventListener('change', () => {
        if (importInProgress) return;
        autoSave.cancel();
        saveSettings(false);
      });
      return;
    }
    el.addEventListener('input', () => { if (!importInProgress) autoSave(); });
    el.addEventListener('change', () => { if (!importInProgress) autoSave.flush(); });
  });
  window.addEventListener('pagehide', () => {
    if (importInProgress) return;
    saveChatgptAuthPaste.flush();
    autoSave.flush();
  });
  const selectionChangedDuringLoad = providerChangedDuringSettingsLoad ||
    Object.keys(modelSelectionsDuringSettingsLoad).length > 0;
  providerChangedDuringSettingsLoad = false;
  Object.keys(modelSelectionsDuringSettingsLoad).forEach((provider) => {
    delete modelSelectionsDuringSettingsLoad[provider];
  });
  if (selectionChangedDuringLoad) {
    saveSettings(false, undefined, undefined, (error) => {
      if (error) showPersistentStatus('加载期间选择的服务商或模型未能保存：' + error.message, 'error');
    });
  }
});

// 缓存已拉取的模型列表（从 storage.local 加载）
let fetchedModelsCache = {};
const modelFetchFlights = new Map();
const MODEL_FETCH_TIMEOUT_MS = 30000;
const MAX_FETCHED_MODELS = 5000;

// Claude 2.x / 3.x / instant 全系列已退役（API 返回 404）。
// 旧缓存的拉取列表里可能还留着，渲染前过滤；存量选中值命中时视为未选择，
// 让 UI 落到推荐默认值（与 background.js sanitizeModel 的回退行为一致）
const RETIRED_CLAUDE = /^claude-(2[.-]|instant|3-)/;
// deepseek-chat / deepseek-reasoner 旧模型名已于 2026-07-24 退役（与 background.js 同款过滤）
const RETIRED_DEEPSEEK = /^deepseek-(chat|reasoner)$/;
const SUPPORTED_OPENAI_MODEL = /^gpt-/;
const NON_CHAT_OPENAI_MODEL = /(image|transcrib|tts|embedding|moderation|realtime|audio)/i;

function updateModelFetchButtons() {
  const loading = modelFetchFlights.has(currentProvider);
  const iconButton = $('#fetchModelsBtn');
  const textButton = $('#fetchModels');
  iconButton.disabled = !settingsLoaded || loading;
  textButton.disabled = !settingsLoaded || loading;
  iconButton.innerHTML = loading
    ? '<svg class="ytx-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
}

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
  if (id === 'openai') {
    models = models.filter(m => SUPPORTED_OPENAI_MODEL.test(m.value) && !NON_CHAT_OPENAI_MODEL.test(m.value));
    if (selected && (!SUPPORTED_OPENAI_MODEL.test(selected) || NON_CHAT_OPENAI_MODEL.test(selected))) {
      selected = '';
      modelCache.openai = '';
    }
  }
  populateModelSelect(models, selected);
  updateModelFetchButtons();
}

function boundedStoredString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength ? value : '';
}

function normalizeFetchedModels(models) {
  if (!Array.isArray(models)) return [];
  const normalized = [];
  const limit = Math.min(models.length, MAX_FETCHED_MODELS);
  for (let index = 0; index < limit; index++) {
    const model = models[index];
    if (!model || typeof model !== 'object' ||
        typeof model.value !== 'string' || typeof model.label !== 'string' ||
        !model.value || model.value.length > 500 || model.label.length > 500) continue;
    normalized.push({ value: model.value, label: model.label });
  }
  return normalized;
}

// 预置模型与「从官网获取」的列表合并，预置在前、按 value 去重。
// 拉取列表不能直接替换预置：/v1/models 只返回该 key 有权访问的模型真名，既不含别名
// （gpt-5.6 → gpt-5.6-sol），组织未获得新模型权限时整代新模型也会整批缺席。直接替换会让
// 推荐模型从下拉里彻底消失，而且拉取结果持久缓存在 storage.local，换 key 后不重新拉取就一直被遮蔽。
function mergeModels(preset, fetched) {
  const normalized = normalizeFetchedModels(fetched);
  if (!normalized.length) return preset;
  const seen = new Set(preset.map(m => m.value));
  const merged = preset.slice();
  normalized.forEach((model) => {
    if (seen.has(model.value)) return;
    seen.add(model.value);
    merged.push(model);
  });
  return merged;
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

function showPersistentStatus(text, type) {
  const el = $('#persistentStatus') || $('#status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status ' + type;
}

function renderPersistentWarnings() {
  const el = $('#persistentStatus') || $('#status');
  if (!el) return;
  if (!persistentStartupWarnings.length) {
    el.textContent = '';
    el.className = 'status';
    return;
  }
  el.textContent = '设置已加载，但需要处理：' +
    persistentStartupWarnings.map(warning => warning.text).join('；');
  el.className = 'status error';
}

function setPersistentWarnings(warnings) {
  persistentStartupWarnings = Array.isArray(warnings)
    ? warnings.filter(warning => warning && typeof warning.kind === 'string' && typeof warning.text === 'string')
    : [];
  renderPersistentWarnings();
}

function clearPersistentWarningKinds(kinds) {
  const resolvedKinds = new Set(Array.isArray(kinds) ? kinds : []);
  persistentStartupWarnings = persistentStartupWarnings.filter(warning => !resolvedKinds.has(warning.kind));
  renderPersistentWarnings();
}

function showStatus(text, type) {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + type;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 2000);
}

// ── 从官网获取最新模型列表 ──────────────────────────────────
async function fetchLatestModels() {
  const existingFlight = modelFetchFlights.get(currentProvider);
  if (existingFlight) return existingFlight.promise;
  if (currentProvider === 'chatgpt') {
    showStatus('ChatGPT 订阅模式使用预置模型列表，无需在线获取', 'error');
    return;
  }
  const key = $('#currentKey').value.trim();
  if (!key) {
    showStatus('请先填入 API Key', 'error');
    return;
  }

  const providerAtStart = currentProvider;
  const fetchController = new AbortController();
  let fetchTimeoutTimer = null;
  showStatus('正在获取模型列表...', 'success');

  const task = (async () => {
    const fetcher = MODEL_FETCHERS[providerAtStart];
    if (!fetcher) {
      if (currentProvider === providerAtStart) showStatus('当前服务商不支持获取模型列表', 'error');
      return;
    }
    const timeout = new Promise((_, reject) => {
      fetchTimeoutTimer = setTimeout(() => {
        fetchController.abort();
        reject(new Error('获取模型列表超时（30 秒）'));
      }, MODEL_FETCH_TIMEOUT_MS);
    });
    const models = await Promise.race([fetcher(key, fetchController.signal), timeout]);
    if (!models || models.length === 0) {
      if (currentProvider === providerAtStart) showStatus('未获取到可用模型', 'error');
      return;
    }

    // 保存到本地 + 内存缓存
    fetchedModelsCache[providerAtStart] = models;
    const storageKey = 'fetchedModels_' + providerAtStart;
    await commitStorageTransaction({ localSet: { [storageKey]: models } });

    // 用户等待期间可能已经切换服务商；缓存仍归请求发起方，不能污染当前下拉框。
    if (currentProvider === providerAtStart) {
      const prev = $('#model').value;
      populateModelSelect(mergeModels(PROVIDERS[providerAtStart].models, models), prev);
    }

    if (currentProvider === providerAtStart) showStatus('已获取 ' + models.length + ' 个模型', 'success');
  })();
  const flight = { provider: providerAtStart, controller: fetchController, promise: null };
  const wrapped = task.catch((err) => {
    if (currentProvider === providerAtStart) showStatus('获取失败: ' + (err.message || err), 'error');
  }).finally(() => {
    if (fetchTimeoutTimer) clearTimeout(fetchTimeoutTimer);
    if (modelFetchFlights.get(providerAtStart) === flight) modelFetchFlights.delete(providerAtStart);
    updateModelFetchButtons();
  });
  flight.promise = wrapped;
  modelFetchFlights.set(providerAtStart, flight);
  updateModelFetchButtons();
  return wrapped;
}

// ── 防抖：等用户停止操作一段时间后才执行 ──────────────────
function debounce(fn, ms) {
  let timer;
  let pending = false;
  const debounced = function () {
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      timer = null;
      fn();
    }, ms);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending = false;
  };
  debounced.flush = () => {
    if (!pending) return;
    clearTimeout(timer);
    timer = null;
    pending = false;
    fn();
  };
  return debounced;
}

function shouldAutoSaveElement(element) {
  return Boolean(element) && element.type !== 'file' &&
    element.id !== 'importFile' && element.id !== 'chatgptAuthPaste' &&
    // A Base URL draft is not authoritative until the user grants its exact
    // origin and the background permission transaction commits it.
    element.id !== 'sub2apiBaseUrl';
}

// ── 保存设置（isManual=true 显示提示，false 静默）─────────────
function saveSettings(isManual, gatewayProvider, gatewayBaseOverride, done, gatewayPermissionAttemptId) {
  if (!settingsLoaded) {
    const error = new Error('设置仍在加载，请稍后重试');
    if (isManual) showStatus(error.message, 'error');
    if (done) done(error);
    return false;
  }
  const cfg = PROVIDERS[currentProvider];
  const liveKey = $('#currentKey').value.trim();
  const liveModel = $('#model').value;
  const earlyError = (cfg.keyField && liveKey.length > 10000)
    ? 'API Key 超过 10000 字符安全上限'
    : (typeof liveModel !== 'string' || liveModel.length > 500)
      ? '模型名称无效或过长'
      : '';
  if (earlyError) {
    const error = new Error(earlyError);
    if (isManual) showStatus(error.message, 'error');
    if (done) done(error);
    return false;
  }

  const oldGatewayBase = gatewayProvider ? getSavedGatewayBase(gatewayProvider) : '';
  const oldGatewayOrigin = gatewayOrigin(oldGatewayBase);
  var attemptedGatewayOrigin = '';
  if (gatewayProvider) {
    var attemptedGatewayBase = gatewayBaseOverride !== undefined
      ? gatewayBaseOverride
      : $('#' + SUB2API_BASE_INPUT[gatewayProvider]).value.trim();
    if (typeof attemptedGatewayBase !== 'string' || attemptedGatewayBase.length > 2048) {
      const error = new Error('网关 Base URL 无效或过长');
      if (isManual) showStatus(error.message, 'error');
      if (done) done(error);
      return false;
    }
    attemptedGatewayOrigin = gatewayOrigin(attemptedGatewayBase);
    setSavedGatewayBase(gatewayProvider, attemptedGatewayBase);
  }

  // 把当前表单值同步到缓存（chatgpt 无 keyField，授权走 storage.local 单独保存）
  if (cfg.keyField) keyCache[cfg.keyField] = liveKey;
  modelCache[currentProvider] = liveModel;

  const secretData = {
    claudeKey: keyCache.claudeKey,
    openaiKey: keyCache.openaiKey,
    geminiKey: keyCache.geminiKey,
    minimaxKey: keyCache.minimaxKey,
    deepseekKey: keyCache.deepseekKey,
    kimiKey: keyCache.kimiKey,
    sub2apiKey: keyCache.sub2apiKey,
  };
  const saveData = {
    provider: currentProvider,
    claudeModel: modelCache.claude,
    openaiModel: modelCache.openai,
    geminiModel: modelCache.gemini,
    minimaxModel: modelCache.minimax,
    deepseekModel: modelCache.deepseek,
    kimiModel: modelCache.kimi,
    sub2apiModel: modelCache.sub2api,
    chatgptModel: modelCache.chatgpt,
    sub2apiBaseUrl: sub2apiBaseUrl,
    model: $('#model').value,
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

  const saveVersion = ++settingsSaveVersion;
  const fail = (message) => {
    const error = new Error(message || '设置保存失败');
    if (gatewayProvider && saveVersion === settingsSaveVersion) setSavedGatewayBase(gatewayProvider, oldGatewayBase);
    if (gatewayPermissionAttemptId) {
      endGatewayPermissionAttempt(gatewayPermissionAttemptId);
    }
    if (isManual && saveVersion === settingsSaveVersion) showStatus('设置保存失败：' + error.message, 'error');
    if (done) done(error);
  };

  commitStorageTransaction({
    localSet: secretData,
    syncSet: saveData,
    ...(isManual ? { resolveConsistencyError: true } : {}),
    localRemove: gatewayProvider ? [GATEWAY_REAUTH_MARKER] : [],
    ...(gatewayProvider ? {
      gatewayPermissionChange: {
        provider: gatewayProvider,
        oldOrigin: oldGatewayOrigin,
        newOrigin: attemptedGatewayOrigin,
        attemptedOrigin: attemptedGatewayOrigin,
        ...(gatewayPermissionAttemptId ? { permissionAttemptId: gatewayPermissionAttemptId } : {}),
      },
    } : {}),
  }).then(() => {
    // 任何成功的手动恢复事务都已在后台清除对应标记，即使其后又
    // 排队了 autosave，也不应留下假阳性告警。只有短暂的全局状态提示限于最新保存。
    if (isManual) {
      clearPersistentWarningKinds(gatewayProvider
        ? ['consistency', 'gateway']
        : ['consistency']);
    }
    if (isManual && saveVersion === settingsSaveVersion) {
      showStatus('设置已保存 ✓', 'success');
    }
    if (done) done(null);
  }).catch((error) => fail(error.message || error));
  return true;
}

const MAX_MODEL_RESPONSE_BYTES = 2_000_000;
async function readBoundedJsonResponse(response, maxBytes = MAX_MODEL_RESPONSE_BYTES) {
  if (!response?.body?.getReader) throw new Error('模型列表响应无法安全限界读取');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error('模型列表响应超过 2 MiB 安全上限');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); } catch (_) { throw new Error('模型列表响应不是有效 JSON'); }
}

function boundedModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 ? value : '';
}

const MODEL_FETCHERS = {
  async claude(key, signal) {
    const records = [];
    let afterId = '';
    for (let page = 0; page < 50; page++) {
      const url = new URL('https://api.anthropic.com/v1/models');
      url.searchParams.set('limit', '100');
      if (afterId) url.searchParams.set('after_id', afterId);
      const resp = await fetch(url.href, {
        redirect: 'error',
        signal,
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      });
      if (!resp.ok) throw new Error('API 返回 ' + resp.status);
      const data = await readBoundedJsonResponse(resp);
      const pageRecords = Array.isArray(data.data) ? data.data : [];
      if (records.length + pageRecords.length > MAX_FETCHED_MODELS) throw new Error('模型列表超过 5000 条安全上限');
      for (const item of pageRecords) {
        const id = boundedModelId(item?.id);
        if (!id) throw new Error('模型列表条目格式无效或过长');
        const displayName = item.display_name == null ? '' : item.display_name;
        const createdAt = item.created_at == null ? '' : item.created_at;
        if (typeof displayName !== 'string' || displayName.length > 500 ||
            typeof createdAt !== 'string' || createdAt.length > 100) throw new Error('模型列表条目格式无效或过长');
        records.push({ id, display_name: displayName, created_at: createdAt });
      }
      if (!data.has_more) break;
      if (typeof data.last_id !== 'string' || !data.last_id || data.last_id.length > 500 || data.last_id === afterId) throw new Error('模型列表分页游标无效');
      afterId = data.last_id;
    }
    const models = records
      .filter(m => m.id && !m.id.includes('legacy'))
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .map(m => ({ value: m.id, label: m.display_name || m.id }));
    return models;
  },

  async openai(key, signal) {
    const resp = await fetch('https://api.openai.com/v1/models', {
      redirect: 'error',
      signal,
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await readBoundedJsonResponse(resp);
    const records = Array.isArray(data.data) ? data.data : [];
    if (records.length > MAX_FETCHED_MODELS) throw new Error('模型列表超过 5000 条安全上限');
    const models = records
      .map(m => boundedModelId(m?.id))
      .filter(id => id && SUPPORTED_OPENAI_MODEL.test(id) && !id.includes('instruct') && !NON_CHAT_OPENAI_MODEL.test(id))
      .sort((a, b) => a < b ? 1 : -1)
      .map(id => ({ value: id, label: id }));
    return models;
  },

  async gemini(key, signal) {
    const records = [];
    let pageToken = '';
    for (let page = 0; page < 50; page++) {
      const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const resp = await fetch(url.href, { redirect: 'error', signal, headers: { 'x-goog-api-key': key } });
      if (!resp.ok) throw new Error('API 返回 ' + resp.status);
      const data = await readBoundedJsonResponse(resp);
      const pageRecords = Array.isArray(data.models) ? data.models : [];
      if (records.length + pageRecords.length > MAX_FETCHED_MODELS) throw new Error('模型列表超过 5000 条安全上限');
      for (const item of pageRecords) {
        const name = typeof item?.name === 'string' && item.name.length <= 507 ? item.name : '';
        const displayName = item?.displayName == null ? '' : item.displayName;
        const methods = item?.supportedGenerationMethods;
        if (!name || typeof displayName !== 'string' || displayName.length > 500 || !Array.isArray(methods) || methods.length > 100 ||
            methods.some(method => typeof method !== 'string' || method.length > 100)) {
          throw new Error('模型列表条目格式无效或过长');
        }
        records.push({ name, displayName, supportedGenerationMethods: methods });
      }
      if (!data.nextPageToken) break;
      if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 2048 || data.nextPageToken === pageToken) throw new Error('模型列表分页游标无效');
      pageToken = data.nextPageToken;
    }
    const models = records
      .filter(m => m.name && m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => {
        const id = m.name.replace('models/', '');
        return { value: id, label: m.displayName || id };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    return models;
  },

  async deepseek(key, signal) {
    const resp = await fetch('https://api.deepseek.com/models', {
      redirect: 'error',
      signal,
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await readBoundedJsonResponse(resp);
    const records = Array.isArray(data.data) ? data.data : [];
    if (records.length > MAX_FETCHED_MODELS) throw new Error('模型列表超过 5000 条安全上限');
    const models = records
      .map(m => boundedModelId(m?.id))
      .filter(Boolean)
      .map(id => ({ value: id, label: id }))
      .sort((a, b) => a.value.localeCompare(b.value));
    return models;
  },

  async kimi(key, signal) {
    const resp = await fetch('https://api.moonshot.cn/v1/models', {
      redirect: 'error',
      signal,
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) throw new Error('API 返回 ' + resp.status);
    const data = await readBoundedJsonResponse(resp);
    const records = Array.isArray(data.data) ? data.data : [];
    if (records.length > MAX_FETCHED_MODELS) throw new Error('模型列表超过 5000 条安全上限');
    const models = records
      .map(m => boundedModelId(m?.id))
      .filter(Boolean)
      .map(id => ({ value: id, label: id }))
      // kimi-* 新模型线整体排在 legacy moonshot-*（2026-08-31 下线）之前，组内再按名称降序。
      // 单纯全局降序会因 'm' > 'k' 把 moonshot-* 顶到最前，与意图正好相反。
      .sort((a, b) => {
        const rank = m => (m.startsWith('kimi-') ? 0 : 1);
        return rank(a.value) - rank(b.value) || b.value.localeCompare(a.value);
      });
    return models;
  },

};
