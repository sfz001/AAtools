'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function jsonStreamResponse(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let read = false;
  return {
    ok: true,
    body: { getReader() { return {
      async read() {
        if (read) return { done: true };
        read = true;
        return { done: false, value: bytes };
      },
      async cancel() {},
    }; } },
  };
}

function loadOptions(options = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const permissionRequests = [];
  const permissionRemovals = [];
  const savedSettings = [];
  const savedSecrets = [];
  const removedSyncKeys = [];
  const fetchCalls = [];
  const runtimeMessages = [];
  const storageData = {
    local: structuredClone(options.localData || {}),
    sync: structuredClone(options.syncData || {}),
  };
  let requestGranted = true;
  let failSyncSetRemaining = options.failSyncSetOnce ? 1 : 0;

  function element(selector) {
    if (!elements.has(selector)) {
      const listeners = new Map();
      const children = [];
      const value = {
        checked: false,
        className: '',
        disabled: false,
        textContent: '',
        value: '',
        style: {},
        children,
        options: children,
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(listener);
        },
        appendChild(child) {
          children.push(child);
          if (!this.value && typeof child?.value === 'string') this.value = child.value;
          return child;
        },
        dispatchEvent(event) {
          const actual = typeof event === 'string' ? { type: event } : event;
          if (!actual.target) actual.target = this;
          return Promise.all((listeners.get(actual.type) || []).map(listener => listener.call(this, actual)));
        },
        listenerCount(type) {
          return (listeners.get(type) || []).length;
        },
      };
      let innerHtml = '';
      Object.defineProperty(value, 'innerHTML', {
        get() { return innerHtml; },
        set(next) {
          innerHtml = String(next);
          if (innerHtml === '') {
            children.length = 0;
            this.value = '';
          }
        },
      });
      elements.set(selector, value);
    }
    return elements.get(selector);
  }

  const runtime = {
    id: 'test-extension',
    lastError: null,
    getManifest() { return { version: '1.3.0' }; },
    sendMessage(message, callback) {
      runtimeMessages.push(structuredClone(message));
      let response;
      try {
        if (options.runtimeSendMessage) {
          response = options.runtimeSendMessage(message, runtimeMessages.length);
        } else if (message.type === 'LOAD_SETTINGS_SNAPSHOT') {
          const revision = Number.isSafeInteger(storageData.local.settingsRevisionV1)
            ? storageData.local.settingsRevisionV1 : 0;
          const local = structuredClone(storageData.local);
          delete local.settingsRevisionV1;
          response = { ok: true, revision, local, sync: structuredClone(storageData.sync) };
        } else if (message.type === 'COMMIT_SETTINGS_TRANSACTION') {
          const tx = structuredClone(message.transaction || {});
          const before = structuredClone(storageData);
          const currentRevision = Number.isSafeInteger(storageData.local.settingsRevisionV1)
            ? storageData.local.settingsRevisionV1 : 0;
          if (tx.expectedRevision !== currentRevision) {
            response = {
              ok: false, conflict: true, currentRevision,
              error: '设置已在另一个页面中更改',
            };
          } else {
            if (Object.keys(tx.localSet || {}).length) {
              savedSecrets.push(structuredClone(tx.localSet));
              Object.assign(storageData.local, tx.localSet);
            }
            if (Object.keys(tx.syncSet || {}).length) savedSettings.push(structuredClone(tx.syncSet));
            if (failSyncSetRemaining > 0) {
              failSyncSetRemaining--;
              storageData.local = before.local;
              storageData.sync = before.sync;
              response = { ok: false, error: '写入失败，已恢复原设置：simulated sync failure' };
            } else {
              Object.assign(storageData.sync, tx.syncSet || {});
              for (const key of tx.localRemove || []) delete storageData.local[key];
              for (const key of tx.syncRemove || []) delete storageData.sync[key];
              storageData.local.settingsRevisionV1 = currentRevision + 1;
              response = { ok: true, revision: currentRevision + 1 };
            }
          }
        } else if (message.type === 'CHATGPT_AUTH_SET' || message.type === 'CHATGPT_AUTH_CLEAR') {
          const currentRevision = Number.isSafeInteger(storageData.local.settingsRevisionV1)
            ? storageData.local.settingsRevisionV1 : 0;
          if (message.expectedRevision !== currentRevision) {
            response = {
              ok: false, conflict: true, currentRevision,
              error: '设置已在另一个页面中更改',
            };
          } else {
            storageData.local.chatgptAuth = message.type === 'CHATGPT_AUTH_SET'
              ? structuredClone(message.auth) : null;
            storageData.local.settingsRevisionV1 = currentRevision + 1;
            response = { ok: true, revision: currentRevision + 1 };
          }
        } else {
          response = { ok: true };
        }
      } catch (error) {
        runtime.lastError = { message: error.message || String(error) };
        callback(undefined);
        runtime.lastError = null;
        return;
      }
      Promise.resolve(response).then(
        value => callback(value === undefined ? { ok: true } : value),
        error => {
          runtime.lastError = { message: error.message || String(error) };
          callback(undefined);
          runtime.lastError = null;
        }
      );
    },
  };
  const context = {
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    atob: options.atob || atob,
    fetch(...args) {
      fetchCalls.push(args);
      if (!options.fetch) throw new Error('Unexpected fetch');
      return options.fetch(...args);
    },
    chrome: {
      permissions: {
        request(query, callback) {
          permissionRequests.push(query);
          callback(requestGranted);
        },
        remove(query, callback) {
          permissionRemovals.push(query);
          callback(true);
        },
      },
      runtime,
      storage: {
        sync: {
          get(keys, callback) {
            const list = Array.isArray(keys) ? keys : Object.keys(storageData.sync);
            callback(Object.fromEntries(list.filter(key => Object.prototype.hasOwnProperty.call(storageData.sync, key)).map(key => [key, structuredClone(storageData.sync[key])])))
          },
          set(data, callback) {
            savedSettings.push(structuredClone(data));
            if (failSyncSetRemaining > 0) {
              failSyncSetRemaining--;
              runtime.lastError = { message: 'simulated sync failure' };
              callback();
              runtime.lastError = null;
              return;
            }
            Object.assign(storageData.sync, structuredClone(data));
            callback();
          },
          remove(keys, callback = () => {}) {
            const list = Array.isArray(keys) ? keys : [keys];
            removedSyncKeys.push([...list]);
            list.forEach(key => delete storageData.sync[key]);
            callback();
          },
        },
        local: {
          get(keys, callback) {
            const list = Array.isArray(keys) ? keys : Object.keys(storageData.local);
            callback(Object.fromEntries(list.filter(key => Object.prototype.hasOwnProperty.call(storageData.local, key)).map(key => [key, structuredClone(storageData.local[key])])))
          },
          set(data, callback = () => {}) {
            savedSecrets.push(structuredClone(data));
            Object.assign(storageData.local, structuredClone(data));
            callback();
          },
          remove(keys, callback = () => {}) {
            const list = Array.isArray(keys) ? keys : [keys];
            list.forEach(key => delete storageData.local[key]);
            callback();
          },
          setAccessLevel() {
            return options.accessLevelError ? Promise.reject(options.accessLevelError) : Promise.resolve();
          },
        },
      },
    },
    clearTimeout: options.clearTimeout || (() => {}),
    console,
    window: {
      addEventListener() {},
    },
    document: {
      addEventListener(type, listener) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(listener);
      },
      querySelector(selector) { return element(selector); },
      querySelectorAll(selector) {
        return options.querySelectorAll ? options.querySelectorAll(selector, element) : [];
      },
      getElementById(id) { return element('#' + id); },
      createElement(tagName) {
        return {
          tagName: String(tagName).toUpperCase(),
          textContent: '',
          value: '',
          style: {},
        };
      },
    },
    setTimeout: options.setTimeout || (() => 1),
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'options.js' });
  if (options.settingsLoaded !== false) {
    const revision = Number.isSafeInteger(storageData.local.settingsRevisionV1)
      ? storageData.local.settingsRevisionV1 : 0;
    vm.runInContext(`settingsLoaded = true; settingsRevision = ${revision}`, context);
  }
  return {
    context,
    element,
    fetchCalls,
    permissionRemovals,
    permissionRequests,
    savedSettings,
    savedSecrets,
    removedSyncKeys,
    runtimeMessages,
    storageData,
    setRequestGranted(value) { requestGranted = value; },
    dispatchDocumentEvent(type) {
      return Promise.all((documentListeners.get(type) || []).map(listener => listener({ type })));
    },
  };
}

