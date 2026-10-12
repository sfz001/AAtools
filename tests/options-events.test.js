'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Blob } = require('node:buffer');

function loadOptionsEvents(config = {}) {
  const elements = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const timers = new Map();
  const downloads = [];
  const pendingSync = [];
  const pendingAuth = [];
  const syncWrites = [];
  const localWrites = [];
  let timerId = 0;
  let clock = 0;
  let syncReadCount = 0;
  const stored = {
    sync: { provider: 'claude', claudeKey: 'old-demo-key', claudeModel: 'claude-fable-5-1', ...config.sync },
    local: { ...config.local },
  };

  function addEvent(target, name, callback) {
    if (!target.has(name)) target.set(name, []);
    target.get(name).push(callback);
  }

  function element(selector) {
    if (!elements.has(selector)) {
      const events = new Map();
      const node = {
        value: '', checked: false, style: {}, textContent: '', className: '', type: '', children: [], files: [],
        addEventListener(name, callback) { addEvent(events, name, callback); },
        emit(name) { return Promise.all((events.get(name) || []).map(callback => callback({ target: node }))); },
        appendChild(option) {
          this.children.push(option);
          if (this.children.length === 1) this.value = option.value;
        },
        click() { return this.emit('click'); },
        set innerHTML(value) { this._html = value; if (selector === '#model') { this.children = []; this.value = ''; } },
        get innerHTML() { return this._html || ''; },
      };
      elements.set(selector, node);
    }
    return elements.get(selector);
  }
  // Represent actual form controls, including controls not reached after a read failure.
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const formNodes = [];
  for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = element('#' + match[3]);
    node.type = (/\btype="([^"]+)"/.exec(match[2]) || [])[1] || '';
    formNodes.push(node);
  }

  const runtime = { lastError: null, getManifest() { return { version: 'test' }; } };
  function withError(error, callback) {
    runtime.lastError = error ? { message: error } : null;
    try { callback(); } finally { runtime.lastError = null; }
  }
  const storage = {};
  for (const area of ['sync', 'local']) {
    storage[area] = {
      get(keys, callback) {
        if (area === 'sync' && ++syncReadCount === 1 && config.initialReadError) {
          withError(config.initialReadError, () => callback());
          return;
        }
        const result = {};
        for (const key of [].concat(keys)) if (key in stored[area]) result[key] = structuredClone(stored[area][key]);
        callback(result);
      },
      set(data, callback) { mutate(area, 'set', structuredClone(data), callback); },
      remove(keys, callback) { mutate(area, 'remove', [].concat(keys), callback); },
    };
  }
  function mutate(area, kind, data, callback) {
    const operation = {
      kind, data,
      finish(error) {
        if (!error) {
          if (kind === 'set') Object.assign(stored[area], structuredClone(data));
          else data.forEach(key => delete stored[area][key]);
        }
        withError(error, () => { if (callback) callback(); });
      },
    };
    if (kind === 'set' && area === 'sync') syncWrites.push(data);
    const authWrite = area === 'local' && (kind === 'set' ? 'chatgptAuth' in data : data.includes('chatgptAuth'));
    if (authWrite) localWrites.push(operation);
    if (area === 'sync' && kind === 'set' && config.deferSyncWrites) pendingSync.push(operation);
    else if (authWrite && config.deferAuthWrites) pendingAuth.push(operation);
    else operation.finish();
  }

  class TestURL extends URL {
    static createObjectURL(blob) { downloads.push(blob); return 'blob:test-settings'; }
    static revokeObjectURL() {}
  }
  const context = {
    URL: TestURL, Blob, console,
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    chrome: { runtime, storage, permissions: { remove(_query, callback) { if (callback) callback(true); } } },
    document: {
      visibilityState: 'visible',
      addEventListener(name, callback) { addEvent(documentEvents, name, callback); },
      querySelector: element,
      querySelectorAll() { return formNodes.filter(node => node.type !== 'file'); },
      getElementById(id) { return element('#' + id); },
      createElement(tag) { return tag === 'option' ? { value: '', textContent: '' } : { click() {} }; },
    },
    window: { addEventListener(name, callback) { addEvent(windowEvents, name, callback); } },
    location: { reload() {} },
    FileReader: class {
      readAsText(file) { this.result = file.content; this.onload(); }
    },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, deadline: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { throw new Error('Tests must not make network requests'); },
  };
  vm.createContext(context);
  for (const file of ['models.js', 'options.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  (documentEvents.get('DOMContentLoaded') || []).forEach(callback => callback());
  return {
    context, element, stored, downloads, pendingSync, pendingAuth, syncWrites, localWrites,
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.deadline <= clock) { timers.delete(id); timer.callback(); }
      }
      await Promise.resolve();
    },
    async paste(token) {
      element('#chatgptAuthPaste').value = JSON.stringify({ tokens: { access_token: token, refresh_token: 'dummy-refresh' } });
      await element('#chatgptAuthPaste').emit('input');
    },
    async importSettings(data) {
      element('#importFile').files = [{ content: JSON.stringify({ _meta: { version: 'AAtools' }, ...data }) }];
      await element('#importFile').emit('change');
    },
  };
}

