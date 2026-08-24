'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createFakeIndexedDB() {
  const stores = new Map();
  let initialized = false;

  const db = {
    objectStoreNames: {
      contains(name) { return stores.has(name); },
    },
    createObjectStore(name) {
      if (!stores.has(name)) stores.set(name, new Map());
    },
    transaction(name) {
      if (!stores.has(name)) throw new Error('Missing object store: ' + name);
      const records = stores.get(name);
      let pending = 0;
      let aborted = false;
      let completionQueued = false;

      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          if (aborted) return;
          aborted = true;
          queueMicrotask(() => { if (tx.onabort) tx.onabort(); });
        },
        objectStore() { return store; },
      };

      function maybeComplete() {
        if (aborted || pending !== 0 || completionQueued) return;
        completionQueued = true;
        queueMicrotask(() => {
          completionQueued = false;
          if (!aborted && pending === 0 && tx.oncomplete) tx.oncomplete();
        });
      }

      function request(operation) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        pending++;
        queueMicrotask(() => {
          if (aborted) return;
          try {
            req.result = operation();
            if (req.onsuccess) req.onsuccess();
          } catch (error) {
            req.error = error;
            tx.error = error;
            if (req.onerror) req.onerror();
            else if (tx.onerror) tx.onerror();
          } finally {
            pending--;
            maybeComplete();
          }
        });
        return req;
      }

      const store = {
        get(key) {
          return request(() => {
            const value = records.get(key);
            return value === undefined ? undefined : structuredClone(value);
          });
        },
        put(value) {
          return request(() => {
            records.set(value.videoId, structuredClone(value));
            return value.videoId;
          });
        },
        delete(key) {
          return request(() => records.delete(key));
        },
        clear() {
          return request(() => records.clear());
        },
      };
      return tx;
    },
    close() {},
  };

  return {
    open() {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (!initialized) {
          initialized = true;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

function loadBackground(options = {}) {
  let messageListener = null;
  let connectListener = null;
  let offscreenExists = options.offscreenPreexisting === true;
  let offscreenPortListener = null;
  let permissionAllowed = options.permissionAllowed !== false;
  let broadPermissionPresent = options.broadPermissionPresent === true;
  const grantedOrigins = new Set(Array.isArray(options.grantedOrigins) ? options.grantedOrigins : []);
  const hasExplicitGrantedOrigins = Array.isArray(options.grantedOrigins);
  const sentMessages = [];
  const fetchCalls = [];
  const tabListeners = {};
  const storageData = {
    local: structuredClone(options.localData || {}),
    sync: structuredClone(options.syncData || {}),
  };
  const storageWrites = { local: [], sync: [] };
  const storageRemovals = { local: [], sync: [] };
  const storageAccessLevels = [];
  const tabActions = [];
  const runtimeMessages = [];
  const permissionRemovals = [];
  const networkPortMessages = [];
  const offscreenRoutes = new Map();
  let offscreenCloseCount = 0;
  let storageChangeListener = null;
  let installedListener = null;
  let failSyncSetRemaining = options.failSyncSetOnce ? 1 : 0;

  function selected(data, fields) {
    if (fields == null) return structuredClone(data);
    if (typeof fields === 'string') return { [fields]: structuredClone(data[fields]) };
    if (Array.isArray(fields)) {
      return Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(data, key)).map(key => [key, structuredClone(data[key])]));
    }
    return Object.assign({}, structuredClone(fields), Object.fromEntries(
      Object.keys(fields).filter(key => Object.prototype.hasOwnProperty.call(data, key)).map(key => [key, structuredClone(data[key])])
    ));
  }

  function storageArea(name) {
    return {
      get(fields, callback) {
        if (name === 'sync' && options.featureStorageGet && Array.isArray(fields) && fields.length === 1 && String(fields[0]).startsWith('enable')) {
          options.featureStorageGet(fields, callback);
          return;
        }
        if (name === 'sync' && options.storageGet && Array.isArray(fields) && fields.includes('provider')) {
          options.storageGet(fields, callback);
          return;
        }
        callback(selected(storageData[name], fields));
      },
      set(data, callback = () => {}) {
        storageWrites[name].push(structuredClone(data));
        if (name === 'sync' && failSyncSetRemaining > 0) {
          failSyncSetRemaining--;
          context.chrome.runtime.lastError = { message: 'simulated sync failure' };
          callback();
          context.chrome.runtime.lastError = null;
          return;
        }
        const commit = () => {
          Object.assign(storageData[name], structuredClone(data));
          callback();
        };
        if (options.storageSet) {
          const handled = options.storageSet(name, structuredClone(data), commit);
          if (handled === true) return;
        }
        if (name === 'local' && Object.prototype.hasOwnProperty.call(data, 'chatgptAuth') && options.chatgptStorageSet) {
          options.chatgptStorageSet(structuredClone(data), commit);
          return;
        }
        commit();
      },
      remove(fields, callback = () => {}) {
        const keys = Array.isArray(fields) ? fields : [fields];
        storageRemovals[name].push([...keys]);
        const commit = () => {
          keys.forEach(key => delete storageData[name][key]);
          callback();
        };
        if (options.storageRemove && options.storageRemove(name, [...keys], commit) === true) return;
        commit();
      },
      ...(name === 'local' ? {
        setAccessLevel(value) {
          storageAccessLevels.push(structuredClone(value));
          return options.accessLevelError ? Promise.reject(options.accessLevelError) : Promise.resolve();
        },
      } : {}),
    };
  }

  const context = {
    AbortController,
    DOMException,
    Map,
    Promise,
    Set,
    TextDecoder,
    URL,
    atob: options.atob || atob,
    crypto: globalThis.crypto,
    clearInterval,
    clearTimeout: options.clearTimeout || clearTimeout,
    console,
    fetch(...args) {
      fetchCalls.push(args);
      if (!options.fetch) throw new Error('Unexpected fetch');
      return options.fetch(...args);
    },
    indexedDB: options.indexedDB || createFakeIndexedDB(),
    setInterval,
    setTimeout: options.setTimeout || setTimeout,
    chrome: {
      permissions: {
        contains(query, callback) {
          if (options.permissionContains) options.permissionContains(query, callback);
          else if (query?.origins?.includes('https://*/*')) {
            callback(broadPermissionPresent || grantedOrigins.has('https://*/*'));
          }
          else if (hasExplicitGrantedOrigins) callback((query?.origins || []).every(origin => grantedOrigins.has(origin)));
          else callback(permissionAllowed);
        },
        remove(query, callback) {
          permissionRemovals.push(structuredClone(query));
          const finish = (removed) => {
            if (removed) {
              for (const origin of query?.origins || []) {
                grantedOrigins.delete(origin);
                if (origin === 'https://*/*') broadPermissionPresent = false;
              }
            }
            callback(removed);
          };
          if (options.permissionRemove) options.permissionRemove(query, finish);
          else finish(options.broadPermissionRemoved === true || hasExplicitGrantedOrigins);
        },
        getAll(callback) {
          if (options.permissionGetAll) options.permissionGetAll(callback);
          else callback({ origins: [...grantedOrigins] });
        },
      },
      runtime: {
        id: 'test-extension',
        lastError: null,
        getURL(resource = '') { return `chrome-extension://test-extension/${String(resource).replace(/^\//, '')}`; },
        getPlatformInfo(callback) { if (callback) callback({ os: 'mac' }); },
        sendMessage(message) {
          runtimeMessages.push(structuredClone(message));
          if (options.runtimeSendMessage) return Promise.resolve(options.runtimeSendMessage(message));
          return Promise.resolve();
        },
        onMessage: {
          addListener(listener) { messageListener = listener; },
        },
        onConnect: {
          addListener(listener) { connectListener = listener; },
        },
        async getContexts() {
          return offscreenExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
        },
        onInstalled: { addListener(listener) { installedListener = listener; } },
      },
      offscreen: {
        async createDocument() {
          offscreenExists = true;
          queueMicrotask(() => {
            if (!connectListener) return;
            const disconnectListeners = [];
            const port = {
              name: 'aatools-offscreen-network-v1',
              sender: {
                id: 'test-extension',
                url: 'chrome-extension://test-extension/offscreen/network-host.html',
              },
              onMessage: { addListener(listener) { offscreenPortListener = listener; } },
              onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
              disconnect() { disconnectListeners.forEach(listener => listener()); },
              postMessage(message) {
                networkPortMessages.push(structuredClone(message));
                if (message.type === 'NETWORK_START') {
                  offscreenRoutes.set(message.job.jobId, structuredClone(message.job.route));
                  const emit = (event) => queueMicrotask(() => offscreenPortListener?.({
                    type: 'NETWORK_EVENT', jobId: message.job.jobId,
                    route: structuredClone(offscreenRoutes.get(message.job.jobId)), event: structuredClone(event),
                  }));
                  if (options.networkStart) options.networkStart(structuredClone(message.job), emit);
                  else if (message.job.route.kind === 'internal') emit({ kind: 'ERROR', code: 'test_unconfigured', message: 'test internal network unconfigured' });
                  else if (message.job.route.kind === 'transcribe') emit({ kind: 'DONE', text: '[00:00] test transcript' });
                  else emit({ kind: 'DONE', text: 'test output' });
                } else if (message.type === 'NETWORK_ROUTE_UPDATE') {
                  if (!options.dropNetworkRouteUpdate) {
                    offscreenRoutes.set(message.jobId, structuredClone(message.route));
                    if (!options.dropNetworkRouteUpdateAck) {
                      queueMicrotask(() => offscreenPortListener?.({
                        type: 'NETWORK_ROUTE_UPDATED', version: 1,
                        generation: '12345678-1234-1234-1234-123456789abc',
                        jobId: message.jobId, routeRevision: message.route.routeRevision,
                      }));
                    }
                  }
                } else if (message.type === 'NETWORK_ACK') {
                  offscreenRoutes.delete(message.jobId);
                }
              },
            };
            connectListener(port);
            queueMicrotask(() => offscreenPortListener?.({
              type: 'NETWORK_HELLO', version: 1,
              generation: '12345678-1234-1234-1234-123456789abc', jobs: [],
            }));
          });
        },
        async closeDocument() {
          offscreenCloseCount++;
          offscreenExists = false;
        },
      },
      tabs: {
        onRemoved: { addListener(listener) { tabListeners.removed = listener; } },
        onUpdated: { addListener(listener) { tabListeners.updated = listener; } },
        sendMessage(tabId, message, deliveryOptions) {
          sentMessages.push({ tabId, message, deliveryOptions });
          if (options.tabsSendMessage) return Promise.resolve(options.tabsSendMessage(tabId, message, deliveryOptions));
          return Promise.resolve();
        },
        remove(tabId) {
          tabActions.push({ type: 'remove', tabId });
          return options.tabsRemove ? options.tabsRemove(tabId) : Promise.resolve();
        },
        reload(tabId, details) {
          tabActions.push({ type: 'reload', tabId, details });
          return options.tabsReload ? options.tabsReload(tabId, details) : Promise.resolve();
        },
      },
      sessions: {
        restore() {
          tabActions.push({ type: 'restore' });
          return options.sessionsRestore ? options.sessionsRestore() : Promise.resolve();
        },
      },
      storage: {
        local: storageArea('local'),
        sync: storageArea('sync'),
        onChanged: { addListener(listener) { storageChangeListener = listener; } },
      },
    },
  };
  if (options.executeScript) {
    context.chrome.scripting = { executeScript: options.executeScript };
  }
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    context,
    fetchCalls,
    messageListener,
    permissionRemovals,
    networkPortMessages,
    get offscreenCloseCount() { return offscreenCloseCount; },
    runtimeMessages,
    sentMessages,
    storageAccessLevels,
    storageData,
    storageRemovals,
    storageWrites,
    triggerStorageChange(changes, areaName) {
      if (storageChangeListener) storageChangeListener(changes, areaName);
    },
    triggerInstalled(details = { reason: 'update' }) {
      if (installedListener) installedListener(details);
    },
    triggerConnect(port) {
      if (connectListener) connectListener(port);
    },
    tabListeners,
    tabActions,
    setPermissionAllowed(value) { permissionAllowed = value; },
  };
}

function dispatchMessage(loaded, message, sender) {
  return new Promise((resolve) => {
    if (sender?.tab) sender = Object.assign({ documentId: 'document-12345678' }, sender);
    let responded = false;
    let returned;
    returned = loaded.messageListener(message, sender, (response) => {
      responded = true;
      resolve({ returned, response });
    });
    if (returned !== true && !responded) resolve({ returned, response: undefined });
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function jwtWithClaims(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

function jsonStreamResponse(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  let read = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: encoded };
          },
          async cancel() {},
        };
      },
    },
  };
}