function coreSettingsControls(selector, element) {
  const ids = selector === 'input, select, textarea, button'
    ? ['providerSelect', 'currentKey', 'model', 'save', 'fetchModels', 'fetchModelsBtn', 'toggleKey']
    : selector === 'input, select, textarea'
      ? ['providerSelect', 'currentKey', 'model']
      : [];
  return ids
    .map((id) => {
      const control = element('#' + id);
      control.id = id;
      control.tagName = id === 'providerSelect' || id === 'model' ? 'SELECT' : 'INPUT';
      if (id === 'currentKey') control.type = 'password';
      return control;
    });
}

test('provider presets and switching remain usable when secure settings snapshot loading fails', async () => {
  const loaded = loadOptions({
    settingsLoaded: false,
    querySelectorAll: coreSettingsControls,
    runtimeSendMessage(message) {
      if (message.type === 'MIGRATE_SECRETS') throw new Error('settings startup must not request redundant migration');
      assert.equal(message.type, 'LOAD_SETTINGS_SNAPSHOT');
      return { ok: false, error: 'simulated snapshot failure' };
    },
  });

  await loaded.dispatchDocumentEvent('DOMContentLoaded');
  assert.deepEqual(loaded.runtimeMessages, [{ type: 'LOAD_SETTINGS_SNAPSHOT' }]);
  assert.equal(loaded.element('#keyLabel').textContent, 'Claude API Key');
  assert.ok(loaded.element('#model').options.length > 0, 'Claude presets should render before settings load');
  assert.ok(loaded.element('#providerSelect').listenerCount('change') > 0, 'provider change listener should bind before settings load');
  assert.equal(loaded.element('#providerSelect').disabled, false);
  assert.equal(loaded.element('#model').disabled, false);
  assert.equal(loaded.element('#currentKey').disabled, true);
  assert.equal(loaded.element('#save').disabled, true);
  assert.equal(loaded.element('#fetchModels').disabled, true);

  loaded.element('#providerSelect').value = 'openai';
  await loaded.element('#providerSelect').dispatchEvent({ type: 'change' });
  assert.equal(loaded.element('#keyLabel').textContent, 'OpenAI API Key');
  assert.ok(loaded.element('#model').options.length > 0, 'OpenAI presets should render after switching');
  assert.equal(loaded.element('#persistentStatus').textContent.includes('设置安全加载失败'), true);
});