test('clearing authorization cancels a pending paste and does not restore credentials', async () => {
  const loaded = loadOptionsEvents();
  await loaded.paste('pending-token');
  await loaded.element('#chatgptAuthClear').emit('click');
  await loaded.advance(600);
  assert.equal(loaded.stored.local.chatgptAuth, undefined);
  assert.equal(loaded.element('#chatgptAuthPaste').value, '');
  assert.equal(loaded.element('#chatgptAuthStatus').textContent, '未配置');
});

test('clearing during an in-flight authorization save removes its eventual result', async () => {
  const loaded = loadOptionsEvents({ deferAuthWrites: true });
  await loaded.paste('old-token');
  await loaded.advance(600);
  assert.equal(loaded.pendingAuth.length, 1);
  await loaded.element('#chatgptAuthClear').emit('click');
  loaded.pendingAuth.shift().finish();
  assert.equal(loaded.pendingAuth[0].kind, 'remove');
  loaded.pendingAuth.shift().finish();
  assert.equal(loaded.stored.local.chatgptAuth, undefined);
  assert.equal(loaded.element('#chatgptAuthStatus').textContent, '未配置');
});

test('a new paste after clearing survives stale save and clear callbacks', async () => {
  const loaded = loadOptionsEvents({ deferAuthWrites: true });
  await loaded.paste('old-token');
  await loaded.advance(600);
  await loaded.element('#chatgptAuthClear').emit('click');
  await loaded.paste('new-token');
  await loaded.advance(600);
  loaded.pendingAuth.shift().finish();
  assert.match(loaded.element('#chatgptAuthPaste').value, /new-token/);
  loaded.pendingAuth.shift().finish();
  assert.match(loaded.element('#chatgptAuthPaste').value, /new-token/);
  loaded.pendingAuth.shift().finish();
  assert.equal(loaded.stored.local.chatgptAuth.access_token, 'new-token');
  assert.equal(loaded.element('#chatgptAuthPaste').value, '');
});

test('authorization removal failure is reported instead of claiming success', async () => {
  const loaded = loadOptionsEvents({ deferAuthWrites: true, local: { chatgptAuth: { access_token: 'existing-token' } } });
  await loaded.element('#chatgptAuthClear').emit('click');
  loaded.pendingAuth.shift().finish('storage unavailable');
  assert.equal(loaded.stored.local.chatgptAuth.access_token, 'existing-token');
  assert.match(loaded.element('#status').textContent, /授权清除失败/);
});

test('export commits the visible form and waits for storage before downloading', async () => {
  const loaded = loadOptionsEvents({ deferSyncWrites: true });
  loaded.element('#currentKey').value = 'new-demo-key';
  await loaded.element('#currentKey').emit('input');
  const exportDone = loaded.element('#exportSettings').emit('click');
  assert.equal(loaded.pendingSync.length, 1);
  assert.equal(loaded.downloads.length, 0);
  loaded.pendingSync.shift().finish();
  await exportDone;
  assert.equal(JSON.parse(await loaded.downloads[0].text()).claudeKey, 'new-demo-key');
  await loaded.advance(1500);
  assert.equal(loaded.syncWrites.length, 1);
});

test('export does not download an old backup when saving fails', async () => {
  const loaded = loadOptionsEvents({ deferSyncWrites: true });
  loaded.element('#currentKey').value = 'new-demo-key';
  const exportDone = loaded.element('#exportSettings').emit('click');
  loaded.pendingSync.shift().finish('quota exceeded');
  await exportDone;
  assert.equal(loaded.downloads.length, 0);
  assert.equal(loaded.stored.sync.claudeKey, 'old-demo-key');
  assert.match(loaded.element('#status').textContent, /设置保存失败.*quota exceeded/);
});