test('sanitizeModel rejects retired model names and wrong-provider prefixes', () => {
  const { context } = loadBackground();

  // deepseek 旧模型名（2026-07-24 退役）清空回退默认模型
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-chat'), '');
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-reasoner'), '');
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(context.sanitizeModel('deepseek', 'gpt-5.6'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-3-5-sonnet-20241022'), '');
  assert.equal(context.sanitizeModel('openai', 'gpt-image-1'), '');
  for (const unsafe of ['gemini-safe?key=leak', 'gemini-safe#fragment', 'gemini/safe', 'gemini safe', 'gemini-safe\nInjected']) {
    assert.equal(context.sanitizeModel('gemini', unsafe), '');
  }
  assert.equal(context.sanitizeModel('sub2api', 'GPT_5.6'), 'gpt-5.6');
  assert.equal(context.sanitizeModel('sub2api', 'gpt-5.6/../../evil'), '');

  // kimi 有 kimi-* 与旧的 moonshot-v1-* 两条模型线，前缀校验须同时放行
  assert.equal(context.sanitizeModel('kimi', 'kimi-k2.6'), 'kimi-k2.6');
  assert.equal(context.sanitizeModel('kimi', 'moonshot-v1-8k'), 'moonshot-v1-8k');
  assert.equal(context.sanitizeModel('kimi', 'deepseek-v4-flash'), '');
});

test('kimi request body follows each model tier thinking contract', async () => {
  async function bodyFor(model) {
    const loaded = loadBackground();
    // 2048 = 划词翻译档，思考模型下最容易被吃光的那一档
    await loaded.context.callProvider('kimi', {
      key: 'k', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2048, tabId: 1, PREFIX: 'TRANSLATE', requestId: 'r1', model,
      deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
    });
    const start = loaded.networkPortMessages.find(item => item.type === 'NETWORK_START');
    return { url: start.job.request.url, body: JSON.parse(start.job.request.body) };
  }

  // 思考可关：关掉即可，预算无需放大
  const k26 = await bodyFor('kimi-k2.6');
  assert.equal(k26.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.deepEqual(k26.body.thinking, { type: 'disabled' });
  assert.equal(k26.body.max_completion_tokens, 2048);
  assert.equal(k26.body.max_tokens, undefined);

  // 思考关不掉：压 effort 之外还必须放大预算，否则 reasoning 吃光额度、正文为空
  const k3 = await bodyFor('kimi-k3');
  assert.equal(k3.body.reasoning_effort, 'low');
  assert.equal(k3.body.max_completion_tokens, 16000);
  assert.equal(k3.body.thinking, undefined);

  // k2.7-code 恒开且无 effort 档位，只能靠放大预算兜住
  const code = await bodyFor('kimi-k2.7-code');
  assert.equal(code.body.thinking, undefined);
  assert.equal(code.body.reasoning_effort, undefined);
  assert.equal(code.body.max_completion_tokens, 16000);
});

test('provider output limits match each client surface', () => {
  const { context } = loadBackground();
  assert.equal(context.providerOutputLimitForPrefix('SUMMARY'), 200000);
  assert.equal(context.providerOutputLimitForPrefix('CHAT'), 50000);
  assert.equal(context.providerOutputLimitForPrefix('TRANSLATE'), 100000);
  assert.equal(context.providerOutputLimitForPrefix('HTML'), 350000);
  assert.equal(context.providerOutputLimitForPrefix('MINDMAP'), 200000);
});

test('custom gateway validation enforces HTTPS and exact-origin authorization', async () => {
  const loaded = loadBackground();
  const { context } = loaded;

  const valid = context.validateSub2ApiBase('https://gateway.example/v1/responses/');
  assert.equal(valid.baseUrl, 'https://gateway.example');
  assert.equal(valid.permissionOrigin, 'https://gateway.example/*');
  assert.equal(
    context.validateSub2ApiBase('https://gateway.example:8443/api').permissionOrigin,
    'https://gateway.example:8443/*'
  );
  assert.equal(context.validateSub2ApiBase('http://localhost:8787/api').baseUrl, 'http://localhost:8787/api');
  assert.match(context.validateSub2ApiBase('http://gateway.example').error, /HTTPS/);
  assert.match(context.validateSub2ApiBase('https://user:pass@gateway.example').error, /用户名或密码/);
  assert.match(context.validateSub2ApiBase('https://gateway.example?token=secret').error, /查询参数/);

  assert.equal(await context.hasGatewayPermission(valid.permissionOrigin), true);
  loaded.setPermissionAllowed(false);
  assert.equal(await context.hasGatewayPermission(valid.permissionOrigin), false);
});

test('provider config read failures resolve to visible errors instead of hanging', async () => {
  const loaded = loadBackground({ storageGet() { throw new Error('settings unavailable'); } });
  const config = await loaded.context.loadProviderConfig('claude');
  assert.match(config.error, /settings unavailable/);

  await loaded.context.handleSummarize({
    provider: 'claude', requestId: 'settings-error', transcript: 'text', prompt: '{transcript}',
  }, 5, 'SUMMARY', 0, { frameId: 0, documentId: 'settings-document-1234' });
  assert.equal(loaded.sentMessages[0].message.type, 'SUMMARY_ERROR');
  assert.match(loaded.sentMessages[0].message.error, /读取扩展设置失败/);
  assert.deepEqual(plain(loaded.sentMessages[0].deliveryOptions), {
    frameId: 0, documentId: 'settings-document-1234',
  });
});

test('pre-network YouTube errors remain bound to the original document', async () => {
  const loaded = loadBackground();
  const deliveryOptions = { frameId: 0, documentId: 'preflight-document-1234' };

  await loaded.context.handleSummarize({
    type: 'SUMMARIZE', provider: 'claude', requestId: 'missing-summary-key',
    transcript: 'text', prompt: '{transcript}',
  }, 6, 'SUMMARY', 0, deliveryOptions);
  await loaded.context.handleChat({
    type: 'CHAT_ASK', provider: 'claude', requestId: 'missing-chat-key',
    transcript: 'text', messages: [{ role: 'user', content: 'question' }],
  }, 6, 0, deliveryOptions);

  assert.deepEqual(loaded.sentMessages.map(item => item.message.type), ['SUMMARY_ERROR', 'CHAT_ERROR']);
  assert.ok(loaded.sentMessages.every(item => item.deliveryOptions?.frameId === 0 &&
    item.deliveryOptions?.documentId === 'preflight-document-1234'));
});

test('background migrates synchronized API keys to trusted local storage before provider reads', async () => {
  const loaded = loadBackground({
    syncData: { claudeKey: 'legacy-secret', claudeModel: 'claude-fable-5' },
  });
  const migration = await loaded.context.ensureSecretsMigrated();
  assert.equal(migration.ok, true);
  assert.equal(loaded.storageData.local.claudeKey, 'legacy-secret');
  assert.equal('claudeKey' in loaded.storageData.sync, false);
  assert.deepEqual(loaded.storageAccessLevels[0], { accessLevel: 'TRUSTED_CONTEXTS' });

  const config = await loaded.context.loadProviderConfig('claude');
  assert.equal(config.key, 'legacy-secret');
  assert.equal(config.model, 'claude-fable-5');

  loaded.storageData.sync.claudeKey = 'remote-old-version-secret';
  loaded.triggerStorageChange({ claudeKey: { newValue: 'remote-old-version-secret' } }, 'sync');
  await loaded.context.scheduleSecretsMigrationRerun();
  assert.equal(loaded.storageData.local.claudeKey, 'legacy-secret');
  assert.equal('claudeKey' in loaded.storageData.sync, false);
});

test('credential migration fails closed when trusted-only local storage cannot be enforced', async () => {
  const loaded = loadBackground({
    accessLevelError: new Error('access level denied'),
    syncData: { claudeKey: 'must-not-copy' },
  });
  const migration = await loaded.context.ensureSecretsMigrated();
  assert.match(migration.error, /access level denied/);
  assert.equal(loaded.storageData.local.claudeKey, undefined);
  assert.equal(loaded.storageData.sync.claudeKey, 'must-not-copy');

  const auth = loadBackground({
    accessLevelError: new Error('access level denied'),
    localData: { chatgptAuth: { access_token: 'secret', refresh_token: 'refresh' } },
  });
  const result = await auth.context.ensureChatgptAccessToken();
  assert.match(result.error, /已拒绝读取/);
});

test('failed credential migration is not cached and succeeds on a later retry', async () => {
  const harnessOptions = {
    accessLevelError: new Error('temporary access-level failure'),
    syncData: { claudeKey: 'legacy-secret' },
  };
  const loaded = loadBackground(harnessOptions);
  await new Promise(resolve => setImmediate(resolve));
  harnessOptions.accessLevelError = null;
  const migration = await loaded.context.ensureSecretsMigrated();
  assert.equal(migration.ok, true);
  assert.equal(loaded.storageData.local.claudeKey, 'legacy-secret');
  assert.equal(loaded.storageData.local.openaiKey, '');
});

test('options-page credential migration accepts popup and extension-tab senders only', async () => {
  const loaded = loadBackground({ syncData: { claudeKey: 'legacy-secret' } });
  const extensionTab = await dispatchMessage(loaded, { type: 'MIGRATE_SECRETS' }, {
    id: 'test-extension',
    url: 'chrome-extension://test-extension/options.html',
    tab: { id: 9, url: 'chrome-extension://test-extension/options.html' },
  });
  assert.equal(extensionTab.response.ok, true);

  const popup = await dispatchMessage(loaded, { type: 'MIGRATE_SECRETS' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });
  assert.equal(popup.response.ok, true);

  const rejected = await dispatchMessage(loaded, { type: 'MIGRATE_SECRETS' }, {
    id: 'test-extension', frameId: 0, tab: { id: 1 }, url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.equal(rejected.response.ok, false);
});

test('settings transactions run in the service worker, roll back failures, and serialize newer saves', async () => {
  const loaded = loadBackground({
    failSyncSetOnce: true,
    localData: { claudeKey: 'original-key' },
    syncData: { provider: 'claude', claudeModel: 'original-model' },
  });
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const first = dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'first-key' },
      syncSet: { provider: 'openai', claudeModel: 'first-model' },
    },
  }, sender);
  const second = dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'second-key' },
      syncSet: { provider: 'gemini', claudeModel: 'second-model' },
    },
  }, sender);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.response.ok, false);
  assert.match(firstResult.response.error, /已恢复原设置/);
  assert.deepEqual(plain(secondResult.response), { ok: true, revision: 1 });
  assert.equal(loaded.storageData.local.claudeKey, 'second-key');
  assert.equal(loaded.storageData.sync.provider, 'gemini');
  assert.equal(loaded.storageData.sync.claudeModel, 'second-model');

  const rejected = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION', transaction: { expectedRevision: 1, localSet: { claudeKey: 'stolen' } },
  }, { id: 'test-extension', frameId: 0, tab: { id: 1 }, url: 'https://www.youtube.com/' });
  assert.equal(rejected.response.ok, false);
  assert.equal(loaded.storageData.local.claudeKey, 'second-key');

  const unknownField = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION', transaction: { expectedRevision: 1, localSet: { chatgptAuth: { access_token: 'x' } } },
  }, sender);
  assert.equal(unknownField.response.ok, false);
});

test('settings revision CAS rejects a stale options page without overwriting newer secrets', async () => {
  const loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude', claudeModel: 'original-model' },
  });
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const newer = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'newer-key' },
      syncSet: { provider: 'openai', claudeModel: 'newer-model' },
    },
  }, sender);
  assert.deepEqual(plain(newer.response), { ok: true, revision: 1 });

  const stale = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'stale-key' },
      syncSet: { provider: 'gemini', claudeModel: 'stale-model' },
    },
  }, sender);
  assert.equal(stale.response.ok, false);
  assert.equal(stale.response.conflict, true);
  assert.equal(stale.response.currentRevision, 1);
  assert.equal(loaded.storageData.local.claudeKey, 'newer-key');
  assert.equal(loaded.storageData.local.settingsRevisionV1, 1);
  assert.equal(loaded.storageData.sync.provider, 'openai');
  assert.equal(loaded.storageData.sync.claudeModel, 'newer-model');
});

test('external Chrome Sync changes persistently invalidate open options pages without double-counting local commits', async () => {
  const loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude', claudeModel: 'original-model' },
  });
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  await loaded.context.ensureSecretsMigrated();

  loaded.storageData.sync.provider = 'openai';
  loaded.triggerStorageChange({
    provider: { oldValue: 'claude', newValue: 'openai' },
  }, 'sync');
  for (let i = 0; i < 10 && loaded.storageData.local.settingsRevisionV1 !== 1; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(loaded.storageData.local.settingsRevisionV1, 1);

  const stale = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'stale-key' },
      syncSet: { provider: 'gemini' },
    },
  }, sender);
  assert.equal(stale.response.conflict, true);
  assert.equal(stale.response.currentRevision, 1);
  assert.equal(loaded.storageData.sync.provider, 'openai');

  const current = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 1,
      localSet: { claudeKey: 'current-key' },
      syncSet: { provider: 'gemini' },
    },
  }, sender);
  assert.deepEqual(plain(current.response), { ok: true, revision: 2 });
  const ownWrite = [...loaded.storageWrites.sync].reverse().find(write => write.settingsMutationV1);
  assert.equal(typeof ownWrite.settingsMutationV1, 'string');
  loaded.triggerStorageChange({
    provider: { oldValue: 'openai', newValue: 'gemini' },
    settingsMutationV1: { newValue: ownWrite.settingsMutationV1 },
  }, 'sync');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.storageData.local.settingsRevisionV1, 2);
});

test('an external Sync update arriving after the local commit leg is never rolled back', async () => {
  let loaded;
  loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude' },
    storageSet(area, data, commit) {
      if (area === 'local' && data.settingsRevisionV1 === 1 && data.claudeKey === 'attempted-key') {
        commit();
        loaded.storageData.sync.provider = 'openai';
        loaded.triggerStorageChange({
          provider: { oldValue: 'claude', newValue: 'openai' },
        }, 'sync');
        return true;
      }
      return false;
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'attempted-key' },
      syncSet: { provider: 'gemini' },
    },
  }, sender);

  assert.equal(result.response.ok, false);
  assert.equal(result.response.conflict, true);
  assert.equal(loaded.storageData.local.claudeKey, 'original-key');
  assert.equal(loaded.storageData.sync.provider, 'openai', 'remote update must remain authoritative');
});

test('an external Sync update after the sync set leg survives a later sync remove rollback', async () => {
  let loaded;
  let injectedFailure = false;
  loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude' },
    storageRemove(area, keys, commit) {
      // Ignore the startup secret-migration sweep and fail only this
      // transaction's later, single-key sync remove leg.
      if (!injectedFailure && area === 'sync' && keys.length === 1 && keys[0] === 'claudeKey') {
        injectedFailure = true;
        loaded.storageData.sync.provider = 'openai';
        loaded.triggerStorageChange({
          provider: { oldValue: 'gemini', newValue: 'openai' },
        }, 'sync');
        loaded.context.chrome.runtime.lastError = { message: 'simulated sync remove failure' };
        commit();
        loaded.context.chrome.runtime.lastError = null;
        return true;
      }
      return false;
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'attempted-key' },
      syncSet: { provider: 'gemini' },
      syncRemove: ['claudeKey'],
    },
  }, sender);

  assert.equal(result.response.ok, false);
  assert.equal(result.response.conflict, true);
  assert.equal(loaded.storageData.local.claudeKey, 'original-key');
  assert.equal(loaded.storageData.sync.provider, 'openai', 'newer remote update must remain authoritative');
});

test('a whole external Sync transaction preserves same-value fields omitted from onChanged during rollback', async () => {
  let loaded;
  let injectedFailure = false;
  loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude', enableXhs: true },
    storageRemove(area, keys, commit) {
      if (!injectedFailure && area === 'sync' && keys.length === 1 && keys[0] === 'claudeKey') {
        injectedFailure = true;
        // The remote transaction also writes provider=gemini, but that value
        // already equals this transaction's local post-state. Chrome therefore
        // needs to report only the sibling that visibly changed.
        loaded.storageData.sync.enableXhs = false;
        loaded.triggerStorageChange({
          enableXhs: { oldValue: true, newValue: false },
        }, 'sync');
        loaded.context.chrome.runtime.lastError = { message: 'simulated sync remove failure' };
        commit();
        loaded.context.chrome.runtime.lastError = null;
        return true;
      }
      return false;
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'attempted-key' },
      syncSet: { provider: 'gemini', enableXhs: true },
      syncRemove: ['claudeKey'],
    },
  }, sender);

  assert.equal(result.response.ok, false);
  assert.equal(result.response.conflict, true);
  assert.equal(loaded.storageData.local.claudeKey, 'original-key');
  assert.equal(loaded.storageData.sync.enableXhs, false);
  assert.equal(loaded.storageData.sync.provider, 'gemini', 'same-value field in the newer remote transaction must remain authoritative');
});

test('an external Sync update landing inside a rollback is replayed after the stale write', async () => {
  let loaded;
  let failedRemove = false;
  let injectedDuringRollback = false;
  loaded = loadBackground({
    localData: { settingsRevisionV1: 0, claudeKey: 'original-key' },
    syncData: { provider: 'claude' },
    storageSet(area, data, commit) {
      if (!injectedDuringRollback && area === 'sync' && data.provider === 'claude' && data.settingsMutationV1) {
        injectedDuringRollback = true;
        loaded.storageData.sync.provider = 'openai';
        loaded.triggerStorageChange({
          provider: { oldValue: 'gemini', newValue: 'openai' },
        }, 'sync');
        // The stale rollback is deliberately the last physical writer. The
        // transaction must compensate from the newer external generation.
        commit();
        return true;
      }
      return false;
    },
    storageRemove(area, keys, commit) {
      if (!failedRemove && area === 'sync' && keys.length === 1 && keys[0] === 'claudeKey') {
        failedRemove = true;
        loaded.context.chrome.runtime.lastError = { message: 'simulated sync remove failure' };
        commit();
        loaded.context.chrome.runtime.lastError = null;
        return true;
      }
      return false;
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { claudeKey: 'attempted-key' },
      syncSet: { provider: 'gemini' },
      syncRemove: ['claudeKey'],
    },
  }, sender);

  assert.equal(result.response.ok, false);
  assert.equal(result.response.conflict, true);
  assert.equal(loaded.storageData.local.claudeKey, 'original-key');
  assert.equal(loaded.storageData.sync.provider, 'openai');
});