test('a provider preview selected during loading survives the late settings snapshot', async () => {
  let resolveSnapshot;
  const commits = [];
  const loaded = loadOptions({
    settingsLoaded: false,
    querySelectorAll: coreSettingsControls,
    runtimeSendMessage(message) {
      if (message.type === 'LOAD_SETTINGS_SNAPSHOT') {
        return new Promise((resolve) => { resolveSnapshot = resolve; });
      }
      assert.equal(message.type, 'COMMIT_SETTINGS_TRANSACTION');
      commits.push(structuredClone(message.transaction));
      return { ok: true, revision: 3 };
    },
  });

  const initialization = loaded.dispatchDocumentEvent('DOMContentLoaded');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.element('#currentKey').disabled, true);
  assert.equal(loaded.element('#model').disabled, false);
  loaded.element('#providerSelect').value = 'openai';
  await loaded.element('#providerSelect').dispatchEvent({ type: 'change' });
  assert.equal(loaded.element('#keyLabel').textContent, 'OpenAI API Key');
  loaded.element('#model').value = 'gpt-5.6-terra';
  await loaded.element('#model').dispatchEvent({ type: 'change' });

  resolveSnapshot({
    ok: true,
    revision: 2,
    local: { claudeKey: 'claude-key', openaiKey: 'openai-key' },
    sync: { provider: 'claude', claudeModel: 'claude-opus-5', openaiModel: 'gpt-5.6-sol' },
  });
  await initialization;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.element('#providerSelect').value, 'openai');
  assert.equal(loaded.element('#keyLabel').textContent, 'OpenAI API Key');
  assert.equal(loaded.element('#currentKey').value, 'openai-key');
  assert.equal(loaded.element('#model').value, 'gpt-5.6-terra');
  assert.equal(loaded.element('#currentKey').disabled, false);
  assert.equal(loaded.element('#model').disabled, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].expectedRevision, 2);
  assert.equal(commits[0].syncSet.provider, 'openai');
  assert.equal(commits[0].syncSet.openaiModel, 'gpt-5.6-terra');
  assert.equal(commits[0].syncSet.model, 'gpt-5.6-terra');
});