test('export refuses to overwrite an import awaiting reload', async () => {
  const loaded = loadOptionsEvents();
  loaded.element('#currentKey').value = 'stale-ui-key';
  await loaded.element('#currentKey').emit('input');
  await loaded.importSettings({ claudeKey: 'imported-key', sub2apiBaseUrl: 'https://gateway.example' });
  await loaded.element('#exportSettings').emit('click');
  await loaded.advance(1500);
  assert.equal(loaded.stored.sync.claudeKey, 'imported-key');
  assert.equal(loaded.syncWrites.length, 1);
  assert.equal(loaded.downloads.length, 0);
});

test('export is blocked after the initial settings read failed', async () => {
  const loaded = loadOptionsEvents({ initialReadError: 'storage unavailable' });
  await loaded.element('#exportSettings').emit('click');
  assert.equal(loaded.syncWrites.length, 0);
  assert.equal(loaded.downloads.length, 0);
  assert.match(loaded.element('#status').textContent, /尚未加载/);
});

test('fetched OpenAI models exclude incompatible endpoint families', async () => {
  const loaded = loadOptionsEvents();
  loaded.context.fetch = async () => ({ ok: true, json: async () => ({ data: [
    { id: 'gpt-image-1' }, { id: 'gpt-5-pro' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' },
  ] }) });
  loaded.context.switchProvider('openai');
  loaded.element('#currentKey').value = 'dummy-key';
  await loaded.context.fetchLatestModels();
  assert.deepEqual(loaded.stored.local.fetchedModels_openai.map(model => model.value), ['gpt-6.1-sol']);
  assert.equal(loaded.element('#model').children.some(model => /gpt-image|gpt-5-pro|gpt-5\.6/.test(model.value)), false);
});


test('switching providers migrates older saved models and never adds them back', () => {
  const loaded = loadOptionsEvents({ sync: { provider: 'openai', openaiModel: 'gpt-5.6-sol' } });
  assert.equal(loaded.element('#model').value, 'gpt-6.1-sol');
  assert.equal(loaded.element('#model').children.some(model => model.value === 'gpt-5.6-sol'), false);
  loaded.context.switchProvider('claude');
  loaded.context.switchProvider('openai');
  assert.equal(loaded.element('#model').value, 'gpt-6.1-sol');
  assert.equal(loaded.element('#model').children.some(model => model.value === 'gpt-5.6-sol'), false);
});

test('Claude and Gemini model refreshes include subsequent pages', async () => {
  for (const provider of ['claude', 'gemini']) {
    const loaded = loadOptionsEvents();
    const requests = [];
    loaded.context.fetch = async (url) => {
      requests.push(new URL(url));
      const secondPage = requests.length === 2;
      const data = provider === 'claude'
        ? { data: [{ id: secondPage ? 'claude-opus-5-5' : 'claude-sonnet-5-5' }], has_more: !secondPage, last_id: 'claude-sonnet-5-5' }
        : { models: [{ name: secondPage ? 'models/gemini-3.5-flash-lite' : 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] }], ...(secondPage ? {} : { nextPageToken: 'next page+token' }) };
      return { ok: true, json: async () => data };
    };
    loaded.context.switchProvider(provider);
    loaded.element('#currentKey').value = 'dummy-key';
    await loaded.context.fetchLatestModels();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get(provider === 'claude' ? 'after_id' : 'pageToken'), provider === 'claude' ? 'claude-sonnet-5-5' : 'next page+token');
    assert.equal(loaded.stored.local['fetchedModels_' + provider].length, 2);
  }
});

test('a repeated model cursor fails without replacing the cached list', async () => {
  const loaded = loadOptionsEvents({ local: { fetchedModels_claude: [{ value: 'claude-opus-5-5', label: 'saved' }] } });
  let requests = 0;
  loaded.context.fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5' }], has_more: true, last_id: 'repeated' }) };
  };
  loaded.element('#currentKey').value = 'dummy-key';
  await loaded.context.fetchLatestModels();
  assert.equal(requests, 2);
  assert.deepEqual(loaded.stored.local.fetchedModels_claude.map(model => model.value), ['claude-opus-5-5']);
  assert.match(loaded.element('#status').textContent, /分页游标无效/);
});