test('a failed gateway transaction cannot route a rolled-back old key to its new Base URL', async () => {
  let loaded;
  let injectedFailure = false;
  const migrated = { completed: true, removed: false, migratedAt: 1 };
  loaded = loadBackground({
    localData: {
      settingsRevisionV1: 0,
      sub2apiKey: 'old-secret',
      gatewayPermissionReauthorizationRequired: true,
      legacyBroadHostPermissionRemovedV1: migrated,
    },
    syncData: {
      provider: 'sub2api',
      sub2apiBaseUrl: 'https://old.example/api',
      sub2apiModel: 'gpt-5.6',
      mindmapAlignTop: true,
    },
    storageRemove(area, keys, commit) {
      if (!injectedFailure && area === 'local' &&
          keys.length === 1 && keys[0] === 'gatewayPermissionReauthorizationRequired') {
        injectedFailure = true;
        // An unrelated external Sync update makes the synchronized half
        // ambiguous while the later local leg fails.
        loaded.storageData.sync.mindmapAlignTop = false;
        loaded.triggerStorageChange({
          mindmapAlignTop: { oldValue: true, newValue: false },
        }, 'sync');
        loaded.context.chrome.runtime.lastError = { message: 'simulated local remove failure' };
        commit();
        loaded.context.chrome.runtime.lastError = null;
        return true;
      }
      return false;
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { sub2apiKey: 'new-secret' },
      syncSet: { sub2apiBaseUrl: 'https://new.example/v1' },
      localRemove: ['gatewayPermissionReauthorizationRequired'],
      gatewayPermissionChange: {
        provider: 'sub2api',
        oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*',
        attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);

  assert.equal(result.response.ok, false);
  assert.equal(loaded.storageData.local.sub2apiKey, 'old-secret');
  assert.equal(loaded.storageData.sync.sub2apiBaseUrl, 'https://new.example/v1');
  const providerConfig = await loaded.context.loadProviderConfig('sub2api');
  assert.match(providerConfig.error || '', /设置|网关|不一致|重新保存/);
  assert.notEqual(providerConfig.key, 'old-secret');
});

test('Sub2API credentials are bound to their exact gateway origin across external Sync changes', async () => {
  const loaded = loadBackground({
    localData: {
      sub2apiKey: 'bound-secret',
      sub2apiKeyOriginV1: 'https://old.example/*',
    },
    syncData: {
      provider: 'sub2api',
      sub2apiBaseUrl: 'https://old.example/api',
      sub2apiModel: 'gpt-5.6',
    },
  });
  await loaded.context.ensureSecretsMigrated();
  assert.equal((await loaded.context.loadProviderConfig('sub2api')).key, 'bound-secret');

  loaded.storageData.sync.sub2apiBaseUrl = 'https://new.example/v1';
  loaded.triggerStorageChange({
    sub2apiBaseUrl: { oldValue: 'https://old.example/api', newValue: 'https://new.example/v1' },
  }, 'sync');
  const changed = await loaded.context.loadProviderConfig('sub2api');
  assert.match(changed.error || '', /绑定|网关/);
  assert.notEqual(changed.key, 'bound-secret');
});

test('an explicitly authorized complete settings commit clears the consistency fuse and rebinds the gateway key', async () => {
  const secretKeys = ['claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'deepseekKey', 'kimiKey', 'sub2apiKey'];
  const localSet = Object.fromEntries(secretKeys.map((key) => [key, key === 'sub2apiKey' ? 'new-secret' : '']));
  const loaded = loadBackground({
    localData: { settingsRevisionV1: 0, settingsConsistencyErrorV1: true },
    syncData: { provider: 'sub2api', sub2apiBaseUrl: 'https://old.example/api' },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet,
      syncSet: { provider: 'sub2api', sub2apiBaseUrl: 'https://new.example/v1' },
      resolveConsistencyError: true,
      gatewayPermissionChange: {
        provider: 'sub2api',
        oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*',
        attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);

  assert.deepEqual(plain(result.response), { ok: true, revision: 1 });
  assert.equal(loaded.storageData.local.settingsConsistencyErrorV1, false);
  assert.equal(loaded.storageData.local.sub2apiKeyOriginV1, 'https://new.example/*');
  const config = await loaded.context.loadProviderConfig('sub2api');
  assert.equal(config.key, 'new-secret');
  assert.equal(config.baseUrl, 'https://new.example/v1');
});

test('ordinary autosave cannot clear the consistency fuse or rebind a Sub2API key', async () => {
  const secretKeys = ['claudeKey', 'openaiKey', 'geminiKey', 'minimaxKey', 'deepseekKey', 'kimiKey', 'sub2apiKey'];
  const localSet = Object.fromEntries(secretKeys.map((key) => [key, key === 'sub2apiKey' ? 'bound-secret' : '']));
  const loaded = loadBackground({
    localData: {
      settingsRevisionV1: 0,
      settingsConsistencyErrorV1: true,
      sub2apiKey: 'bound-secret',
      sub2apiKeyOriginV1: 'https://old.example/*',
    },
    // Simulate a remote Sync change that left the local key bound to the old
    // origin. Toggling an unrelated checkbox makes options save its complete
    // form snapshot, but is not an explicit gateway authorization/recovery.
    syncData: {
      provider: 'claude',
      sub2apiBaseUrl: 'https://new.example/v1',
      enableXhs: true,
    },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet,
      syncSet: {
        provider: 'claude',
        sub2apiBaseUrl: 'https://new.example/v1',
        enableXhs: false,
      },
    },
  }, sender);

  assert.deepEqual(plain(result.response), { ok: true, revision: 1 });
  assert.deepEqual({
    consistencyError: loaded.storageData.local.settingsConsistencyErrorV1,
    boundOrigin: loaded.storageData.local.sub2apiKeyOriginV1,
  }, {
    consistencyError: true,
    boundOrigin: 'https://old.example/*',
  });
  const config = await loaded.context.loadProviderConfig('sub2api');
  assert.match(config.error || '', /冲突|绑定|停止发送/);
  assert.notEqual(config.key, 'bound-secret');
});

test('partial local and ChatGPT mutations cannot clear the settings consistency fuse', async () => {
  const loaded = loadBackground({
    localData: { settingsRevisionV1: 0, settingsConsistencyErrorV1: true, claudeKey: 'secret' },
    syncData: { provider: 'claude', claudeModel: 'claude-opus-5' },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const cache = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { fetchedModels_claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }] },
    },
  }, sender);
  assert.deepEqual(plain(cache.response), { ok: true, revision: 1 });
  assert.equal(loaded.storageData.local.settingsConsistencyErrorV1, true);

  const auth = await dispatchMessage(loaded, {
    type: 'CHATGPT_AUTH_SET',
    expectedRevision: 1,
    auth: { access_token: 'access', refresh_token: 'refresh' },
  }, sender);
  assert.deepEqual(plain(auth.response), { ok: true, revision: 2 });
  assert.equal(loaded.storageData.local.settingsConsistencyErrorV1, true);
  assert.match((await loaded.context.loadProviderConfig('claude')).error || '', /冲突|停止发送/);
});

test('provider config reads wait for a settings transaction and never observe a new key with an old gateway', async () => {
  let releaseSyncSet;
  const migrated = { completed: true, removed: false, migratedAt: 1 };
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: migrated,
      settingsRevisionV1: 0,
      sub2apiKey: 'old-key',
    },
    syncData: { sub2apiBaseUrl: 'https://old.example/api', sub2apiModel: 'gpt-5.6' },
    storageSet(area, data, commit) {
      if (area === 'sync' && data.sub2apiBaseUrl === 'https://new.example/v1') {
        releaseSyncSet = commit;
        return true;
      }
      return false;
    },
    permissionRemove(_query, callback) { callback(true); },
  });
  await loaded.context.ensureSecretsMigrated();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const commit = dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { sub2apiKey: 'new-key' },
      syncSet: { sub2apiBaseUrl: 'https://new.example/v1' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*', attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);
  for (let i = 0; i < 10 && !releaseSyncSet; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseSyncSet, 'function');

  let readSettled = false;
  const config = loaded.context.loadProviderConfig('sub2api').then((value) => {
    readSettled = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readSettled, false);
  releaseSyncSet();

  assert.deepEqual(plain((await commit).response), { ok: true, revision: 1 });
  const value = await config;
  assert.equal(value.key, 'new-key');
  assert.equal(value.baseUrl, 'https://new.example/v1');
});

test('ChatGPT authorization SET and CLEAR share the persistent settings revision CAS', async () => {
  const loaded = loadBackground({ localData: { settingsRevisionV1: 0 } });
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const auth = { access_token: 'access-new', refresh_token: 'refresh-new', account_id: 'acct' };
  const set = await dispatchMessage(loaded, {
    type: 'CHATGPT_AUTH_SET', expectedRevision: 0, auth,
  }, sender);
  assert.deepEqual(plain(set.response), { ok: true, revision: 1 });

  const staleClear = await dispatchMessage(loaded, {
    type: 'CHATGPT_AUTH_CLEAR', expectedRevision: 0,
  }, sender);
  assert.equal(staleClear.response.ok, false);
  assert.equal(staleClear.response.conflict, true);
  assert.equal(staleClear.response.currentRevision, 1);
  assert.deepEqual(plain(loaded.storageData.local.chatgptAuth), auth);

  const currentClear = await dispatchMessage(loaded, {
    type: 'CHATGPT_AUTH_CLEAR', expectedRevision: 1,
  }, sender);
  assert.deepEqual(plain(currentClear.response), { ok: true, revision: 2 });
  assert.equal(loaded.storageData.local.chatgptAuth, null);
  assert.equal(loaded.storageData.local.settingsRevisionV1, 2);
});

test('settings transactions own gateway permission cleanup after the options page closes', async () => {
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const migrated = { completed: true, removed: false, migratedAt: 1 };
  const success = loadBackground({
    localData: { legacyBroadHostPermissionRemovedV1: migrated },
    syncData: { sub2apiBaseUrl: 'https://old.example/api' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const committed = await dispatchMessage(success, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: 'https://new.example/v1' },
      localRemove: ['gatewayPermissionReauthorizationRequired'],
      gatewayPermissionChange: {
        provider: 'sub2api',
        oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*',
        attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);
  assert.deepEqual(plain(committed.response), { ok: true, revision: 1 });
  assert.deepEqual(plain(success.permissionRemovals), [{ origins: ['https://old.example/*'] }]);
  assert.equal(success.storageData.sync.sub2apiBaseUrl, 'https://new.example/v1');

  const failed = loadBackground({
    failSyncSetOnce: true,
    localData: { legacyBroadHostPermissionRemovedV1: migrated },
    syncData: { sub2apiBaseUrl: 'https://old.example/api' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const rejected = await dispatchMessage(failed, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: 'https://attempted.example/v1' },
      gatewayPermissionChange: {
        provider: 'sub2api',
        oldOrigin: 'https://old.example/*',
        newOrigin: 'https://attempted.example/*',
        attemptedOrigin: 'https://attempted.example/*',
      },
    },
  }, sender);
  assert.equal(rejected.response.ok, false);
  assert.match(rejected.response.error, /已恢复原设置/);
  assert.equal(failed.storageData.sync.sub2apiBaseUrl, 'https://old.example/api');
  assert.deepEqual(plain(failed.permissionRemovals), [{ origins: ['https://attempted.example/*'] }]);

  const clear = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: migrated,
      gatewayPermissionReauthorizationRequired: true,
    },
    syncData: { sub2apiBaseUrl: 'https://old.example/api' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const cleared = await dispatchMessage(clear, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: '' },
      localRemove: ['gatewayPermissionReauthorizationRequired'],
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://old.example/*',
        newOrigin: '', attemptedOrigin: '',
      },
    },
  }, sender);
  assert.deepEqual(plain(cleared.response), { ok: true, revision: 1 });
  assert.equal(clear.storageData.sync.sub2apiBaseUrl, '');
  assert.equal(clear.storageData.local.gatewayPermissionReauthorizationRequired, undefined);
  assert.deepEqual(plain(clear.permissionRemovals), [{ origins: ['https://old.example/*'] }]);

  const imported = loadBackground({
    localData: { legacyBroadHostPermissionRemovedV1: migrated },
    syncData: { sub2apiBaseUrl: 'https://same.example/old-path' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const reauthorized = await dispatchMessage(imported, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { gatewayPermissionReauthorizationRequired: true },
      syncSet: { sub2apiBaseUrl: 'https://same.example/new-path' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://same.example/*',
        newOrigin: 'https://same.example/*', attemptedOrigin: '', forceReauthorize: true,
      },
    },
  }, sender);
  assert.deepEqual(plain(reauthorized.response), { ok: true, revision: 1 });
  assert.deepEqual(plain(imported.permissionRemovals), [{ origins: ['https://same.example/*'] }]);
  assert.equal(imported.storageData.local.gatewayPermissionReauthorizationRequired, true);

  const requiredOld = loadBackground({
    localData: { legacyBroadHostPermissionRemovedV1: migrated },
    syncData: { sub2apiBaseUrl: 'https://api.openai.com/custom' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const requiredCommitted = await dispatchMessage(requiredOld, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: 'https://new.example/api' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://api.openai.com/*',
        newOrigin: 'https://new.example/*', attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);
  assert.deepEqual(plain(requiredCommitted.response), { ok: true, revision: 1 });
  assert.equal(requiredOld.permissionRemovals.length, 0);

  const mismatched = await dispatchMessage(success, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 1,
      syncSet: { sub2apiBaseUrl: 'https://saved.example/api' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: '',
        newOrigin: 'https://different.example/*', attemptedOrigin: 'https://different.example/*',
      },
    },
  }, sender);
  assert.equal(mismatched.response.ok, false);
  assert.match(mismatched.response.error, /不一致/);
});

test('stale gateway cleanup preserves the origin another options page made authoritative', async () => {
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const migrated = { completed: true, removed: false, migratedAt: 1 };
  const loaded = loadBackground({
    localData: { legacyBroadHostPermissionRemovedV1: migrated, settingsRevisionV1: 0 },
    syncData: { sub2apiBaseUrl: 'https://old.example/api' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const first = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: 'https://new.example/v1' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*', attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);
  assert.deepEqual(plain(first.response), { ok: true, revision: 1 });

  const stale = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      syncSet: { sub2apiBaseUrl: 'https://new.example/other' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*', attemptedOrigin: 'https://new.example/*',
      },
    },
  }, sender);
  assert.equal(stale.response.conflict, true);
  assert.equal(loaded.storageData.sync.sub2apiBaseUrl, 'https://new.example/v1');
  assert.ok(loaded.permissionRemovals.some(query => query.origins.includes('https://old.example/*')));
  assert.equal(loaded.permissionRemovals.some(query => query.origins.includes('https://new.example/*')), false);
});

test('gateway commit fails closed after a prompt outlives the service worker and loses its exact grant', async () => {
  const attemptId = 'gateway-attempt-1234567890';
  const migrated = { completed: true, removed: false, migratedAt: 1 };
  const loaded = loadBackground({
    permissionAllowed: false,
    localData: {
      legacyBroadHostPermissionRemovedV1: migrated,
      settingsRevisionV1: 0,
      sub2apiKey: 'old-key',
    },
    syncData: { sub2apiBaseUrl: 'https://old.example/api' },
    permissionRemove(_query, callback) { callback(true); },
  });
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  // Simulate a restarted SW: the commit carries the old attempt ID, but the
  // in-memory attempt map is empty and the exact permission is no longer held.
  const result = await dispatchMessage(loaded, {
    type: 'COMMIT_SETTINGS_TRANSACTION',
    transaction: {
      expectedRevision: 0,
      localSet: { sub2apiKey: 'must-not-store' },
      syncSet: { sub2apiBaseUrl: 'https://new.example/v1' },
      gatewayPermissionChange: {
        provider: 'sub2api', oldOrigin: 'https://old.example/*',
        newOrigin: 'https://new.example/*', attemptedOrigin: 'https://new.example/*',
        permissionAttemptId: attemptId,
      },
    },
  }, sender);
  assert.equal(result.response.ok, false);
  assert.match(result.response.error, /精确域名授权已失效/);
  assert.equal(loaded.storageData.local.sub2apiKey, 'old-key');
  assert.equal(loaded.storageData.local.settingsRevisionV1, 0);
  assert.equal(loaded.storageData.sync.sub2apiBaseUrl, 'https://old.example/api');
});

test('startup and options loading reconcile orphan gateway grants but retain active and required origins', async () => {
  const active = 'https://active.example/*';
  const orphan = 'https://orphan.example/*';
  const required = 'https://api.openai.com/*';
  const contentScriptOrigins = [
    'http://*/*', 'https://*/*',
    'https://www.xiaohongshu.com/*', 'https://xiaohongshu.com/*',
  ];
  const loaded = loadBackground({
    grantedOrigins: [active, orphan, required, ...contentScriptOrigins],
    permissionContains(query, callback) {
      const origin = query?.origins?.[0];
      callback(!contentScriptOrigins.includes(origin));
    },
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 0,
    },
    syncData: { sub2apiBaseUrl: 'https://active.example/api' },
  });
  for (let i = 0; i < 10 && !loaded.permissionRemovals.length; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(plain(loaded.permissionRemovals), [{ origins: [orphan] }]);

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
    tab: { id: 11, url: 'chrome-extension://test-extension/options.html' },
  });
  assert.equal(snapshot.response.ok, true);
  assert.equal(loaded.permissionRemovals.some(query => query.origins.includes(active)), false);
  assert.equal(loaded.permissionRemovals.some(query => query.origins.includes(required)), false);
  assert.equal(loaded.permissionRemovals.some(query =>
    query.origins.some(origin => contentScriptOrigins.includes(origin))), false);
  assert.equal(loaded.storageData.local.gatewayPermissionReauthorizationRequired, undefined);
});