test('provider changes after initialization use the real autosave selector and persist immediately', async () => {
  const commits = [];
  const loaded = loadOptions({
    settingsLoaded: false,
    querySelectorAll: coreSettingsControls,
    runtimeSendMessage(message) {
      if (message.type === 'LOAD_SETTINGS_SNAPSHOT') {
        return {
          ok: true,
          revision: 6,
          local: { claudeKey: 'claude-key', openaiKey: 'openai-key' },
          sync: { provider: 'claude', claudeModel: 'claude-opus-5', openaiModel: 'gpt-5.6-sol' },
        };
      }
      assert.equal(message.type, 'COMMIT_SETTINGS_TRANSACTION');
      commits.push(structuredClone(message.transaction));
      return { ok: true, revision: 7 };
    },
  });

  await loaded.dispatchDocumentEvent('DOMContentLoaded');
  assert.ok(loaded.element('#providerSelect').listenerCount('change') >= 2,
    'provider should have both the renderer and generic autosave listeners');
  loaded.element('#providerSelect').value = 'openai';
  await loaded.element('#providerSelect').dispatchEvent({ type: 'change' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(commits.length, 1);
  assert.equal(commits[0].expectedRevision, 6);
  assert.equal(commits[0].syncSet.provider, 'openai');
  assert.equal(commits[0].syncSet.openaiModel, 'gpt-5.6-sol');
});

test('every provider switch renders its own label and preset models', () => {
  const loaded = loadOptions();
  const providers = JSON.parse(JSON.stringify(vm.runInContext(
    'Object.fromEntries(Object.entries(PROVIDERS).map(([id, cfg]) => [id, { label: cfg.label, modelCount: cfg.models.length, hasKey: Boolean(cfg.keyField) }]))',
    loaded.context
  )));

  for (const [id, expected] of Object.entries(providers)) {
    loaded.context.switchProvider(id);
    assert.equal(loaded.element('#providerSelect').value, id);
    assert.equal(loaded.element('#keyLabel').textContent, expected.label);
    assert.ok(loaded.element('#model').options.length >= expected.modelCount, `${id} presets should render`);
    assert.equal(loaded.element('#apiKeyField').style.display, expected.hasKey ? '' : 'none');
  }
});

test('successful settings initialization hydrates safely, enables controls, and keeps warnings durable', async () => {
  const timers = [];
  const loaded = loadOptions({
    settingsLoaded: false,
    querySelectorAll: coreSettingsControls,
    setTimeout(callback, ms) {
      timers.push({ callback, ms });
      return timers.length;
    },
    runtimeSendMessage(message) {
      assert.equal(message.type, 'LOAD_SETTINGS_SNAPSHOT');
      return {
        ok: true,
        revision: 4,
        local: {
          openaiKey: 'local-openai-key',
          fetchedModels_openai: [
            null,
            { value: 'gpt-5.6-sol', label: 'duplicate preset' },
            { value: 'gpt-extra', label: 'GPT Extra' },
          ],
        },
        sync: { provider: 'openai', openaiModel: 'gpt-extra' },
        warnings: ['simulated cleanup warning'],
      };
    },
  });

  await loaded.dispatchDocumentEvent('DOMContentLoaded');
  assert.equal(vm.runInContext('settingsLoaded', loaded.context), true);
  assert.equal(vm.runInContext('settingsRevision', loaded.context), 4);
  assert.equal(loaded.element('#providerSelect').value, 'openai');
  assert.equal(loaded.element('#keyLabel').textContent, 'OpenAI API Key');
  assert.equal(loaded.element('#currentKey').value, 'local-openai-key');
  assert.equal(loaded.element('#model').value, 'gpt-extra');
  assert.equal(loaded.element('#model').options.filter(option => option.value === 'gpt-5.6-sol').length, 1);
  assert.equal(loaded.element('#model').options.filter(option => option.value === 'gpt-extra').length, 1);
  assert.equal(loaded.element('#model').disabled, false);
  assert.equal(loaded.element('#currentKey').disabled, false);
  assert.equal(loaded.element('#save').disabled, false);
  assert.equal(loaded.element('#fetchModels').disabled, false);
  assert.match(loaded.element('#persistentStatus').textContent, /simulated cleanup warning/);

  loaded.context.showStatus('temporary success', 'success');
  assert.equal(loaded.element('#status').textContent, 'temporary success');
  timers.at(-1).callback();
  assert.equal(loaded.element('#status').textContent, '');
  assert.match(loaded.element('#persistentStatus').textContent, /simulated cleanup warning/);
});

test('successful manual recovery clears only the durable warnings it resolves', async () => {
  const loaded = loadOptions();
  loaded.context.setPersistentWarnings([
    { kind: 'background', text: 'background cleanup still pending' },
    { kind: 'consistency', text: 'settings conflict' },
    { kind: 'gateway', text: 'gateway authorization required' },
  ]);

  assert.equal(loaded.context.saveSettings(true), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(loaded.element('#persistentStatus').textContent, /background cleanup still pending/);
  assert.doesNotMatch(loaded.element('#persistentStatus').textContent, /settings conflict/);
  assert.match(loaded.element('#persistentStatus').textContent, /gateway authorization required/);

  assert.equal(loaded.context.saveSettings(true, 'sub2api', ''), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.element('#persistentStatus').textContent,
    '设置已加载，但需要处理：background cleanup still pending');
});

test('a newer autosave cannot prevent a successful manual recovery from clearing its warning', async () => {
  const loaded = loadOptions();
  loaded.context.setPersistentWarnings([
    { kind: 'consistency', text: 'settings conflict' },
  ]);

  assert.equal(loaded.context.saveSettings(true), true);
  await new Promise((resolve, reject) => {
    const started = loaded.context.saveSettings(false, undefined, undefined, (error) => {
      if (error) reject(error);
      else resolve();
    });
    assert.equal(started, true);
  });

  assert.equal(loaded.element('#persistentStatus').textContent, '');
});

test('gateway permission request uses the exact normalized origin including port', async () => {
  const loaded = loadOptions();
  loaded.element('#sub2apiBaseUrl').value = 'https://gateway.example:8443/api';

  const granted = await new Promise(resolve => loaded.context.requestGatewayPermission('sub2api', resolve));
  assert.equal(granted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.permissionRequests)), [{ origins: ['https://gateway.example:8443/*'] }]);
  const beginMessages = loaded.runtimeMessages.filter(message => message.type === 'GATEWAY_PERMISSION_ATTEMPT_BEGIN');
  assert.equal(beginMessages.length, 2);
  assert.equal(beginMessages[0].attemptId, beginMessages[1].attemptId);
  assert.equal(beginMessages[1].origin, 'https://gateway.example:8443/*');

  loaded.setRequestGranted(false);
  const denied = await new Promise(resolve => loaded.context.requestGatewayPermission('sub2api', resolve));
  assert.equal(denied, false);
});

test('automatic saves keep the last authorized gateway instead of persisting an unapproved draft', async () => {
  const loaded = loadOptions();
  loaded.context.setSavedGatewayBase('sub2api', 'https://approved.example');
  loaded.element('#sub2apiBaseUrl').value = 'https://unapproved.example';

  loaded.context.saveSettings(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.savedSettings[0].sub2apiBaseUrl, 'https://approved.example');
});

test('a gateway changed while the permission prompt is open cannot be committed under the old grant', async () => {
  const loaded = loadOptions();
  let permissionCallback;
  let authorization;
  loaded.context.chrome.permissions.request = (_query, callback) => { permissionCallback = callback; };
  loaded.element('#sub2apiBaseUrl').value = 'https://first.example/api';
  loaded.context.requestGatewayPermission('sub2api', (granted, value) => {
    assert.equal(granted, true);
    authorization = value;
  });

  loaded.element('#sub2apiBaseUrl').value = 'https://second.example/api';
  permissionCallback(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.context.saveAuthorizedGateway(authorization), false);
  assert.equal(loaded.savedSettings.length, 0);
  assert.equal(loaded.permissionRemovals.length, 0);
  assert.ok(loaded.runtimeMessages.some(message =>
    message.type === 'GATEWAY_PERMISSION_ATTEMPT_END' && message.attemptId === authorization.permissionAttemptId));

  // Path changes under the same authorized origin are safe and use the current captured field value.
  const sameOrigin = loadOptions();
  sameOrigin.element('#sub2apiBaseUrl').value = 'https://first.example/api';
  let sameOriginAuthorization;
  sameOrigin.context.requestGatewayPermission('sub2api', (_granted, value) => { sameOriginAuthorization = value; });
  await new Promise(resolve => setImmediate(resolve));
  sameOrigin.element('#sub2apiBaseUrl').value = 'https://first.example/other-api';
  assert.equal(sameOrigin.context.saveAuthorizedGateway(sameOriginAuthorization), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sameOrigin.savedSettings[0].sub2apiBaseUrl, 'https://first.example/other-api');
  const transaction = sameOrigin.runtimeMessages.find(message => message.type === 'COMMIT_SETTINGS_TRANSACTION').transaction;
  assert.equal(transaction.gatewayPermissionChange.provider, 'sub2api');
  assert.equal(transaction.gatewayPermissionChange.oldOrigin, '');
  assert.equal(transaction.gatewayPermissionChange.newOrigin, 'https://first.example/*');
  assert.equal(transaction.gatewayPermissionChange.attemptedOrigin, 'https://first.example/*');
  assert.equal(transaction.gatewayPermissionChange.permissionAttemptId, sameOriginAuthorization.permissionAttemptId);
  assert.match(transaction.gatewayPermissionChange.permissionAttemptId, /^[A-Za-z0-9_-]{16,128}$/);
  // 权限收尾已交给 service worker；即使弹窗在提交后立即销毁也不依赖页面回调。
  assert.equal(sameOrigin.permissionRemovals.length, 0);
});

test('unused historical gateway permissions are revoked but in-use and required origins are retained', () => {
  const loaded = loadOptions();
  loaded.context.setSavedGatewayBase('sub2api', 'https://shared.example');
  loaded.context.revokeGatewayOriginIfUnused('https://shared.example/*');
  assert.equal(loaded.permissionRemovals.length, 0);

  loaded.context.setSavedGatewayBase('sub2api', '');
  loaded.context.revokeGatewayOriginIfUnused('https://shared.example/*');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.permissionRemovals)), [{ origins: ['https://shared.example/*'] }]);

  loaded.context.revokeGatewayOriginIfUnused('https://api.openai.com/*');
  assert.equal(loaded.permissionRemovals.length, 1);
});