test('startup migrates every stored provider model using only model-field writes', () => {
  const original = {
    provider: 'openai', claudeModel: 'claude-fable-5', openaiModel: 'gpt-5.6-sol',
    geminiModel: 'gemini-2.5-flash', minimaxModel: 'MiniMax-M2.7', deepseekModel: 'deepseek-v4-flash',
    kimiModel: 'kimi-k2.6', chatgptModel: 'gpt-5.6-luna', sub2apiModel: 'gemini-2.5-flash',
    model: 'gpt-5.6-sol', claudeKey: 'keep-claude-key', openaiKey: 'keep-openai-key',
    enableYoutube: false, enableTranslate: false, gestureKeepMenu: true, prompt: 'keep-custom-prompt',
  };
  const loaded = loadOptionsEvents({ sync: original });
  assert.equal(loaded.syncWrites.length, 1);
  assert.ok(Object.keys(loaded.syncWrites[0]).every(key => key === 'model' || /^[a-z0-9]+Model$/.test(key)));
  for (const [provider, catalog] of Object.entries(loaded.context.AATModels.providers)) {
    const field = provider + 'Model';
    assert.ok(catalog.models.some(model => model.value === loaded.stored.sync[field]), field);
    assert.notEqual(loaded.stored.sync[field], original[field], field);
  }
  assert.equal(loaded.stored.sync.model, loaded.stored.sync.openaiModel);
  for (const key of ['provider', 'claudeKey', 'openaiKey', 'enableYoutube', 'enableTranslate', 'gestureKeepMenu', 'prompt']) {
    assert.equal(loaded.stored.sync[key], original[key], key);
  }
});

test('legacy model-only settings migrate to a current provider-specific field', () => {
  const loaded = loadOptionsEvents({ sync: { provider: 'openai', model: 'gpt-5.6-sol' } });
  assert.equal(loaded.stored.sync.openaiModel, 'gpt-6.1-sol');
  assert.equal(loaded.stored.sync.model, 'gpt-6.1-sol');
  assert.equal(loaded.element('#model').value, 'gpt-6.1-sol');
});

test('startup, import, and export remove old fetched model cache entries on disk', async () => {
  const loaded = loadOptionsEvents({ local: { fetchedModels_openai: [
    { value: 'gpt-5.6-sol', label: 'old' }, { value: 'gpt-6.1-sol', label: 'current' },
  ] } });
  assert.deepEqual(loaded.stored.local.fetchedModels_openai.map(model => model.value), ['gpt-6.1-sol']);
  // Simulate another stale cache write after initialization; export must sanitize it too.
  loaded.stored.local.fetchedModels_openai.push({ value: 'gpt-5.6-luna', label: 'old-luna' });
  await loaded.element('#exportSettings').emit('click');
  const exported = JSON.parse(await loaded.downloads[0].text());
  assert.deepEqual(exported.fetchedModels_openai.map(model => model.value), ['gpt-6.1-sol']);
  assert.deepEqual(loaded.stored.local.fetchedModels_openai.map(model => model.value), ['gpt-6.1-sol']);

  await loaded.importSettings({
    provider: 'chatgpt', chatgptModel: 'gpt-5.6-luna', model: 'gpt-5.6-luna', openaiKey: 'imported-key',
    fetchedModels_openai: [{ value: 'gpt-5.6-sol', label: 'old' }, { value: 'gpt-6.1-sol', label: 'current' }],
  });
  assert.equal(loaded.stored.sync.chatgptModel, 'gpt-6-luna');
  assert.equal(loaded.stored.sync.model, 'gpt-6-luna');
  assert.equal(loaded.stored.sync.openaiKey, 'imported-key');
  assert.deepEqual(loaded.stored.local.fetchedModels_openai.map(model => model.value), ['gpt-6.1-sol']);
});

test('an online response containing only old models clears the cache without adding old options', async () => {
  const loaded = loadOptionsEvents();
  loaded.context.switchProvider('openai');
  loaded.element('#currentKey').value = 'dummy-key';
  loaded.context.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-5.6-sol' }] }) });
  await loaded.context.fetchLatestModels();
  assert.deepEqual(loaded.stored.local.fetchedModels_openai, []);
  assert.deepEqual(loaded.element('#model').children.map(model => model.value),
    Array.from(loaded.context.AATModels.providers.openai.models, model => model.value));
});

test('saving upgrades inactive provider caches and falls back for unknown model IDs', async () => {
  const loaded = loadOptionsEvents();
  vm.runInContext("modelCache.openai = 'gpt-5.6-sol'; modelCache.gemini = 'unrecognized-model';", loaded.context);
  await loaded.context.saveSettings(false);
  assert.equal(loaded.stored.sync.openaiModel, 'gpt-6.1-sol');
  assert.equal(loaded.stored.sync.geminiModel, loaded.context.AATModels.defaults.gemini);
});