test('options snapshot survives deprecated-setting cleanup failure and reports a warning', async () => {
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 7,
    },
    syncData: { provider: 'openai', notionPage: 'legacy-page' },
    storageRemove(area, keys) {
      if (area === 'sync' && keys.includes('notionPage')) {
        throw new Error('simulated deprecated cleanup failure');
      }
      return false;
    },
  });

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, true);
  assert.equal(snapshot.response.revision, 7);
  assert.equal(snapshot.response.sync.provider, 'openai');
  assert.ok(Array.isArray(snapshot.response.warnings));
  assert.match(snapshot.response.warnings.join(' '), /simulated deprecated cleanup failure/);
});

test('options snapshot fails closed when a reintroduced deprecated secret cannot be scrubbed', async () => {
  let failDeprecatedSecretRemoval = false;
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 9,
    },
    syncData: { provider: 'openai' },
    storageRemove(area, keys) {
      if (failDeprecatedSecretRemoval && area === 'sync' && keys.includes('githubKey')) {
        throw new Error('simulated deprecated secret scrub failure');
      }
      return false;
    },
  });

  // Let the startup migration establish its cached-success state, then model
  // an older synced device writing a retired credential back afterward.
  assert.equal((await loaded.context.ensureSecretsMigrated()).ok, true);
  assert.equal((await loaded.context.cleanupDeprecatedSyncSettings()).ok, true);
  failDeprecatedSecretRemoval = true;
  loaded.storageData.sync.githubKey = 'reintroduced-legacy-secret';
  loaded.triggerStorageChange({
    githubKey: { oldValue: undefined, newValue: 'reintroduced-legacy-secret' },
  }, 'sync');

  const blocked = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });
  assert.equal(blocked.response.ok, false);
  assert.match(blocked.response.error, /simulated deprecated secret scrub failure/);
  assert.equal(loaded.storageData.sync.githubKey, 'reintroduced-legacy-secret');

  // A later healthy retry must scrub the secret before returning a snapshot.
  failDeprecatedSecretRemoval = false;
  const recovered = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });
  assert.equal(recovered.response.ok, true);
  assert.equal(recovered.response.revision, 9);
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.storageData.sync, 'githubKey'), false);
});

test('a secret reintroduced while a snapshot scrub is settling forces another scrub before return', async () => {
  let loadedRef;
  let injectDuringSnapshot = false;
  let secretScrubCount = 0;
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 5,
    },
    syncData: { provider: 'openai' },
    storageRemove(area, keys, commit) {
      if (area !== 'sync' || !keys.includes('openaiKey')) return false;
      secretScrubCount++;
      commit();
      if (injectDuringSnapshot) {
        injectDuringSnapshot = false;
        loadedRef.storageData.sync.openaiKey = 'race-reintroduced-secret';
        loadedRef.triggerStorageChange({
          openaiKey: { oldValue: undefined, newValue: 'race-reintroduced-secret' },
        }, 'sync');
      }
      return true;
    },
  });
  loadedRef = loaded;

  assert.equal((await loaded.context.ensureSecretsMigrated()).ok, true);
  const scrubsBeforeSnapshot = secretScrubCount;
  injectDuringSnapshot = true;
  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, true);
  assert.ok(secretScrubCount >= scrubsBeforeSnapshot + 2,
    'the in-flight reintroduction should schedule a second stable scrub pass');
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.storageData.sync, 'openaiKey'), false);
});

test('options snapshot survives gateway-permission reconciliation failure and reports a warning', async () => {
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 3,
    },
    syncData: { provider: 'gemini' },
    permissionGetAll() {
      throw new Error('simulated gateway reconcile failure');
    },
  });

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, true);
  assert.equal(snapshot.response.revision, 3);
  assert.equal(snapshot.response.sync.provider, 'gemini');
  assert.ok(Array.isArray(snapshot.response.warnings));
  assert.match(snapshot.response.warnings.join(' '), /simulated gateway reconcile failure/);
});

test('options snapshot still fails closed when secret migration cannot establish trusted local storage', async () => {
  const loaded = loadBackground({
    accessLevelError: new Error('simulated trusted storage failure'),
    syncData: { provider: 'claude' },
  });

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, false);
  assert.match(snapshot.response.error, /simulated trusted storage failure/);
});

test('options snapshot still fails closed when its authoritative storage read fails', async () => {
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 0,
    },
    syncData: { provider: 'claude' },
    storageGet() {
      throw new Error('simulated authoritative snapshot failure');
    },
  });

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, false);
  assert.match(snapshot.response.error, /simulated authoritative snapshot failure/);
});

test('options snapshot still fails closed when an external-sync revision cannot be persisted', async () => {
  const loaded = loadBackground({
    localData: {
      legacyBroadHostPermissionRemovedV1: { completed: true, removed: false, migratedAt: 1 },
      settingsRevisionV1: 0,
    },
    syncData: { provider: 'claude' },
    storageSet(area, data) {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(data, 'settingsRevisionV1')) {
        throw new Error('simulated revision persistence failure');
      }
      return false;
    },
  });
  loaded.storageData.sync.provider = 'openai';
  loaded.triggerStorageChange({
    provider: { oldValue: 'claude', newValue: 'openai' },
  }, 'sync');

  const snapshot = await dispatchMessage(loaded, { type: 'LOAD_SETTINGS_SNAPSHOT' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });

  assert.equal(snapshot.response.ok, false);
  assert.match(snapshot.response.error, /simulated revision persistence failure/);
});

test('malformed provider and ChatGPT values in storage are rejected before API calls', async () => {
  const malformedKey = loadBackground({ localData: { claudeKey: { secret: true } } });
  assert.match((await malformedKey.context.loadProviderConfig('claude')).error, /格式无效/);
  assert.equal(malformedKey.context.sanitizeModel('claude', { model: 'claude-sonnet-5' }), '');

  const malformedModel = loadBackground({
    localData: { claudeKey: 'key' }, syncData: { claudeModel: { id: 'bad' } },
  });
  assert.match((await malformedModel.context.loadProviderConfig('claude')).error, /格式无效/);

  const malformedAuth = loadBackground({
    localData: { chatgptAuth: { access_token: 'token', refresh_token: { bad: true } } },
  });
  assert.match((await malformedAuth.context.ensureChatgptAccessToken()).error, /refresh_token/);
  assert.equal(malformedAuth.fetchCalls.length, 0);
});

test('unused ChatGPT id_token is stripped from new and previously stored authorization', async () => {
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' };
  const migrated = loadBackground({
    localData: {
      chatgptAuth: {
        access_token: 'access', refresh_token: 'refresh', id_token: 'identity-jwt',
        account_id: 'acct', unexpected: 'discard-me',
      },
    },
  });
  const result = await migrated.context.migrateStoredChatgptAuthIdToken();
  assert.equal(result.error, undefined);
  assert.deepEqual(plain(migrated.storageData.local.chatgptAuth), {
    access_token: 'access', refresh_token: 'refresh', account_id: 'acct',
  });

  const fresh = loadBackground();
  const saved = await dispatchMessage(fresh, {
    type: 'CHATGPT_AUTH_SET',
    expectedRevision: 0,
    auth: { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'must-not-store', account_id: 'new-acct' },
  }, sender);
  assert.deepEqual(plain(saved.response), { ok: true, revision: 1 });
  assert.deepEqual(plain(fresh.storageData.local.chatgptAuth), {
    access_token: 'new-access', refresh_token: 'new-refresh', account_id: 'new-acct',
  });
});

test('upgrade migration revokes a retained broad HTTPS grant once without reinjecting tabs', async () => {
  let executeCount = 0;
  const loaded = loadBackground({
    broadPermissionPresent: true,
    broadPermissionRemoved: true,
    executeScript() { executeCount++; return Promise.resolve([]); },
  });
  const result = await loaded.context.migrateLegacyBroadHostPermission();
  assert.equal(result.removed, true);
  assert.deepEqual(plain(loaded.permissionRemovals), [{ origins: ['https://*/*'] }]);
  assert.equal(loaded.storageData.local.gatewayPermissionReauthorizationRequired, true);
  assert.equal(loaded.storageData.local.legacyBroadHostPermissionRemovedV1.completed, true);

  loaded.triggerInstalled();
  await loaded.context.migrateLegacyBroadHostPermission();
  assert.equal(loaded.permissionRemovals.length, 1);
  assert.equal(executeCount, 0);
});

test('deprecated synchronized integrations and stale gateway grants are cleaned without opening options', async () => {
  const loaded = loadBackground({
    localData: { legacyBroadHostPermissionRemovedV1: { completed: true } },
    syncData: {
      sub2apiBaseUrl: 'https://active.example/api',
      sub2api2Key: 'old-secret-2', sub2api2BaseUrl: 'https://active.example/old-slot',
      sub2api3Key: 'old-secret-3', sub2api3BaseUrl: 'https://stale.example/api',
      githubKey: 'old-github-token', notionKey: 'old-notion-token', notionPage: 'old-page',
    },
    permissionRemove(_query, callback) { callback(true); },
  });
  const cleanup = await loaded.context.cleanupDeprecatedSyncSettings();
  assert.equal(cleanup.ok, true);
  assert.deepEqual(plain(loaded.permissionRemovals), [{ origins: ['https://stale.example/*'] }]);
  assert.equal(loaded.storageData.sync.sub2apiBaseUrl, 'https://active.example/api');
  for (const field of ['sub2api2Key', 'sub2api2BaseUrl', 'sub2api3Key', 'sub2api3BaseUrl', 'githubKey', 'notionKey', 'notionPage']) {
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.storageData.sync, field), false);
  }

  loaded.storageData.sync.sub2api3BaseUrl = 'https://reintroduced.example/api';
  loaded.triggerStorageChange({ sub2api3BaseUrl: { newValue: 'https://reintroduced.example/api' } }, 'sync');
  await new Promise(resolve => setImmediate(resolve));
  await loaded.context.cleanupDeprecatedSyncSettings();
  assert.deepEqual(plain(loaded.permissionRemovals.at(-1)), { origins: ['https://reintroduced.example/*'] });
  assert.equal(Object.prototype.hasOwnProperty.call(loaded.storageData.sync, 'sub2api3BaseUrl'), false);
});

test('Sub2API waits for broad-host cleanup and fails closed until exact reauthorization', async () => {
  let releaseRemoval;
  const loaded = loadBackground({
    permissionAllowed: true,
    broadPermissionPresent: true,
    permissionRemove(_query, callback) { releaseRemoval = () => callback(true); },
    fetch: async () => { throw new Error('must not fetch before reauthorization'); },
  });
  const work = loaded.context.callProvider('sub2api', {
    key: 'secret', model: 'claude-sonnet-5', baseUrl: 'https://gateway.example',
    systemPrompt: '', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10,
    tabId: 1, PREFIX: 'SUMMARY', requestId: 'migration-race',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.fetchCalls.length, 0);
  releaseRemoval();
  await work;
  assert.equal(loaded.fetchCalls.length, 0);
  assert.equal(loaded.storageData.local.gatewayPermissionReauthorizationRequired, true);
  assert.match(loaded.sentMessages.at(-1).message.error, /重新点击/);
});

test('JWT decoding restores omitted base64url padding', () => {
  const strictAtob = (value) => {
    if (value.length % 4 !== 0) throw new Error('missing padding');
    return atob(value);
  };
  const { context } = loadBackground({ atob: strictAtob });
  const token = jwtWithClaims({ exp: 123, sub: 'padding-case' });
  assert.equal(token.split('.')[1].length % 4 !== 0, true);
  assert.deepEqual(plain(context.decodeJwtClaims(token)), { exp: 123, sub: 'padding-case' });
});

test('ChatGPT refresh is single-flight, preserves cancellation, and stores only the newest rotation', async () => {
  let releaseToken;
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-0', account_id: 'acct' } },
    networkStart(job, emit) {
      assert.equal(job.route.kind, 'internal');
      releaseToken = value => emit({ kind: 'DONE', json: value });
    },
  });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = loaded.context.ensureChatgptAccessToken(firstController.signal);
  const second = loaded.context.ensureChatgptAccessToken(secondController.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.networkPortMessages.filter(item => item.type === 'NETWORK_START').length, 1);

  firstController.abort();
  releaseToken({ access_token: 'access-1', refresh_token: 'refresh-1' });
  await assert.rejects(first, error => error?.name === 'AbortError');
  const result = await second;
  assert.equal(result.accessToken, 'access-1');
  assert.equal(loaded.storageData.local.chatgptAuth.refresh_token, 'refresh-1');
  assert.equal(loaded.storageWrites.local.filter(write => write.chatgptAuth).length, 1);
});

test('clearing ChatGPT authorization during refresh cannot resurrect the old credentials', async () => {
  let releaseToken;
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-0' } },
    networkStart(_job, emit) { releaseToken = value => emit({ kind: 'DONE', json: value }); },
  });
  const work = loaded.context.ensureChatgptAccessToken(new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  delete loaded.storageData.local.chatgptAuth;
  releaseToken({ access_token: 'access-1', refresh_token: 'refresh-1' });

  const result = await work;
  assert.match(result.error, /授权已被清除/);
  assert.equal(loaded.storageData.local.chatgptAuth, undefined);
  assert.equal(loaded.storageWrites.local.some(write => write.chatgptAuth), false);
});

test('background clear wins even after refresh has begun its serialized token write', async () => {
  let releaseSet;
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-0' } },
    networkStart(_job, emit) { emit({ kind: 'DONE', json: { access_token: 'access-1', refresh_token: 'refresh-1' } }); },
    chatgptStorageSet(data, commit) {
      if (data.chatgptAuth === null) commit();
      else releaseSet = commit;
    },
  });
  const refresh = loaded.context.ensureChatgptAccessToken();
  for (let i = 0; i < 10 && !releaseSet; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseSet, 'function');

  const clear = dispatchMessage(loaded, { type: 'CHATGPT_AUTH_CLEAR', expectedRevision: 0 }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
  });
  await new Promise(resolve => setImmediate(resolve));
  releaseSet();

  assert.deepEqual(plain((await clear).response), { ok: true, revision: 1 });
  assert.match((await refresh).error, /授权已变更|取消/);
  assert.equal(loaded.storageData.local.chatgptAuth, null);
});

test('ChatGPT refresh waits for a different refresh token then refreshes the replacement credentials', async () => {
  const expiredOld = jwtWithClaims({ exp: 1, sub: 'old' });
  const expiredNew = jwtWithClaims({ exp: 1, sub: 'new' });
  const releases = [];
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: expiredOld, refresh_token: 'refresh-old' } },
    networkStart(_job, emit) { releases.push(value => emit({ kind: 'DONE', json: value })); },
  });

  const first = loaded.context.ensureChatgptAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  loaded.storageData.local.chatgptAuth = { access_token: expiredNew, refresh_token: 'refresh-new' };
  const second = loaded.context.ensureChatgptAccessToken();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.networkPortMessages.filter(item => item.type === 'NETWORK_START').length, 1);

  releases[0]({ access_token: 'ignored-old-result', refresh_token: 'ignored-old-rotation' });
  await new Promise(resolve => setImmediate(resolve));
  const starts = loaded.networkPortMessages.filter(item => item.type === 'NETWORK_START');
  assert.equal(starts.length, 2);
  assert.equal(JSON.parse(starts[1].job.request.body).refresh_token, 'refresh-new');
  releases[1]({ access_token: 'access-new', refresh_token: 'refresh-new-rotated' });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.accessToken, 'access-new');
  assert.equal(secondResult.accessToken, 'access-new');
  assert.equal(loaded.storageData.local.chatgptAuth.refresh_token, 'refresh-new-rotated');
  assert.equal(loaded.storageWrites.local.filter(write => write.chatgptAuth).length, 1);
});