test('import validation rejects invalid providers, types, URLs, and model-list shapes', () => {
  const { context } = loadOptions();
  const settingKeys = ['provider', 'sub2apiBaseUrl', 'enableGestures'];
  const localKeys = ['fetchedModels_openai'];

  assert.throws(() => context.validateImportedSettings({ provider: 'unknown' }, settingKeys, localKeys), /无效的 AI 服务商/);
  assert.throws(() => context.validateImportedSettings({ enableGestures: 'yes' }, settingKeys, localKeys), /类型无效/);
  assert.throws(() => context.validateImportedSettings({ sub2apiBaseUrl: 'http://evil.example' }, settingKeys, localKeys), /HTTPS/);
  assert.throws(() => context.validateImportedSettings({ claudeKey: 'x'.repeat(10001) }, ['claudeKey'], []), /长度/);
  assert.throws(() => context.validateImportedSettings({ claudeModel: 'x'.repeat(501) }, ['claudeModel'], []), /长度/);
  assert.throws(() => context.validateImportedSettings({ prompt: 'x'.repeat(50001) }, ['prompt'], []), /长度/);
  assert.throws(() => context.validateImportedSettings({
    fetchedModels_openai: [{ value: 'gpt-test' }],
  }, settingKeys, localKeys), /模型列表/);

  const valid = context.validateImportedSettings({
    provider: 'sub2api',
    sub2apiBaseUrl: 'https://gateway.example:9443/api',
    enableGestures: true,
    fetchedModels_openai: [{ value: 'gpt-test', label: 'GPT Test', extra: 'discarded' }],
  }, settingKeys, localKeys);
  assert.equal(valid.filtered.sub2apiBaseUrl, 'https://gateway.example:9443/api');
  assert.deepEqual(JSON.parse(JSON.stringify(valid.localFiltered.fetchedModels_openai)), [
    { value: 'gpt-test', label: 'GPT Test' },
  ]);
  assert.throws(() => context.validateImportedSettings({
    fetchedModels_openai: Array.from({ length: 5001 }, (_, i) => ({ value: 'gpt-' + i, label: 'GPT ' + i })),
  }, [], localKeys), /模型列表/);
});

test('settings delegates legacy credential migration to the single background owner', async () => {
  const loaded = loadOptions({
    syncData: { claudeKey: 'legacy-secret', openaiKey: 'legacy-openai' },
    runtimeSendMessage(message) {
      assert.equal(message.type, 'MIGRATE_SECRETS');
      return { ok: true };
    },
  });

  await loaded.context.migrateLegacySecrets();
  assert.deepEqual(loaded.runtimeMessages, [{ type: 'MIGRATE_SECRETS' }]);
  assert.equal(loaded.storageData.local.claudeKey, undefined);
  assert.equal(loaded.storageData.sync.claudeKey, 'legacy-secret');
});

test('background credential migration errors fail closed and can be retried from settings', async () => {
  const loaded = loadOptions({
    syncData: { claudeKey: 'legacy-secret' },
    runtimeSendMessage(_message, callCount) {
      return callCount === 1 ? { ok: false, error: 'access level denied' } : { ok: true };
    },
  });
  await assert.rejects(loaded.context.migrateLegacySecrets(), /access level denied/);
  await loaded.context.migrateLegacySecrets();
  assert.equal(loaded.runtimeMessages.length, 2);
  assert.equal(loaded.storageData.local.claudeKey, undefined);
  assert.equal(loaded.storageData.sync.claudeKey, 'legacy-secret');
});

test('import commit rolls back both storage areas when either write fails', async () => {
  const loaded = loadOptions({
    failSyncSetOnce: true,
    localData: { claudeKey: 'old-key' },
    syncData: { provider: 'claude', enableGestures: true },
  });
  await assert.rejects(
    loaded.context.commitImportedSettings({ claudeKey: 'new-key', gatewayPermissionReauthorizationRequired: true }, {
      provider: 'openai', enableGestures: false,
    }),
    /已恢复原设置/
  );
  assert.equal(loaded.storageData.local.claudeKey, 'old-key');
  assert.equal(loaded.storageData.local.gatewayPermissionReauthorizationRequired, undefined);
  assert.equal(loaded.storageData.sync.provider, 'claude');
  assert.equal(loaded.storageData.sync.enableGestures, true);
});

test('import delegates old gateway revocation and forced reauthorization to the background transaction', async () => {
  const loaded = loadOptions();
  await loaded.context.commitImportedSettings(
    { gatewayPermissionReauthorizationRequired: true },
    { sub2apiBaseUrl: 'https://same.example/new-path' },
    {
      provider: 'sub2api', oldOrigin: 'https://same.example/*',
      newOrigin: 'https://same.example/*', attemptedOrigin: '', forceReauthorize: true,
    }
  );
  const transaction = loaded.runtimeMessages.find(message => message.type === 'COMMIT_SETTINGS_TRANSACTION').transaction;
  assert.equal(transaction.gatewayPermissionChange.forceReauthorize, true);
  assert.equal(transaction.gatewayPermissionChange.attemptedOrigin, '');
  assert.equal(loaded.permissionRemovals.length, 0);
});

test('settings delegates clearing all generated-video cache to the service worker', async () => {
  const loaded = loadOptions();
  await loaded.context.clearAllCachedResults();
  assert.deepEqual(loaded.runtimeMessages.at(-1), { type: 'CACHE_CLEAR', incognito: false });
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.match(html, /id="clearAllCache"/);
});

test('ChatGPT auth validation supports padded JWT status decoding and rejects malformed fields', () => {
  const strictAtob = (value) => {
    if (value.length % 4 !== 0) throw new Error('missing padding');
    return atob(value);
  };
  const loaded = loadOptions({ atob: strictAtob });
  const payload = Buffer.from(JSON.stringify({ exp: 123, sub: 'padding-case' })).toString('base64url');
  const token = `header.${payload}.signature`;
  assert.equal(loaded.context.decodeJwtClaims(token).sub, 'padding-case');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.context.normalizeChatgptAuthInput({
    tokens: { access_token: token, refresh_token: 'refresh', id_token: '', account_id: 'acct' },
  }))), { access_token: token, refresh_token: 'refresh', account_id: 'acct' });
  assert.throws(() => loaded.context.normalizeChatgptAuthInput({
    access_token: token, refresh_token: { secret: true },
  }), /refresh_token/);
  assert.throws(() => loaded.context.normalizeChatgptAuthInput({
    access_token: 'x'.repeat(200001),
  }), /access_token/);
});

test('saving writes credentials only to local storage and export keys exclude all credentials', async () => {
  const loaded = loadOptions();
  loaded.element('#currentKey').value = 'local-only-secret';
  loaded.element('#model').value = 'claude-fable-5';

  await new Promise((resolve, reject) => {
    loaded.context.saveSettings(false, undefined, undefined, error => error ? reject(error) : resolve());
  });
  assert.equal(loaded.savedSecrets.at(-1).claudeKey, 'local-only-secret');
  assert.equal('claudeKey' in loaded.savedSettings.at(-1), false);
  const exportKeys = vm.runInContext('SYNC_SETTING_KEYS', loaded.context);
  for (const key of ['claudeKey', 'openaiKey', 'geminiKey', 'sub2apiKey']) {
    assert.equal(exportKeys.includes(key), false);
  }
});

test('ordinary save rolls local credentials back when synchronized settings fail', async () => {
  const loaded = loadOptions({
    failSyncSetOnce: true,
    localData: { claudeKey: 'old-key', openaiKey: 'old-openai' },
    syncData: { provider: 'claude', claudeModel: 'old-model' },
  });
  vm.runInContext("keyCache.claudeKey = 'old-key'; keyCache.openaiKey = 'old-openai'; modelCache.claude = 'old-model'", loaded.context);
  loaded.element('#currentKey').value = 'new-key';
  loaded.element('#model').value = 'new-model';

  const error = await new Promise(resolve => {
    loaded.context.saveSettings(false, undefined, undefined, resolve);
  });
  assert.match(error.message, /已恢复原设置/);
  assert.equal(loaded.storageData.local.claudeKey, 'old-key');
  assert.equal(loaded.storageData.local.openaiKey, 'old-openai');
  assert.equal(loaded.storageData.sync.provider, 'claude');
  assert.equal(loaded.storageData.sync.claudeModel, 'old-model');
});

test('overlapping saves serialize so a failed older save cannot roll back a newer value', async () => {
  const loaded = loadOptions({
    failSyncSetOnce: true,
    localData: { claudeKey: 'original' },
    syncData: { provider: 'claude', claudeModel: 'original-model' },
  });
  loaded.element('#currentKey').value = 'first-key';
  loaded.element('#model').value = 'first-model';
  const first = new Promise(resolve => loaded.context.saveSettings(false, undefined, undefined, resolve));

  loaded.element('#currentKey').value = 'second-key';
  loaded.element('#model').value = 'second-model';
  const second = new Promise(resolve => loaded.context.saveSettings(false, undefined, undefined, resolve));
  const [firstError, secondError] = await Promise.all([first, second]);

  assert.match(firstError.message, /已恢复原设置/);
  assert.equal(secondError, null);
  assert.equal(loaded.storageData.local.claudeKey, 'second-key');
  assert.equal(loaded.storageData.sync.claudeModel, 'second-model');
});

test('saving before asynchronous settings load completes cannot erase locally stored credentials', () => {
  const loaded = loadOptions({
    settingsLoaded: false,
    localData: { claudeKey: 'preserve-me', openaiKey: 'also-preserve' },
  });
  loaded.element('#currentKey').value = '';

  assert.equal(loaded.context.saveSettings(false), false);
  assert.equal(loaded.savedSecrets.length, 0);
  assert.equal(loaded.savedSettings.length, 0);
  assert.equal(loaded.storageData.local.claudeKey, 'preserve-me');
  assert.equal(loaded.storageData.local.openaiKey, 'also-preserve');
});