test('ChatGPT refresh has an independent timeout and releases the single-flight slot', async () => {
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-timeout' } },
    networkStart() {},
    setTimeout(callback, ms) {
      if (ms === 45000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });
  const result = await loaded.context.ensureChatgptAccessToken();
  assert.match(result.error, /刷新超时/);
  assert.equal(vm.runInContext('chatgptRefreshFlight', loaded.context), null);
  assert.equal(loaded.fetchCalls.length, 0, 'OAuth refresh must never fall back to service-worker fetch');
});

test('ChatGPT provider refresh carries a bounded document recovery route into the offscreen job', async () => {
  const starts = [];
  const loaded = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-route', account_id: 'acct' } },
    networkStart(job, emit) {
      starts.push(job);
      if (job.route.kind === 'internal') {
        emit({ kind: 'DONE', json: { access_token: 'new-access', refresh_token: 'new-refresh' } });
      } else {
        emit({ kind: 'DONE', text: 'test output' });
      }
    },
  });
  await loaded.context.callProvider('chatgpt', {
    key: 'chatgpt-oauth', model: 'gpt-5.6-sol', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 10,
    tabId: 12, PREFIX: 'SUMMARY', requestId: 'oauth-route-test',
    deliveryOptions: { frameId: 0, documentId: 'oauth-document-1234' },
  });
  assert.deepEqual(plain(starts[0].route.recoveryRoutes), [{
    tabId: 12, frameId: 0, documentId: 'oauth-document-1234',
    requestId: 'oauth-route-test', prefix: 'SUMMARY', kind: 'provider',
  }]);
  assert.equal(starts[1].route.kind, 'provider');
});

test('a shared slow ChatGPT refresh recovers every waiting document after a service-worker restart', async () => {
  let releaseToken;
  const original = loadBackground({
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-shared', account_id: 'acct' } },
    networkStart(job, emit) {
      if (job.route.kind === 'internal') releaseToken = value => emit({ kind: 'DONE', json: value });
    },
  });
  const firstRoute = {
    tabId: 21, frameId: 0, documentId: 'first-document-1234', requestId: 'shared-first',
    prefix: 'SUMMARY', kind: 'provider',
  };
  const secondRoute = {
    tabId: 22, frameId: 3, documentId: 'second-document-1234', requestId: 'shared-second',
    prefix: 'TRANSLATE', kind: 'provider',
  };
  const first = original.context.ensureChatgptAccessToken(undefined, firstRoute);
  const second = original.context.ensureChatgptAccessToken(undefined, secondRoute);
  for (let i = 0; i < 10; i++) {
    const hasBothRoutes = original.networkPortMessages.some(message =>
      message.type === 'NETWORK_ROUTE_UPDATE' && message.route.recoveryRoutes?.length === 2);
    if (typeof releaseToken === 'function' && hasBothRoutes) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  const start = original.networkPortMessages.find(message => message.type === 'NETWORK_START' && message.job.route.kind === 'internal');
  const updates = original.networkPortMessages.filter(message => message.type === 'NETWORK_ROUTE_UPDATE');
  const updatedRoute = updates.at(-1)?.route || start.job.route;
  assert.equal(updatedRoute.recoveryRoutes.length, 2);

  const restarted = loadBackground();
  restarted.context.handleNetworkHello({
    type: 'NETWORK_HELLO', version: 1,
    generation: 'dbcdef12-1234-1234-1234-123456789abc',
    jobs: [{ jobId: start.job.jobId, route: updatedRoute }],
  });
  restarted.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: start.job.jobId, route: updatedRoute,
    event: { kind: 'DONE', json: { access_token: 'completed-after-restart' } },
  });
  assert.deepEqual(plain(restarted.sentMessages), [
    {
      tabId: 21,
      message: { type: 'SUMMARY_ERROR', requestId: 'shared-first', error: '授权刷新期间后台已重启，请重试', reason: 'service_worker_restarted' },
      deliveryOptions: { frameId: 0, documentId: 'first-document-1234' },
    },
    {
      tabId: 22,
      message: { type: 'TRANSLATE_ERROR', requestId: 'shared-second', error: '授权刷新期间后台已重启，请重试', reason: 'service_worker_restarted' },
      deliveryOptions: { frameId: 3, documentId: 'second-document-1234' },
    },
  ]);

  releaseToken({ access_token: 'new-access', refresh_token: 'new-refresh' });
  await Promise.all([first, second]);
});

test('a dropped OAuth route update fails the new caller deterministically while the original route remains recoverable', async () => {
  let releaseToken;
  let internalStart;
  const original = loadBackground({
    dropNetworkRouteUpdate: true,
    localData: { chatgptAuth: { access_token: 'expired', refresh_token: 'refresh-dropped', account_id: 'acct' } },
    setTimeout(callback, ms) {
      if (ms === 4000) { queueMicrotask(callback); return 4000; }
      return setTimeout(callback, ms);
    },
    networkStart(job, emit) {
      if (job.route.kind === 'internal') {
        internalStart = job;
        releaseToken = value => emit({ kind: 'DONE', json: value });
      } else {
        emit({ kind: 'DONE', text: 'provider completed' });
      }
    },
  });
  const optionsFor = (tabId, documentId, requestId) => ({
    key: 'chatgpt-oauth', model: 'gpt-5.6-sol', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 10,
    tabId, PREFIX: 'SUMMARY', requestId,
    deliveryOptions: { frameId: 0, documentId },
  });
  const first = original.context.callProvider('chatgpt', optionsFor(41, 'first-dropped-1234', 'dropped-first'));
  for (let i = 0; i < 10 && !internalStart; i++) await new Promise(resolve => setImmediate(resolve));
  const second = original.context.callProvider('chatgpt', optionsFor(42, 'second-dropped-1234', 'dropped-second'));
  await second;
  const secondFailure = original.sentMessages.find(item =>
    item.tabId === 42 && item.message.type === 'SUMMARY_ERROR');
  assert.match(secondFailure.message.error, /无法确认.*恢复路由/);
  assert.equal(secondFailure.deliveryOptions.documentId, 'second-dropped-1234');

  const restarted = loadBackground();
  restarted.context.handleNetworkHello({
    type: 'NETWORK_HELLO', version: 1,
    generation: 'fbcdef12-1234-1234-1234-123456789abc',
    jobs: [{ jobId: internalStart.jobId, route: internalStart.route }],
  });
  restarted.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: internalStart.jobId, route: internalStart.route,
    event: { kind: 'DONE', json: { access_token: 'completed-after-restart' } },
  });
  const firstFailure = restarted.sentMessages.find(item => item.tabId === 41);
  assert.equal(firstFailure.message.type, 'SUMMARY_ERROR');
  assert.equal(firstFailure.deliveryOptions.documentId, 'first-dropped-1234');

  releaseToken({ access_token: 'new-access', refresh_token: 'new-refresh' });
  await first;
});

test('an ACK-lost internal terminal replay is ignored by the same service-worker generation', async () => {
  let release;
  let started;
  const loaded = loadBackground({
    networkStart(job, emit) {
      started = job;
      release = value => emit({ kind: 'DONE', json: value });
    },
  });
  const recoveryRoute = {
    tabId: 23, frameId: 0, documentId: 'replay-document-1234', requestId: 'replay-request',
    prefix: 'SUMMARY', kind: 'provider',
  };
  const resultPromise = loaded.context.runOffscreenJsonRequest({}, undefined, [recoveryRoute]);
  for (let i = 0; i < 10 && !started; i++) await new Promise(resolve => setImmediate(resolve));
  release({ access_token: 'new-access' });
  await resultPromise;
  assert.equal(loaded.sentMessages.length, 0);

  assert.equal(loaded.context.handleNetworkHello({
    type: 'NETWORK_HELLO', version: 1,
    generation: 'ebcdef12-1234-1234-1234-123456789abc',
    jobs: [{ jobId: started.jobId, route: started.route }],
  }), true);
  assert.equal(loaded.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: started.jobId, route: started.route,
    event: { kind: 'DONE', json: { access_token: 'duplicate' } },
  }), true);
  assert.equal(loaded.sentMessages.length, 0, 'terminal replay must not emit a false restart error');
});

test('callProvider blocks unapproved gateways before fetch and streams approved gateways', async () => {
  const denied = loadBackground({ permissionAllowed: false });
  await denied.context.callProvider('sub2api', {
    key: 'secret',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128,
    tabId: 9,
    PREFIX: 'SUMMARY',
    requestId: 'denied-request',
    baseUrl: 'https://gateway.example',
    model: 'claude-sonnet-5',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  assert.equal(denied.fetchCalls.length, 0);
  assert.match(denied.sentMessages[0].message.error, /尚未授权/);

  const approved = loadBackground({
    networkStart(_job, emit) {
      emit({ kind: 'CHUNK', text: 'ok' });
      emit({ kind: 'DONE', text: 'test output' });
    },
  });
  await approved.context.callProvider('sub2api', {
    key: 'secret',
    systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128,
    tabId: 9,
    PREFIX: 'SUMMARY',
    requestId: 'approved-request',
    baseUrl: 'https://gateway.example:8443/v1/messages',
    model: 'claude-sonnet-5',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  const start = approved.networkPortMessages.find(item => item.type === 'NETWORK_START');
  assert.equal(start.job.request.url, 'https://gateway.example:8443/v1/messages');
  assert.deepEqual(approved.sentMessages.map(item => item.message.type), [
    'SUMMARY_MODEL', 'SUMMARY_CHUNK', 'SUMMARY_DONE',
  ]);
});

test('provider requests reject redirects and prompt expansion treats transcript dollars literally', async () => {
  const loaded = loadBackground({
    localData: { claudeKey: 'secret' },
    syncData: { claudeModel: 'claude-sonnet-5' },
  });
  const transcript = '$& ' + '$' + String.fromCharCode(96) + ' literal';
  await loaded.context.handleSummarize({
    type: 'SUMMARIZE', provider: 'claude', requestId: 'literal-replacement',
    transcript, prompt: 'prefix:{transcript}:suffix',
  }, 1, 'SUMMARY', 0, { frameId: 0, documentId: 'document-12345678' });

  const request = loaded.networkPortMessages.find(item => item.type === 'NETWORK_START').job.request;
  assert.equal(request.method, 'POST');
  assert.equal(JSON.parse(request.body).messages[0].content, `prefix:${transcript}:suffix`);

  const redirectedGateway = loadBackground({
    networkStart(_job, emit) { emit({ kind: 'ERROR', code: 'network_error', message: '网络连接失败，请检查网络后重试' }); },
  });
  await redirectedGateway.context.callProvider('sub2api', {
    key: 'secret', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128, tabId: 9, PREFIX: 'SUMMARY', requestId: 'redirect-denied',
    baseUrl: 'https://gateway.example', model: 'claude-sonnet-5',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  assert.equal(redirectedGateway.networkPortMessages.filter(item => item.type === 'NETWORK_START').length, 1);
  assert.match(redirectedGateway.sentMessages.at(-1).message.error, /网络连接失败/);
});

test('Gemini provider and video transcription keep keys in offscreen request headers', async () => {
  const loaded = loadBackground({ localData: { geminiKey: 'video-secret' } });
  await loaded.context.callProvider('gemini', {
    key: 'gemini-secret', model: 'gemini-test', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 128,
    tabId: 1, PREFIX: 'SUMMARY', requestId: 'gemini-header',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  await loaded.context.handleTranscribeVideo({
    videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoDuration: 60,
    videoId: 'abcdefghijk', requestId: 'gemini-video-header',
  }, 1, 0, 'document-12345678');

  const starts = loaded.networkPortMessages.filter(item => item.type === 'NETWORK_START');
  assert.equal(starts.length, 2);
  for (const start of starts) {
    const request = start.job.request;
    assert.equal(new URL(request.url).searchParams.has('key'), false);
    assert.ok(request.headers['x-goog-api-key']);
    assert.equal(request.allowedOrigin, 'https://generativelanguage.googleapis.com');
    assert.equal(request.includeFullText, true);
  }
  assert.equal(vm.runInContext('MAX_TRANSCRIBE_OUTPUT_CHARS', loaded.context), 250000);
});

test('video transcription routes bounded chunks and one full terminal result to the initiating document', async () => {
  const full = 'x'.repeat(10000);
  const loaded = loadBackground({
    localData: { geminiKey: 'key' },
    networkStart(job, emit) {
      if (job.route.kind !== 'transcribe') { emit({ kind: 'DONE', text: 'test output' }); return; }
      emit({ kind: 'CHUNK', text: full.slice(0, 8192) });
      emit({ kind: 'CHUNK', text: full.slice(8192) });
      emit({ kind: 'DONE', text: full });
    },
  });
  await loaded.context.handleTranscribeVideo({
    videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoDuration: 90,
    videoId: 'abcdefghijk', requestId: 'tiny-deltas',
  }, 22, 0, 'document-12345678');
  await new Promise(resolve => setImmediate(resolve));

  const chunks = loaded.sentMessages.filter(item => item.message.type === 'TRANSCRIBE_CHUNK');
  assert.equal(chunks.map(item => item.message.text).join(''), full);
  assert.ok(chunks.every(item => item.deliveryOptions?.frameId === 0 &&
    item.deliveryOptions?.documentId === 'document-12345678' && item.message.text.length <= 8192));
  const terminal = loaded.sentMessages.find(item => item.message.type === 'TRANSCRIBE_SEGMENT');
  assert.equal(terminal.message.text, full);
});

test('offscreen Port is unusable before a valid HELLO and forged extension contexts are rejected', async () => {
  const loaded = loadBackground({ offscreenPreexisting: true });
  let forgedDisconnected = false;
  loaded.triggerConnect({
    name: 'aatools-offscreen-network-v1',
    sender: {
      id: 'test-extension', tab: { id: 1 },
      url: 'chrome-extension://test-extension/offscreen/network-host.html',
    },
    disconnect() { forgedDisconnected = true; },
  });
  assert.equal(forgedDisconnected, true);

  let inbound;
  const posted = [];
  const candidate = {
    name: 'aatools-offscreen-network-v1',
    sender: { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen/network-host.html' },
    onMessage: { addListener(listener) { inbound = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) { posted.push(message); },
    disconnect() {},
  };
  loaded.triggerConnect(candidate);
  let resolved = false;
  const waiting = loaded.context.waitForNetworkPort().then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false, 'candidate Port must not be published before HELLO');
  inbound({
    type: 'NETWORK_HELLO', version: 1,
    generation: 'abcdef12-1234-1234-1234-123456789abc', jobs: [],
  });
  await waiting;
  assert.equal(resolved, true);
  assert.deepEqual(posted, []);
});

test('offscreen events after a service-worker restart remain bound to the original document', () => {
  const loaded = loadBackground();
  const route = {
    tabId: 17, frameId: 0, documentId: 'old-document-1234', requestId: 'resume-1',
    prefix: 'SUMMARY', kind: 'provider',
  };
  loaded.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: 'abcdef12-1234-1234-1234-123456789abc', route,
    event: { kind: 'CHUNK', text: 'continued' },
  });
  assert.equal(loaded.sentMessages.length, 1);
  assert.equal(loaded.sentMessages[0].deliveryOptions.documentId, 'old-document-1234');

  loaded.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: 'bbcdef12-1234-1234-1234-123456789abc',
    route: Object.assign({}, route, { documentId: undefined }),
    event: { kind: 'DONE' },
  });
  assert.equal(loaded.sentMessages.length, 1, 'missing document identity must fail closed');
});

test('provider terminal replay carries authoritative bounded text after a lost CHUNK', () => {
  const loaded = loadBackground();
  const route = {
    tabId: 18, frameId: 2, documentId: 'recovered-document-1234', requestId: 'recover-output-1',
    prefix: 'CHAT', kind: 'provider',
  };
  assert.equal(loaded.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: 'abcdee12-1234-1234-1234-123456789abc', route,
    event: { kind: 'DONE', text: 'complete authoritative answer' },
  }), true);
  assert.deepEqual(plain(loaded.sentMessages.at(-1)), {
    tabId: 18,
    message: {
      type: 'CHAT_DONE', requestId: 'recover-output-1',
      text: 'complete authoritative answer',
    },
    deliveryOptions: { frameId: 2, documentId: 'recovered-document-1234' },
  });
});

test('malformed trusted provider terminals fail closed, finish the route, and are ACKed', async () => {
  const loaded = loadBackground({
    networkStart(_job, emit) {
      emit({ kind: 'ERROR', code: 'bad-terminal', message: 'A'.repeat(2000) });
    },
  });
  const result = await loaded.context.callProvider('claude', {
    key: 'secret', model: 'claude-sonnet-5', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
    tabId: 28, PREFIX: 'SUMMARY', requestId: 'malformed-terminal-1',
    deliveryOptions: { frameId: 0, documentId: 'malformed-document-1234' },
  });
  assert.equal(result.started, true);
  await new Promise(resolve => setImmediate(resolve));
  const failure = loaded.sentMessages.find(item =>
    item.message.requestId === 'malformed-terminal-1' && item.message.type === 'SUMMARY_ERROR');
  assert.match(failure.message.error, /无效终态/);
  assert.ok(loaded.networkPortMessages.some(item => item.type === 'NETWORK_ACK'));
});

test('offscreen terminal is ACKed only after the content delivery attempt settles', async () => {
  let settleDelivery;
  const loaded = loadBackground({
    tabsSendMessage(_tabId, message) {
      if (message.type === 'SUMMARY_DONE') {
        return new Promise(resolve => { settleDelivery = resolve; });
      }
      return undefined;
    },
    networkStart(_job, emit) {
      emit({ kind: 'DONE', text: 'delivered exactly once' });
    },
  });

  const result = await loaded.context.callProvider('claude', {
    key: 'secret', model: 'claude-sonnet-5', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
    tabId: 29, PREFIX: 'SUMMARY', requestId: 'delivery-before-ack-1',
    deliveryOptions: { frameId: 0, documentId: 'delivery-document-1234' },
  });
  assert.equal(result.started, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof settleDelivery, 'function');
  assert.equal(loaded.networkPortMessages.some(item => item.type === 'NETWORK_ACK'), false);

  settleDelivery();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(loaded.networkPortMessages.some(item => item.type === 'NETWORK_ACK'));
});

test('an orphaned internal OAuth terminal fails the originating document after a service-worker restart', () => {
  const loaded = loadBackground();
  const recoveryRoute = {
    tabId: 19, frameId: 0, documentId: 'oauth-document-1234', requestId: 'oauth-recovery-1',
    prefix: 'SUMMARY', kind: 'provider',
  };
  const accepted = loaded.context.handleNetworkEvent({
    type: 'NETWORK_EVENT', jobId: 'cbcdef12-1234-1234-1234-123456789abc',
    route: {
      kind: 'internal', prefix: 'INTERNAL',
      requestId: 'internal-cbcdef12-1234-1234-1234-123456789abc',
      recoveryRoutes: [recoveryRoute], routeRevision: 1,
    },
    event: { kind: 'DONE', json: { access_token: 'never-routed-after-restart' } },
  });
  assert.equal(accepted, true);
  assert.deepEqual(plain(loaded.sentMessages.at(-1)), {
    tabId: 19,
    message: {
      type: 'SUMMARY_ERROR', requestId: 'oauth-recovery-1',
      error: '授权刷新期间后台已重启，请重试', reason: 'service_worker_restarted',
    },
    deliveryOptions: { frameId: 0, documentId: 'oauth-document-1234' },
  });
});

test('terminal ACK schedules idle offscreen close while a new active job cancels that close', async () => {
  function timers() {
    let next = 1;
    const entries = new Map();
    return {
      setTimeout(callback, ms) { const id = next++; entries.set(id, { callback, ms }); return id; },
      clearTimeout(id) { entries.delete(id); },
      run(ms) {
        const due = Array.from(entries.entries()).filter(([, item]) => item.ms === ms);
        for (const [id, item] of due) { entries.delete(id); item.callback(); }
      },
    };
  }

  const idleTimers = timers();
  const idle = loadBackground({
    setTimeout: idleTimers.setTimeout,
    clearTimeout: idleTimers.clearTimeout,
    networkStart(_job, emit) { emit({ kind: 'DONE', text: 'test output' }); },
  });
  await idle.context.callProvider('claude', {
    key: 'secret', model: 'claude-opus-5', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 10,
    tabId: 4, PREFIX: 'SUMMARY', requestId: 'idle-close',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(idle.networkPortMessages.some(item => item.type === 'NETWORK_ACK'));
  idleTimers.run(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle.offscreenCloseCount, 1);

  const activeTimers = timers();
  const active = loadBackground({
    setTimeout: activeTimers.setTimeout,
    clearTimeout: activeTimers.clearTimeout,
    networkStart() {},
  });
  await active.context.callProvider('claude', {
    key: 'secret', model: 'claude-opus-5', systemPrompt: '',
    messages: [{ role: 'user', content: 'hello' }], maxTokens: 10,
    tabId: 5, PREFIX: 'SUMMARY', requestId: 'active-no-close',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  activeTimers.run(5000);
  assert.equal(active.offscreenCloseCount, 0);
  active.context.cancelRequestsForTab(5, 'active-no-close');
  active.context.finishNetworkJob(
    active.networkPortMessages.find(item => item.type === 'NETWORK_START').job.jobId
  );
});

test('a wildcard host grant reintroduced after migration is revoked before any gateway secret leaves', async () => {
  let wildcard = false;
  const loaded = loadBackground({
    permissionContains(query, callback) {
      if (query?.origins?.includes('https://*/*')) callback(wildcard);
      else callback(true);
    },
    permissionRemove(query, callback) {
      if (query?.origins?.includes('https://*/*')) wildcard = false;
      callback(true);
    },
  });
  await loaded.context.migrateLegacyBroadHostPermission();
  delete loaded.storageData.local.gatewayPermissionReauthorizationRequired;
  wildcard = true;
  await loaded.context.callProvider('sub2api', {
    key: 'must-not-leave', model: 'claude-opus-5', baseUrl: 'https://gateway.example',
    systemPrompt: '', messages: [{ role: 'user', content: 'hello' }], maxTokens: 100,
    tabId: 3, PREFIX: 'SUMMARY', requestId: 'wildcard-regrant',
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  assert.equal(loaded.networkPortMessages.some(item => item.type === 'NETWORK_START'), false);
  assert.equal(loaded.storageData.local.gatewayPermissionReauthorizationRequired, true);
  assert.match(loaded.sentMessages.at(-1).message.error, /过宽|重新授权/);
});
test('request registry cancels active and not-yet-registered work without keepalive pings', async () => {
  const { context, tabListeners } = loadBackground();
  const first = context.createActiveRequest({ tabId: 3, requestId: 'first', kind: 'summary', totalMs: 1000 });
  const second = context.createActiveRequest({ tabId: 3, requestId: 'second', kind: 'chat', totalMs: 1000 });

  const cancelled = context.cancelRequestsForTab(3, 'first');
  assert.equal(cancelled.cancelled, 1);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.abortReason.code, 'cancelled');
  first.cleanup();

  const pending = context.cancelRequestsForTab(4, 'early');
  assert.equal(pending.pending, true);
  const late = context.createActiveRequest({ tabId: 4, requestId: 'early', kind: 'vocab', totalMs: 1000 });
  assert.equal(late.signal.aborted, true);
  assert.equal(late.abortReason.code, 'cancelled');

  tabListeners.updated(3, { status: 'loading' });
  assert.equal(second.signal.aborted, true);
  assert.equal(second.abortReason.message, '页面已导航，请求已取消');

  const historyOnly = context.createActiveRequest({ tabId: 8, requestId: 'history', kind: 'translate', totalMs: 1000 });
  tabListeners.updated(8, { url: 'https://example.com/#new-state' });
  assert.equal(historyOnly.signal.aborted, false);

  second.cleanup();
  late.cleanup();
  historyOnly.cleanup();
  assert.equal(vm.runInContext('activeRequests.size', context), 0);
});

test('message execution rechecks trusted senders, feature flags, and payload limits', async () => {
  const disabled = loadBackground({ syncData: { enableTranslate: false, enableGestures: false, enableYoutube: false } });
  const translationSender = {
    tab: { id: 11, url: 'https://example.com/' },
    frameId: 2,
    url: 'https://frame.example/article',
  };
  const translate = await dispatchMessage(disabled, {
    type: 'TRANSLATE', text: 'hello', provider: 'claude', requestId: 'translate-1',
  }, translationSender);
  assert.equal(translate.response.started, false);
  assert.match(translate.response.error, /已关闭/);
  assert.equal(disabled.fetchCalls.length, 0);

  const oversized = await dispatchMessage(disabled, {
    type: 'TRANSLATE', text: 'x'.repeat(5001), provider: 'claude', requestId: 'translate-2',
  }, translationSender);
  assert.match(oversized.response.error, /5000/);
  const invalidLanguage = await dispatchMessage(disabled, {
    type: 'TRANSLATE', text: 'hello', targetLang: 'not-a-language', provider: 'claude', requestId: 'translate-3',
  }, translationSender);
  assert.match(invalidLanguage.response.error, /目标语言/);
  const missingRequestId = await dispatchMessage(disabled, {
    type: 'TRANSLATE', text: 'hello', provider: 'claude',
  }, translationSender);
  assert.match(missingRequestId.response.error, /请求 ID/);
  const unsafeRequestId = await dispatchMessage(disabled, {
    type: 'TRANSLATE', text: 'hello', provider: 'claude', requestId: 'bad id?query',
  }, translationSender);
  assert.match(unsafeRequestId.response.error, /请求 ID/);

  const iframeGesture = await dispatchMessage(disabled, { type: 'GESTURE_CLOSE_TAB' }, translationSender);
  assert.match(iframeGesture.response.error, /不允许/);
  const topGesture = await dispatchMessage(disabled, { type: 'GESTURE_CLOSE_TAB' }, {
    tab: { id: 11, url: 'https://example.com/' }, frameId: 0, url: 'https://example.com/',
  });
  assert.match(topGesture.response.error, /已关闭/);
  assert.equal(disabled.tabActions.length, 0);

  const disabledYoutube = await dispatchMessage(disabled, {
    type: 'SUMMARIZE', transcript: 'caption', prompt: '{transcript}', provider: 'claude', requestId: 'youtube-off',
  }, {
    tab: { id: 14, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    frameId: 0,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.equal(disabledYoutube.response.started, false);
  assert.match(disabledYoutube.response.error, /已关闭/);
  assert.equal(disabled.fetchCalls.length, 0);

  const enabled = loadBackground({ syncData: { enableGestures: true } });
  const action = await dispatchMessage(enabled, { type: 'GESTURE_RELOAD_HARD' }, {
    tab: { id: 12, url: 'https://example.com/' }, frameId: 0, url: 'https://example.com/',
  });
  assert.equal(action.response.ok, true);
  assert.deepEqual(plain(enabled.tabActions), [{ type: 'reload', tabId: 12, details: { bypassCache: true } }]);

  const youtube = loadBackground();
  const badSummary = await dispatchMessage(youtube, {
    type: 'SUMMARIZE', transcript: 'x'.repeat(250001), prompt: '{transcript}', provider: 'claude', requestId: 'too-big',
  }, {
    tab: { id: 13, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    frameId: 0,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.match(badSummary.response.error, /250000/);
  assert.equal(youtube.fetchCalls.length, 0);
});

test('translation stream messages are sent only to the initiating iframe', async () => {
  const encoder = new TextEncoder();
  const loaded = loadBackground({
    localData: { claudeKey: 'secret' },
    syncData: { enableTranslate: true, claudeModel: 'claude-sonnet-5' },
    fetch: async () => {
      let read = false;
      return {
        ok: true,
        body: { getReader() { return {
          async read() {
            if (read) return { done: true };
            read = true;
            return { done: false, value: encoder.encode(
              'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"translated"}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n'
            ) };
          },
          async cancel() {},
        }; } },
      };
    },
  });

  for (const frameId of [2, 7]) {
    const requestId = `frame-${frameId}`;
    const response = await dispatchMessage(loaded, {
      type: 'TRANSLATE', text: 'hello', provider: 'claude', requestId,
    }, {
      tab: { id: 11, url: 'https://example.com/' }, frameId,
      url: `https://frame${frameId}.example/article`,
    });
    assert.equal(response.response.started, true);
    assert.ok(loaded.networkPortMessages.some(message =>
      message.type === 'NETWORK_START' && message.job.route.requestId === requestId));
    await new Promise(resolve => setImmediate(resolve));
    const messages = loaded.sentMessages.filter(item => item.message.requestId === requestId);
    assert.ok(messages.length >= 2);
    assert.ok(messages.every(item => item.deliveryOptions?.frameId === frameId));
  }
});

test('extension-origin chat iframe relay validates its sender and targets only the YouTube top frame', async () => {
  const loaded = loadBackground({
    syncData: { enableYoutube: true },
    tabsSendMessage(_tabId, message, deliveryOptions) {
      if (message.type === 'YTX_CHAT_SUBMIT' && deliveryOptions?.frameId === 0) return { accepted: true };
      return undefined;
    },
  });
  const sender = {
    id: 'test-extension', frameId: 4,
    url: 'chrome-extension://test-extension/youtube/chat-frame.html#private-fragment',
    tab: { id: 55, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  };
  const message = {
    type: 'YTX_CHAT_FRAME_SUBMIT', token: '0123456789abcdef0123456789abcdef',
    videoId: 'abcdefghijk', text: 'private question',
  };
  const accepted = await dispatchMessage(loaded, message, sender);
  assert.deepEqual(plain(accepted.response), { ok: true });
  const relay = loaded.sentMessages.at(-1);
  assert.deepEqual(plain(relay), {
    tabId: 55,
    message: { type: 'YTX_CHAT_SUBMIT', token: message.token, videoId: message.videoId, text: message.text },
    deliveryOptions: { frameId: 0 },
  });

  const topFrame = await dispatchMessage(loaded, message, { ...sender, frameId: 0 });
  assert.match(topFrame.response.error, /不允许/);
  const pageFrame = await dispatchMessage(loaded, message, {
    ...sender, id: undefined, url: 'https://www.youtube.com/frame',
  });
  assert.match(pageFrame.response.error, /不允许/);
  const oversized = await dispatchMessage(loaded, { ...message, text: 'x'.repeat(10001) }, sender);
  assert.match(oversized.response.error, /过长/);
  const translateByExtensionFrame = await dispatchMessage(loaded, {
    type: 'TRANSLATE', text: 'must not relay', provider: 'claude', requestId: 'extension-frame-translate',
  }, sender);
  assert.match(translateByExtensionFrame.response.error, /不允许/);
});

test('YouTube top frame can relay only bounded non-content chat state to extension frames', async () => {
  const loaded = loadBackground({ syncData: { enableYoutube: true } });
  const sender = {
    id: 'test-extension', frameId: 0,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    tab: { id: 56, url: 'https://www.youtube.com/watch?v=abcdefghijk' },
  };
  const message = {
    type: 'YTX_CHAT_FRAME_STATE_RELAY', token: 'abcdef0123456789abcdef0123456789', videoId: 'abcdefghijk',
    state: { busy: true, dark: false, error: 'try again' },
  };
  const accepted = await dispatchMessage(loaded, message, sender);
  assert.deepEqual(plain(accepted.response), { ok: true });
  assert.deepEqual(plain(loaded.runtimeMessages), [{
    type: 'YTX_CHAT_FRAME_STATE', token: 'abcdef0123456789abcdef0123456789', videoId: 'abcdefghijk',
    state: { busy: true, dark: false, error: 'try again' },
  }]);

  const contentLeak = await dispatchMessage(loaded, {
    ...message, state: { messages: ['private content'] },
  }, sender);
  assert.match(contentLeak.response.error, /未允许字段/);
  const longError = await dispatchMessage(loaded, {
    ...message, state: { error: 'x'.repeat(501) },
  }, sender);
  assert.match(longError.response.error, /过长/);
});

test('gesture actions recheck navigation after the asynchronous feature flag read', async () => {
  for (const type of ['GESTURE_CLOSE_TAB', 'GESTURE_RELOAD_HARD', 'GESTURE_REOPEN_TAB']) {
    let releaseFeature;
    const loaded = loadBackground({
      featureStorageGet(_fields, callback) { releaseFeature = () => callback({ enableGestures: true }); },
    });
    const pending = dispatchMessage(loaded, { type }, {
      tab: { id: 31, url: 'https://example.com/' }, frameId: 0, url: 'https://example.com/',
    });
    await new Promise(resolve => setImmediate(resolve));
    loaded.tabListeners.updated(31, { status: 'loading' });
    releaseFeature();
    const response = await pending;
    assert.equal(response.response.ok, false);
    assert.match(response.response.error, /已导航/);
    assert.equal(loaded.tabActions.length, 0);
  }
});

test('incognito gestures cannot restore a regular-profile recently closed tab', async () => {
  const loaded = loadBackground({ syncData: { enableGestures: true } });
  const response = await dispatchMessage(loaded, { type: 'GESTURE_REOPEN_TAB' }, {
    tab: { id: 44, incognito: true, url: 'https://example.com/' },
    frameId: 0, url: 'https://example.com/',
  });
  assert.equal(response.response.ok, false);
  assert.match(response.response.error, /隐身窗口/);
  assert.equal(loaded.tabActions.some(action => action.type === 'restore'), false);
});

test('gesture API failures are returned to the initiating page', async () => {
  const loaded = loadBackground({
    syncData: { enableGestures: true },
    sessionsRestore() { return Promise.reject(new Error('no recently closed tab')); },
  });
  const response = await dispatchMessage(loaded, { type: 'GESTURE_REOPEN_TAB' }, {
    tab: { id: 45, url: 'https://example.com/' },
    frameId: 0, url: 'https://example.com/',
  });
  assert.equal(response.response.ok, false);
  assert.match(response.response.error, /no recently closed tab/);
});

test('video transcription accepts only matching canonical YouTube watch or Shorts URLs', () => {
  const { context } = loadBackground();
  const base = { type: 'TRANSCRIBE_VIDEO', videoId: 'abcdefghijk', provider: 'gemini', requestId: 'transcribe-url-test' };
  assert.equal(context.validateMessagePayload({ ...base, videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }), '');
  assert.equal(context.validateMessagePayload({ ...base, videoUrl: 'https://www.youtube.com/shorts/abcdefghijk?feature=share' }), '');
  assert.match(context.validateMessagePayload({ ...base, videoUrl: 'https://www.youtube.com/watch?v=lmnopqrstuv' }), /不匹配/);
  assert.match(context.validateMessagePayload({ ...base, videoUrl: 'https://evil.example/video.mp4' }), /视频 URL/);
  assert.match(context.validateMessagePayload({ ...base, videoUrl: 'https://youtu.be/abcdefghijk' }), /视频 URL/);
  assert.match(context.validateMessagePayload({ ...base, videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoDuration: 86401 }), /视频时长/);
});

test('TRANSCRIBE_VIDEO acknowledges only after hidden worker handoff and completes through a document-bound terminal message', async () => {
  const loaded = loadBackground({
    localData: { geminiKey: 'secret' },
    syncData: { enableYoutube: true },
    networkStart(_job, emit) { emit({ kind: 'DONE', text: '[00:00] hello' }); },
  });
  const request = {
    type: 'TRANSCRIBE_VIDEO', videoId: 'abcdefghijk', requestId: 'transcribe-async-ack',
    videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk', videoDuration: 60,
  };
  const response = await dispatchMessage(loaded, request, {
    tab: { id: 33, url: request.videoUrl }, frameId: 0, url: request.videoUrl,
    documentId: 'transcribe-document-1234',
  });
  assert.deepEqual(plain(response.response), { started: true, requestId: 'transcribe-async-ack' });
  assert.equal(response.response.text, undefined);
  assert.ok(loaded.networkPortMessages.some(message =>
    message.type === 'NETWORK_START' && message.job.route.requestId === 'transcribe-async-ack'));
  await new Promise(resolve => setImmediate(resolve));
  const terminal = loaded.sentMessages.find(item => item.message.type === 'TRANSCRIBE_SEGMENT');
  assert.equal(terminal.message.text, '[00:00] hello');
  assert.equal(terminal.deliveryOptions.documentId, 'transcribe-document-1234');
});

test('navigation and tab close invalidate provider work still waiting for configuration', async () => {
  for (const lifecycleEvent of ['updated', 'removed']) {
    let releaseConfig;
    const loaded = loadBackground({
      localData: { claudeKey: 'secret' },
      storageGet(_fields, callback) {
        releaseConfig = () => callback({ claudeModel: 'claude-sonnet-5' });
      },
      fetch: async () => { throw new Error('stale work must not fetch'); },
    });

    const work = loaded.context.handleSummarize({
      provider: 'claude', requestId: `stale-${lifecycleEvent}`, transcript: 'text', prompt: '{transcript}',
    }, 42, 'SUMMARY');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof releaseConfig, 'function');
    if (lifecycleEvent === 'updated') loaded.tabListeners.updated(42, { status: 'loading' });
    else loaded.tabListeners.removed(42);
    releaseConfig();
    await work;

    assert.equal(loaded.fetchCalls.length, 0);
    assert.equal(loaded.sentMessages.at(-1).message.cancelled, true);
  }
});

test('navigation during a custom gateway permission check prevents the upstream fetch', async () => {
  let releasePermission;
  const loaded = loadBackground({
    permissionContains(query, callback) {
      if (query?.origins?.includes('https://*/*')) callback(false);
      else releasePermission = () => callback(true);
    },
    fetch: async () => { throw new Error('stale work must not fetch'); },
  });
  const work = loaded.context.callProvider('sub2api', {
    key: 'secret', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128, tabId: 12, PREFIX: 'SUMMARY', requestId: 'permission-race',
    baseUrl: 'https://gateway.example', model: 'claude-sonnet-5', navigationEpoch: 0,
    deliveryOptions: { frameId: 0, documentId: 'document-12345678' },
  });
  for (let i = 0; i < 10 && !releasePermission; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releasePermission, 'function');
  loaded.tabListeners.updated(12, { status: 'loading' });
  releasePermission();
  await work;

  assert.equal(loaded.fetchCalls.length, 0);
  assert.equal(loaded.sentMessages.at(-1).message.cancelled, true);
});

test('transcript fallback does not execute in a new document after navigation', async () => {
  let finishFastPath;
  let executeCount = 0;
  const loaded = loadBackground({
    executeScript() {
      executeCount++;
      return new Promise(resolve => { finishFastPath = resolve; });
    },
  });
  const work = loaded.context.handleFetchTranscript('abcdefghijk', 15, 0);
  loaded.tabListeners.updated(15, { status: 'loading' });
  finishFastPath([{ result: { error: 'no fast transcript' } }]);
  const result = await work;

  assert.equal(executeCount, 1);
  assert.equal(result.cancelled, true);
});

test('background normalizes MAIN-world transcript results before returning them', async () => {
  const { context } = loadBackground();
  assert.deepEqual(plain(context.normalizeTranscriptSegments([
    { start: 1.9, text: '  hello  ' },
  ])), { segments: [{ start: 1, text: 'hello' }] });
  assert.match(context.normalizeTranscriptSegments([{ start: NaN, text: 'bad' }]).error, /格式无效/);
  assert.match(context.normalizeTranscriptSegments([{ start: 0, text: 'x'.repeat(5001) }]).error, /过长/);
  assert.match(context.normalizeTranscriptSegments(
    Array.from({ length: 20001 }, () => ({ start: 0, text: 'x' }))
  ).error, /20000/);

  let call = 0;
  const loaded = loadBackground({
    executeScript() {
      call++;
      return Promise.resolve(call === 1
        ? [{ result: { segments: [{ start: 'not-a-number', text: 'untrusted' }] } }]
        : [{ result: { segments: [{ start: 2.8, text: '  safe DOM text ' }] } }]);
    },
  });
  const result = await loaded.context.handleFetchTranscript('abcdefghijk', 3, 0);
  assert.equal(call, 2);
  assert.deepEqual(plain(result), { segments: [{ start: 2, text: 'safe DOM text' }] });
});

test('DOM transcript scraping exits immediately when YouTube SPA changed videos', async () => {
  const loaded = loadBackground();
  loaded.context.location = { href: 'https://www.youtube.com/watch?v=lmnopqrstuv' };
  loaded.context.document = { querySelector() { return null; } };

  const result = await loaded.context.scrapeTranscriptFromDOM('abcdefghijk');
  assert.equal(result.cancelled, true);
  assert.match(result.error, /切换视频/);
});

test('fast transcript waits for the new SPA player instead of cancelling a valid new request', async () => {
  const targetVideoId = 'lmnopqrstuv';
  let playerVideoId = 'abcdefghijk';
  const player = {
    getPlayerResponse() {
      return {
        videoDetails: { videoId: playerVideoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
      };
    },
  };
  const loaded = loadBackground({
    fetch: async () => jsonStreamResponse({ events: [{ tStartMs: 1000, segs: [{ utf8: 'new transcript' }] }] }),
  });
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${targetVideoId}` };
  loaded.context.document = { querySelector(selector) { return selector === '#movie_player' ? player : null; } };
  loaded.context.performance = {
    now() { return 1; },
    getEntriesByType() {
      return [
        { name: `https://www.youtube.com/api/timedtext?v=${targetVideoId}&pot=test&fmt=json3` },
        { name: `https://evil.example/api/timedtext?v=${targetVideoId}&pot=crafted` },
      ];
    },
  };
  loaded.context.setTimeout = (callback) => {
    playerVideoId = targetVideoId;
    queueMicrotask(callback);
    return 1;
  };

  const result = await loaded.context.fastScrapeTranscriptViaPlayerAPI(targetVideoId);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.segments[0].text, 'new transcript');
  assert.equal(new URL(loaded.fetchCalls[0][0]).hostname, 'www.youtube.com');
});

test('fast transcript recognizes a YouTube Shorts URL as the target video', async () => {
  const videoId = 'abcdefghijk';
  const player = {
    getPlayerResponse() {
      return {
        videoDetails: { videoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
      };
    },
  };
  const loaded = loadBackground({
    fetch: async () => jsonStreamResponse({ events: [{ tStartMs: 1000, segs: [{ utf8: 'short transcript' }] }] }),
  });
  loaded.context.location = { href: `https://www.youtube.com/shorts/${videoId}` };
  loaded.context.document = { querySelector(selector) { return selector === '#movie_player' ? player : null; } };
  loaded.context.performance = {
    now() { return 1; },
    getEntriesByType() { return [{ name: `https://www.youtube.com/api/timedtext?v=${videoId}&pot=test&fmt=json3` }]; },
  };

  const result = await loaded.context.fastScrapeTranscriptViaPlayerAPI(videoId);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.segments[0].text, 'short transcript');
});

test('fast transcript bounds page-controlled caption and performance collections', async () => {
  const videoId = 'abcdefghijk';
  const oversizedTracks = loadBackground();
  oversizedTracks.context.location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  oversizedTracks.context.document = { querySelector() { return {
    getPlayerResponse() {
      return {
        videoDetails: { videoId },
        captions: { playerCaptionsTracklistRenderer: {
          captionTracks: Array.from({ length: 101 }, () => ({ languageCode: 'en' })),
        } },
      };
    },
  }; } };
  oversizedTracks.context.performance = { now() { return 1; }, getEntriesByType() { throw new Error('must not scan'); } };
  assert.match((await oversizedTracks.context.fastScrapeTranscriptViaPlayerAPI(videoId)).error, /字幕轨道/);

  let numericAccesses = 0;
  const entries = new Proxy({
    length: 1_000_000,
    980000: { name: `https://www.youtube.com/api/timedtext?v=${videoId}&pot=test&fmt=json3` },
  }, {
    get(target, property) {
      if (/^\d+$/.test(String(property))) numericAccesses++;
      return target[property];
    },
  });
  const player = { getPlayerResponse() { return {
    videoDetails: { videoId },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
  }; } };
  const boundedEntries = loadBackground({
    fetch: async () => jsonStreamResponse({ events: [{ tStartMs: 0, segs: [{ utf8: 'bounded' }] }] }),
  });
  boundedEntries.context.location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  boundedEntries.context.document = { querySelector() { return player; } };
  boundedEntries.context.performance = { now() { return 1; }, getEntriesByType() { return entries; } };
  const result = await boundedEntries.context.fastScrapeTranscriptViaPlayerAPI(videoId);
  assert.equal(result.segments[0].text, 'bounded');
  assert.ok(numericAccesses <= 20000);
});

test('MAIN transcript functions and background bound page-controlled error messages', async () => {
  const videoId = 'abcdefghijk';
  const huge = 'E'.repeat(100000);
  const fast = loadBackground();
  fast.context.location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  fast.context.document = { querySelector() { return {
    getPlayerResponse() {
      return {
        videoDetails: { videoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
      };
    },
  }; } };
  fast.context.performance = {
    now() { return 1; },
    getEntriesByType() { throw new Error(huge); },
  };
  const fastResult = await fast.context.fastScrapeTranscriptViaPlayerAPI(videoId);
  assert.ok(fastResult.error.length <= 1200);

  let executeCount = 0;
  const background = loadBackground({
    executeScript() {
      executeCount++;
      return Promise.resolve([{ result: { error: huge } }]);
    },
  });
  const result = await background.context.handleFetchTranscript(videoId, 9, 0);
  assert.equal(executeCount, 2);
  assert.ok(result.error.length <= 2000);
});

test('stale fast transcript work does not restore captions on a reused SPA player', async () => {
  const oldVideoId = 'abcdefghijk';
  const setTrackCalls = [];
  let unloadCalls = 0;
  const player = {
    getPlayerResponse() {
      return {
        videoDetails: { videoId: oldVideoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
      };
    },
    getOption() { return null; },
    loadModule() {},
    setOption(_module, _name, value) { setTrackCalls.push(value); },
    unloadModule() { unloadCalls++; },
  };
  const loaded = loadBackground();
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${oldVideoId}` };
  loaded.context.document = { querySelector(selector) { return selector === '#movie_player' ? player : null; } };
  loaded.context.performance = { now() { return 1; }, getEntriesByType() { return []; } };
  loaded.context.setTimeout = (callback) => {
    loaded.context.location.href = 'https://www.youtube.com/watch?v=lmnopqrstuv';
    queueMicrotask(callback);
    return 1;
  };

  const result = await loaded.context.fastScrapeTranscriptViaPlayerAPI(oldVideoId);
  assert.equal(result.cancelled, true);
  assert.deepEqual(plain(setTrackCalls), [{ languageCode: 'en' }]);
  assert.equal(unloadCalls, 0);
});

test('fast transcript restores the exact caption track when captions were already enabled', async () => {
  const videoId = 'abcdefghijk';
  const originalTrack = { languageCode: 'fr', kind: 'standard', name: 'Français' };
  const setTrackCalls = [];
  let unloadCalls = 0;
  let potAvailable = false;
  const player = {
    getPlayerResponse() {
      return {
        videoDetails: { videoId },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } },
      };
    },
    getOption() { return originalTrack; },
    loadModule() {},
    setOption(_module, _name, value) { setTrackCalls.push(value); },
    unloadModule() { unloadCalls++; },
  };
  const loaded = loadBackground({
    fetch: async () => jsonStreamResponse({ events: [{ tStartMs: 0, segs: [{ utf8: 'caption' }] }] }),
  });
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  loaded.context.document = { querySelector(selector) { return selector === '#movie_player' ? player : null; } };
  loaded.context.performance = {
    now() { return 1; },
    getEntriesByType() {
      return potAvailable ? [{ name: `https://www.youtube.com/api/timedtext?v=${videoId}&pot=test&fmt=json3` }] : [];
    },
  };
  loaded.context.setTimeout = (callback) => {
    potAvailable = true;
    queueMicrotask(callback);
    return 1;
  };

  const result = await loaded.context.fastScrapeTranscriptViaPlayerAPI(videoId);
  assert.equal(result.segments[0].text, 'caption');
  assert.deepEqual(plain(setTrackCalls), [{ languageCode: 'en' }, originalTrack]);
  assert.equal(unloadCalls, 0);
});

test('DOM transcript waits for matching player and watch state before reading an existing panel', async () => {
  const targetVideoId = 'lmnopqrstuv';
  let currentVideoId = 'abcdefghijk';
  const player = { getPlayerResponse() { return { videoDetails: { videoId: currentVideoId } }; } };
  const flexy = { getAttribute(name) { return name === 'video-id' ? currentVideoId : null; } };
  const segment = {
    querySelector(selector) {
      if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return { textContent: '0:01' };
      if (selector === 'span.yt-core-attributed-string') {
        return { textContent: currentVideoId === targetVideoId ? 'new panel transcript' : 'old panel transcript' };
      }
      return null;
    },
  };
  const panel = { querySelectorAll() { return [segment]; } };
  const loaded = loadBackground();
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${targetVideoId}` };
  loaded.context.document = {
    querySelector(selector) {
      if (selector === '#movie_player') return player;
      if (selector === 'ytd-watch-flexy') return flexy;
      if (selector === '[target-id="PAmodern_transcript_view"]') return panel;
      return null;
    },
  };
  loaded.context.setTimeout = (callback) => {
    currentVideoId = targetVideoId;
    panel.__aatoolsTranscriptSource = {
      videoId: targetVideoId,
      signature: '1\u0000new panel transcript',
    };
    queueMicrotask(callback);
    return 1;
  };

  const result = await loaded.context.scrapeTranscriptFromDOM(targetVideoId);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.segments[0].text, 'new panel transcript');
});

test('DOM transcript supports Shorts URLs and timestamps beyond 99 total minutes', async () => {
  const videoId = 'abcdefghijk';
  const player = { getPlayerResponse() { return { videoDetails: { videoId } }; } };
  const segment = {
    querySelector(selector) {
      if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return { textContent: '100:00' };
      if (selector === 'span.yt-core-attributed-string') return { textContent: 'long video timestamp' };
      return null;
    },
  };
  const panel = {
    __aatoolsTranscriptSource: { videoId, signature: '6000\u0000long video timestamp' },
    querySelectorAll() { return [segment]; },
  };
  const loaded = loadBackground();
  loaded.context.location = { href: `https://www.youtube.com/shorts/${videoId}` };
  loaded.context.document = {
    querySelector(selector) {
      if (selector === '#movie_player') return player;
      if (selector === 'ytd-watch-flexy') return { getAttribute() { return videoId; } };
      if (selector === '[target-id="PAmodern_transcript_view"]') return panel;
      return null;
    },
  };
  loaded.context.setTimeout = (callback) => { queueMicrotask(callback); return 1; };

  const result = await loaded.context.scrapeTranscriptFromDOM(videoId);
  assert.equal(result.segments[0].start, 6000);
  assert.equal(result.segments[0].text, 'long video timestamp');
});

test('DOM transcript rejects a stale existing panel until reopening refreshes its generation', async () => {
  const targetVideoId = 'lmnopqrstuv';
  function makePanel(text) {
    return {
      querySelectorAll() {
        return [{
          querySelector(selector) {
            if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return { textContent: '0:01' };
            if (selector === 'span.yt-core-attributed-string') return { textContent: text };
            return null;
          },
        }];
      },
    };
  }
  const oldPanel = makePanel('old video transcript');
  const newPanel = makePanel('new video transcript');
  let activePanel = oldPanel;
  const player = { getPlayerResponse() { return { videoDetails: { videoId: targetVideoId } }; } };
  const flexy = { getAttribute() { return targetVideoId; } };
  const section = { querySelector() { return { click() { activePanel = newPanel; } }; } };
  const loaded = loadBackground();
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${targetVideoId}` };
  loaded.context.document = {
    querySelector(selector) {
      if (selector === '#movie_player') return player;
      if (selector === 'ytd-watch-flexy') return flexy;
      if (selector === '[target-id="PAmodern_transcript_view"]') return activePanel;
      if (selector === 'ytd-video-description-transcript-section-renderer') return section;
      return null;
    },
    querySelectorAll() { return []; },
  };
  loaded.context.setTimeout = (callback) => { queueMicrotask(callback); return 1; };

  const result = await loaded.context.scrapeTranscriptFromDOM(targetVideoId);
  assert.equal(result.segments[0].text, 'new video transcript');
  assert.equal(newPanel.__aatoolsTranscriptSource.videoId, targetVideoId);
});

test('DOM transcript safely fails instead of returning an unchanged unverified panel', async () => {
  const targetVideoId = 'lmnopqrstuv';
  const panel = {
    querySelectorAll() {
      return [{
        querySelector(selector) {
          if (selector === '.ytwTranscriptSegmentViewModelTimestamp') return { textContent: '0:01' };
          if (selector === 'span.yt-core-attributed-string') return { textContent: 'stale transcript' };
          return null;
        },
      }];
    },
  };
  const player = { getPlayerResponse() { return { videoDetails: { videoId: targetVideoId } }; } };
  const loaded = loadBackground();
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${targetVideoId}` };
  loaded.context.document = {
    querySelector(selector) {
      if (selector === '#movie_player') return player;
      if (selector === 'ytd-watch-flexy') return { getAttribute() { return targetVideoId; } };
      if (selector === '[target-id="PAmodern_transcript_view"]') return panel;
      return null;
    },
    querySelectorAll() { return []; },
  };
  loaded.context.setTimeout = (callback) => { queueMicrotask(callback); return 1; };

  const result = await loaded.context.scrapeTranscriptFromDOM(targetVideoId);
  assert.equal(result.segments, undefined);
  assert.match(result.error, /加载超时|无法获取字幕|异常/);
});

test('request registry enforces first-byte, idle, and total timeouts', async () => {
  const { context } = loadBackground();

  const firstByte = context.createActiveRequest({ tabId: 1, requestId: 'fb', kind: 'summary', totalMs: 1000 });
  firstByte.startAttempt({ firstByteMs: 5, idleMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(firstByte.abortReason.code, 'first_byte_timeout');
  firstByte.cleanup();

  const idle = context.createActiveRequest({ tabId: 1, requestId: 'idle', kind: 'summary', totalMs: 1000 });
  idle.startAttempt({ firstByteMs: 100, idleMs: 5 });
  idle.markActivity();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(idle.abortReason.code, 'idle_timeout');
  idle.cleanup();

  const total = context.createActiveRequest({ tabId: 1, requestId: 'total', kind: 'summary', totalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(total.abortReason.code, 'total_timeout');
  total.cleanup();
});

test('extension cache saves, removes, and clears current-version records', async () => {
  const { context } = loadBackground();
  const videoId = 'abcdefghijk';
  const epoch = await context.cacheGetEpoch();

  await context.cacheSaveFeature(videoId, 'summary', { text: 'new summary' }, epoch);
  assert.equal((await context.cacheLoadRecord(videoId)).summary.text, 'new summary');

  await context.cacheRemoveRecord(videoId, epoch);
  assert.equal(await context.cacheLoadRecord(videoId), null);

  await context.cacheSaveFeature(videoId, 'html', { text: '' }, epoch);
  await context.cacheClearRecords();
  assert.equal(await context.cacheLoadRecord(videoId), null);
});

test('cache enforces its size cap on the whole merged video record', async () => {
  const { context } = loadBackground();
  const videoId = 'abcdefghijk';
  const epoch = await context.cacheGetEpoch();
  await context.cacheSaveFeature(videoId, 'summary', { text: 'a'.repeat(2_600_000) }, epoch);
  await assert.rejects(
    context.cacheSaveFeature(videoId, 'html', { text: 'b'.repeat(2_600_000) }, epoch),
    /缓存数据过大/
  );
  const record = await context.cacheLoadRecord(videoId);
  assert.equal(record.summary.text.length, 2_600_000);
  assert.equal(record.html, undefined);
});

test('loading an oversized poisoned cache record deletes it before crossing the message boundary', async () => {
  const { context } = loadBackground();
  const videoId = 'abcdefghijk';
  const db = await context.openCacheDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('results', 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.objectStore('results').put({ videoId, summary: { text: 'x'.repeat(5_000_001) } });
  });
  assert.equal(await context.cacheLoadRecord(videoId), null);
  assert.equal(await context.cacheLoadRecord(videoId), null);
});

test('legacy page-origin cache migration messages are no longer accepted', async () => {
  const { context } = loadBackground();
  const result = await context.handleCacheMessage({
    type: 'CACHE_MIGRATE_RECORD',
    record: { videoId: 'abcdefghijk', summary: { text: 'legacy' } },
  }, {
    tab: { id: 1 }, frameId: 0, url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.deepEqual(plain(result), { ok: false, error: '未知缓存操作' });
});

test('cache message channel only accepts top-frame YouTube senders', async () => {
  const { context } = loadBackground();
  const message = { type: 'CACHE_LOAD', videoId: 'abcdefghijk' };

  const rejected = await context.handleCacheMessage(message, {
    tab: { id: 1 }, frameId: 0, url: 'https://evil.example/watch?v=abcdefghijk',
  });
  assert.equal(rejected.ok, false);

  const accepted = await context.handleCacheMessage(message, {
    tab: { id: 1 }, frameId: 0, url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  assert.deepEqual(plain(accepted), { ok: true, record: null, epoch: 1 });
});

test('persistent cache epochs reject delayed and missing saves across clear and service-worker restart', async () => {
  const indexedDB = createFakeIndexedDB();
  const youtubeSender = {
    id: 'test-extension', tab: { id: 1, incognito: false }, frameId: 0,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
  };
  const optionsSender = {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
    tab: { id: 9, url: 'chrome-extension://test-extension/options.html' },
  };
  const first = loadBackground({ indexedDB });
  const initial = await dispatchMessage(first, { type: 'CACHE_LOAD', videoId: 'abcdefghijk' }, youtubeSender);
  assert.equal(initial.response.epoch, 1);

  const missing = await dispatchMessage(first, {
    type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'summary', data: { text: 'missing epoch' },
  }, youtubeSender);
  assert.equal(missing.response.ok, false);
  assert.equal(missing.response.stale, true);

  const saved = await dispatchMessage(first, {
    type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'summary',
    data: { text: 'before clear' }, epoch: 1,
  }, youtubeSender);
  assert.equal(saved.response.ok, true);

  // SAVE先进入后台队列、CLEAR紧随其后：clear 必须在线性顺序上获胜。
  const saveBeforeClear = dispatchMessage(first, {
    type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'html',
    data: { text: 'also before clear' }, epoch: 1,
  }, youtubeSender);
  const clearAfter = dispatchMessage(first, { type: 'CACHE_CLEAR', incognito: false }, optionsSender);
  const [, cleared] = await Promise.all([saveBeforeClear, clearAfter]);
  assert.equal(cleared.response.epoch, 2);

  // 模拟清空前已经开始生成、但清空完成后才送达的延迟保存。
  const delayedOldSave = await dispatchMessage(first, {
    type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'mindmap',
    data: { nodes: ['stale'] }, epoch: 1,
  }, youtubeSender);
  assert.equal(delayedOldSave.response.ok, false);
  assert.equal(delayedOldSave.response.stale, true);
  assert.equal(delayedOldSave.response.epoch, 2);
  const afterClear = await dispatchMessage(first, { type: 'CACHE_LOAD', videoId: 'abcdefghijk' }, youtubeSender);
  assert.deepEqual(plain(afterClear.response), { ok: true, record: null, epoch: 2 });

  // 新 service worker 使用同一扩展 IndexedDB，不能把 epoch 重置回 1。
  const restarted = loadBackground({ indexedDB });
  const afterRestart = await dispatchMessage(restarted, { type: 'CACHE_LOAD', videoId: 'abcdefghijk' }, youtubeSender);
  assert.equal(afterRestart.response.epoch, 2);
  for (const epoch of [undefined, 1]) {
    const stale = await dispatchMessage(restarted, {
      type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'summary',
      data: { text: 'must not return' }, ...(epoch === undefined ? {} : { epoch }),
    }, youtubeSender);
    assert.equal(stale.response.ok, false);
    assert.equal(stale.response.stale, true);
  }
  const current = await dispatchMessage(restarted, {
    type: 'CACHE_SAVE', videoId: 'abcdefghijk', featureKey: 'summary',
    data: { text: 'new generation' }, epoch: 2,
  }, youtubeSender);
  assert.equal(current.response.ok, true);

  for (const staleEpoch of [undefined, 1]) {
    const staleRemove = await dispatchMessage(restarted, {
      type: 'CACHE_REMOVE', videoId: 'abcdefghijk',
      ...(staleEpoch === undefined ? {} : { epoch: staleEpoch }),
    }, youtubeSender);
    assert.equal(staleRemove.response.ok, false);
    assert.equal(staleRemove.response.stale, true);
    assert.equal(staleRemove.response.epoch, 2);
  }
  assert.equal((await restarted.context.cacheLoadRecord('abcdefghijk')).summary.text, 'new generation');

  // 隐身 YouTube 页和隐身 options 页均不得清普通窗口缓存或递增代际。
  const incognitoYoutube = { ...youtubeSender, tab: { id: 2, incognito: true } };
  assert.equal((await dispatchMessage(restarted, { type: 'CACHE_CLEAR' }, incognitoYoutube)).response.ok, true);
  const incognitoOptions = { ...optionsSender, tab: { id: 10, incognito: true } };
  const skipped = await dispatchMessage(restarted, { type: 'CACHE_CLEAR', incognito: true }, incognitoOptions);
  assert.equal(skipped.response.skipped, true);
  const unchanged = await dispatchMessage(restarted, { type: 'CACHE_EPOCH' }, youtubeSender);
  assert.equal(unchanged.response.epoch, 2);
  assert.equal((await restarted.context.cacheLoadRecord('abcdefghijk')).summary.text, 'new generation');
});

test('only the exact trusted options page can clear every extension cache record', async () => {
  const loaded = loadBackground();
  let epoch = await loaded.context.cacheGetEpoch();
  await loaded.context.cacheSaveFeature('abcdefghijk', 'summary', { text: 'private summary' }, epoch);
  const trusted = await dispatchMessage(loaded, { type: 'CACHE_CLEAR' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/options.html',
    tab: { id: 9, url: 'chrome-extension://test-extension/options.html' },
  });
  assert.deepEqual(plain(trusted.response), { ok: true, epoch: 2 });
  assert.equal(await loaded.context.cacheLoadRecord('abcdefghijk'), null);

  epoch = await loaded.context.cacheGetEpoch();
  await loaded.context.cacheSaveFeature('abcdefghijk', 'summary', { text: 'keep' }, epoch);
  const rejected = await dispatchMessage(loaded, { type: 'CACHE_CLEAR' }, {
    id: 'test-extension', url: 'chrome-extension://test-extension/other.html',
  });
  assert.equal(rejected.response.ok, false);
  assert.equal((await loaded.context.cacheLoadRecord('abcdefghijk')).summary.text, 'keep');
});

test('incognito cache messages never read or mutate the regular extension cache', async () => {
  const { context } = loadBackground();
  const videoId = 'abcdefghijk';
  const epoch = await context.cacheGetEpoch();
  await context.cacheSaveFeature(videoId, 'summary', { text: 'regular-window-data' }, epoch);
  const sender = {
    tab: { id: 2, incognito: true }, frameId: 0,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };

  assert.deepEqual(plain(await context.handleCacheMessage({ type: 'CACHE_LOAD', videoId }, sender)), {
    ok: true, record: null, epoch: null,
  });
  for (const message of [
    { type: 'CACHE_SAVE', videoId, featureKey: 'summary', data: { text: 'private' } },
    { type: 'CACHE_REMOVE', videoId },
    { type: 'CACHE_CLEAR' },
  ]) {
    assert.deepEqual(plain(await context.handleCacheMessage(message, sender)), { ok: true });
  }
  assert.equal((await context.cacheLoadRecord(videoId)).summary.text, 'regular-window-data');
});