test('file/auth inputs never schedule generic autosave and debounce can cancel or flush pending work', () => {
  const loaded = loadOptions();
  assert.equal(loaded.context.shouldAutoSaveElement({ id: 'importFile', type: 'file' }), false);
  assert.equal(loaded.context.shouldAutoSaveElement({ id: 'chatgptAuthPaste', type: 'textarea' }), false);
  assert.equal(loaded.context.shouldAutoSaveElement({ id: 'sub2apiBaseUrl', type: 'text' }), false);
  assert.equal(loaded.context.shouldAutoSaveElement({ id: 'currentKey', type: 'password' }), true);

  let calls = 0;
  const debounced = loaded.context.debounce(() => { calls++; }, 1000);
  debounced();
  debounced.cancel();
  debounced.flush();
  assert.equal(calls, 0);
  debounced();
  debounced.flush();
  assert.equal(calls, 1);
});

test('model fetch is single-flight and late results stay with the provider that started the request', async () => {
  const loaded = loadOptions();
  let resolveFetch;
  let fetcherCalls = 0;
  loaded.context.__testFetcher = () => {
    fetcherCalls++;
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  vm.runInContext('MODEL_FETCHERS.claude = __testFetcher', loaded.context);
  loaded.element('#currentKey').value = 'secret';

  const first = loaded.context.fetchLatestModels();
  const second = loaded.context.fetchLatestModels();
  assert.equal(fetcherCalls, 1);
  assert.equal(loaded.element('#fetchModels').disabled, true);
  assert.equal(loaded.element('#fetchModelsBtn').disabled, true);
  vm.runInContext("currentProvider = 'openai'", loaded.context);
  resolveFetch([{ value: 'claude-test', label: 'Claude Test' }]);
  await Promise.all([first, second]);

  assert.deepEqual(loaded.storageData.local.fetchedModels_claude, [{ value: 'claude-test', label: 'Claude Test' }]);
  assert.equal(loaded.storageData.local.fetchedModels_openai, undefined);
  assert.equal(loaded.element('#fetchModels').disabled, false);
  assert.equal(loaded.element('#fetchModelsBtn').disabled, false);
});

test('model fetch single-flight is scoped per provider and a timeout always unlocks buttons', async () => {
  const loaded = loadOptions();
  const resolvers = {};
  loaded.context.__fetchClaude = () => new Promise(resolve => { resolvers.claude = resolve; });
  loaded.context.__fetchOpenai = () => new Promise(resolve => { resolvers.openai = resolve; });
  vm.runInContext('MODEL_FETCHERS.claude = __fetchClaude; MODEL_FETCHERS.openai = __fetchOpenai', loaded.context);
  loaded.element('#currentKey').value = 'secret';

  const claude = loaded.context.fetchLatestModels();
  vm.runInContext("currentProvider = 'openai'", loaded.context);
  const openai = loaded.context.fetchLatestModels();
  assert.equal(typeof resolvers.claude, 'function');
  assert.equal(typeof resolvers.openai, 'function');
  resolvers.claude([{ value: 'claude-a', label: 'Claude A' }]);
  resolvers.openai([{ value: 'gpt-a', label: 'GPT A' }]);
  await Promise.all([claude, openai]);
  assert.ok(loaded.storageData.local.fetchedModels_claude);
  assert.ok(loaded.storageData.local.fetchedModels_openai);

  const timedOut = loadOptions({
    fetch: () => new Promise(() => {}),
    setTimeout(callback, ms) {
      if (ms === 30000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });
  timedOut.element('#currentKey').value = 'secret';
  await timedOut.context.fetchLatestModels();
  assert.equal(timedOut.element('#fetchModels').disabled, false);
  assert.equal(timedOut.element('#fetchModelsBtn').disabled, false);
  assert.equal(vm.runInContext('modelFetchFlights.size', timedOut.context), 0);
  assert.match(timedOut.element('#status').textContent, /超时/);
});

test('provider rendering ignores malformed fetched-model caches and keeps all presets', () => {
  const loaded = loadOptions();
  const expected = JSON.parse(JSON.stringify(vm.runInContext(
    'PROVIDERS.claude.models.map(model => model.value)',
    loaded.context
  )));
  const malformedCaches = [
    'not-an-array',
    { length: 1, value: 'fake' },
    [null, { value: 'claude-incomplete' }],
  ];

  for (const malformed of malformedCaches) {
    loaded.context.__malformedFetchedModels = malformed;
    vm.runInContext('fetchedModelsCache.claude = __malformedFetchedModels', loaded.context);
    assert.doesNotThrow(() => loaded.context.switchProvider('claude'));
    assert.deepEqual(loaded.element('#model').options.map(option => option.value), expected);
  }
});

test('model fetchers paginate Claude/Gemini and direct OpenAI only offers backend-supported gpt models', async () => {
  let claudePage = 0;
  const claude = loadOptions({
    fetch: async () => jsonStreamResponse(++claudePage === 1
      ? { data: [{ id: 'claude-a', display_name: 'A' }], has_more: true, last_id: 'cursor-a' }
      : { data: [{ id: 'claude-b', display_name: 'B' }], has_more: false }),
  });
  const claudeFetcher = vm.runInContext('MODEL_FETCHERS.claude', claude.context);
  assert.deepEqual(JSON.parse(JSON.stringify((await claudeFetcher('key')).map(model => model.value).sort())), ['claude-a', 'claude-b']);
  assert.match(claude.fetchCalls[1][0], /after_id=cursor-a/);

  let geminiPage = 0;
  const gemini = loadOptions({
    fetch: async () => jsonStreamResponse(++geminiPage === 1
      ? { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' }
      : { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] }),
  });
  const geminiFetcher = vm.runInContext('MODEL_FETCHERS.gemini', gemini.context);
  assert.deepEqual(JSON.parse(JSON.stringify((await geminiFetcher('key')).map(model => model.value).sort())), ['gemini-a', 'gemini-b']);
  assert.match(gemini.fetchCalls[1][0], /pageToken=next/);
  assert.equal(new URL(gemini.fetchCalls[0][0]).searchParams.has('key'), false);
  assert.equal(gemini.fetchCalls[0][1].headers['x-goog-api-key'], 'key');
  assert.equal(gemini.fetchCalls[0][1].redirect, 'error');

  const openai = loadOptions({
    fetch: async () => jsonStreamResponse({ data: [{ id: 'gpt-good' }, { id: 'gpt-image-1' }, { id: 'o3' }, { id: 'chatgpt-alias' }] }),
  });
  const openaiFetcher = vm.runInContext('MODEL_FETCHERS.openai', openai.context);
  assert.deepEqual(JSON.parse(JSON.stringify((await openaiFetcher('key')).map(model => model.value))), ['gpt-good']);
  assert.equal(openai.fetchCalls[0][1].redirect, 'error');

  const oversized = loadOptions({
    fetch: async () => jsonStreamResponse({ data: Array.from({ length: 5001 }, (_, i) => ({ id: 'gpt-' + i })) }),
  });
  const oversizedFetcher = vm.runInContext('MODEL_FETCHERS.openai', oversized.context);
  await assert.rejects(oversizedFetcher('key'), /5000/);
});

test('model-list JSON parsing is byte-bounded and refuses an unbounded response fallback', async () => {
  const loaded = loadOptions();
  let cancelled = false;
  const oversized = {
    body: { getReader() { return {
      async read() { return { done: false, value: new Uint8Array(11) }; },
      async cancel() { cancelled = true; },
    }; } },
  };
  await assert.rejects(loaded.context.readBoundedJsonResponse(oversized, 10), /2 MiB/);
  assert.equal(cancelled, true);

  let jsonCalled = false;
  await assert.rejects(loaded.context.readBoundedJsonResponse({
    body: null,
    async json() { jsonCalled = true; return {}; },
  }, 10), /安全限界读取/);
  assert.equal(jsonCalled, false);
});

test('manifest minimizes hosts, scopes frame injection, and exposes only required shadow resources', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.minimum_chrome_version, '140');
  assert.equal(manifest.permissions.includes('activeTab'), false);
  assert.equal(manifest.host_permissions.includes('https://*/*'), false);
  assert.equal(manifest.host_permissions.includes('http://*/*'), false);
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
  const translate = manifest.content_scripts.find(entry => entry.js.includes('translate/translate.js'));
  assert.deepEqual(translate.matches, ['http://*/*', 'https://*/*']);
  assert.equal(translate.all_frames, true);
  assert.equal(translate.match_about_blank, true);
  assert.equal(translate.match_origin_as_fallback, true);
  const gestures = manifest.content_scripts.find(entry => entry.js.includes('gestures/gestures.js'));
  assert.deepEqual(gestures.matches, ['http://*/*', 'https://*/*']);
  const xhs = manifest.content_scripts.find(entry => entry.js.includes('xhs/xhs-scroll-fix.js'));
  assert.equal(xhs.run_at, 'document_start');
  const translateCss = manifest.web_accessible_resources.find(entry => entry.resources.includes('translate/translate.css'));
  const youtubeCss = manifest.web_accessible_resources.find(entry => entry.resources.includes('youtube/content.css'));
  const chatFrame = manifest.web_accessible_resources.find(entry => entry.resources.includes('youtube/chat-frame.html'));
  assert.deepEqual(translateCss, {
    resources: ['translate/translate.css'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true,
  });
  assert.deepEqual(youtubeCss, {
    resources: ['youtube/content.css'], matches: ['https://www.youtube.com/*'], use_dynamic_url: true,
  });
  assert.deepEqual(chatFrame, {
    resources: ['youtube/chat-frame.html'],
    matches: ['https://www.youtube.com/*'],
  });
});

test('credential fields and external links have browser autofill, spellcheck, and opener hardening', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.match(html, /id="currentKey"[^>]*spellcheck="false"[^>]*autocomplete="new-password"/);
  assert.match(html, /id="sub2apiBaseUrl"[^>]*spellcheck="false"[^>]*autocomplete="off"/);
  assert.match(html, /id="chatgptAuthPaste"[^>]*maxlength="1000000"[^>]*spellcheck="false"[^>]*autocomplete="off"/);
  assert.match(html, /id="persistentStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, new RegExp(`id="version-badge">v${manifest.version.replace(/\./g, '\\.')}`));
  for (const match of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
    assert.match(match[0], /rel="noopener noreferrer"/);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  assert.match(source, /file\.size > MAX_IMPORT_FILE_BYTES/);
  assert.match(source, /reader\.onerror/);
  assert.match(source, /reader\.onabort/);
  assert.match(source, /saveChatgptAuthPaste\.cancel\(\)/);
});

test('current provider presets use the documented recommended model generations', () => {
  const { context } = loadOptions();
  const presets = vm.runInContext(`({
    claude: PROVIDERS.claude.models.map(m => [m.value, m.label]),
    minimax: PROVIDERS.minimax.models.map(m => [m.value, m.label]),
    kimi: PROVIDERS.kimi.models.map(m => [m.value, m.label])
  })`, context);
  const plainPresets = JSON.parse(JSON.stringify(presets));
  assert.equal(plainPresets.claude[0][0], 'claude-opus-5');
  assert.match(plainPresets.claude.find(([id]) => id === 'claude-fable-5')[1], /能力最强/);
  assert.equal(plainPresets.minimax[0][0], 'MiniMax-M3');
  assert.equal(plainPresets.kimi[0][0], 'kimi-k3');
  assert.ok(plainPresets.kimi.some(([id]) => id === 'kimi-k2.7-code-highspeed'));
});
