'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createLegacyIndexedDB(records, { deleteMode = 'success' } = {}) {
  const storedRecords = structuredClone(records);
  const stats = { deleteAttempts: 0, deleteCount: 0, deletedRecordIds: [], getAllCount: 0, getCount: 0, openCount: 0 };
  let databaseExists = true;
  const db = {
    objectStoreNames: { contains(name) { return name === 'results'; } },
    transaction() {
      const tx = {
        onabort: null,
        oncomplete: null,
        onerror: null,
        objectStore() {
          return {
            getAll() {
              stats.getAllCount++;
              const request = { result: null, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                request.result = structuredClone(storedRecords);
                if (request.onsuccess) request.onsuccess();
              });
              return request;
            },
            get(videoId) {
              stats.getCount++;
              const request = { result: null, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                const record = storedRecords.find(item => item.videoId === videoId);
                request.result = record ? structuredClone(record) : undefined;
                if (request.onsuccess) request.onsuccess();
              });
              return request;
            },
            delete(videoId) {
              const request = { error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                const index = storedRecords.findIndex(record => record.videoId === videoId);
                if (index >= 0) storedRecords.splice(index, 1);
                stats.deletedRecordIds.push(videoId);
                if (request.onsuccess) request.onsuccess();
                queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
              });
              return request;
            },
          };
        },
      };
      return tx;
    },
    close() {},
  };

  return {
    stats,
    records() { return structuredClone(storedRecords); },
    replaceRecord(record) {
      const index = storedRecords.findIndex(item => item.videoId === record.videoId);
      if (index >= 0) storedRecords[index] = structuredClone(record);
      else storedRecords.push(structuredClone(record));
    },
    databases() { return Promise.resolve(databaseExists ? [{ name: 'AAtoolsCache', version: 1 }] : []); },
    open() {
      stats.openCount++;
      const request = {
        result: db,
        transaction: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => { if (request.onsuccess) request.onsuccess(); });
      return request;
    },
    deleteDatabase() {
      stats.deleteAttempts++;
      const request = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (deleteMode === 'blocked') {
          if (request.onblocked) request.onblocked();
          return;
        }
        if (deleteMode === 'error') {
          if (request.onerror) request.onerror();
          return;
        }
        databaseExists = false;
        storedRecords.length = 0;
        stats.deleteCount++;
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

function loadCore({ indexedDB, responseFor, storageGet } = {}) {
  const messages = [];
  const runtime = {
    id: 'test-extension',
    lastError: null,
    sendMessage(message, callback) {
      messages.push(message);
      queueMicrotask(() => callback(responseFor ? responseFor(message) : { ok: true }));
    },
  };
  const document = {
    createElement() {
      return {
        className: '',
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); child.parentNode = this; },
      };
    },
  };
  const context = {
    URL,
    chrome: {
      runtime,
      storage: {
        sync: {
          get(keys, callback) {
            if (storageGet) storageGet(keys, callback, runtime);
            else queueMicrotask(() => callback({}));
          },
        },
      },
    },
    clearInterval,
    clearTimeout,
    console,
    document,
    indexedDB,
    isFinite,
    setInterval,
    setTimeout,
    window: { scrollTo() {} },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'core.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'youtube/core.js' });
  return { context, messages, runtime };
}

test('startup deletes the page-origin legacy database without opening or reading values', async () => {
  const records = [
    { videoId: 'abcdefghijk', summary: { text: 'one' } },
    { videoId: 'lmnopqrstuv', summary: { text: 'two' } },
  ];
  const legacy = createLegacyIndexedDB(records);
  const loaded = loadCore({
    indexedDB: legacy,
    responseFor(message) {
      if (message.type === 'CACHE_EPOCH') return { ok: true, epoch: 1 };
      if (message.type === 'CACHE_LOAD') return { ok: true, record: null, epoch: 1 };
      return { ok: true };
    },
  });

  assert.equal(await loaded.context.YTX.cache.load('abcdefghijk'), null);
  assert.deepEqual(loaded.messages.map(message => message.type), [
    'CACHE_EPOCH', 'CACHE_LOAD',
  ]);
  await loaded.context.YTX.cache.save('abcdefghijk', 'summary', { text: 'new' });
  assert.deepEqual(loaded.messages.map(message => message.type), ['CACHE_EPOCH', 'CACHE_LOAD', 'CACHE_SAVE']);
  assert.equal(loaded.messages.at(-1).epoch, 1);
  assert.equal(legacy.stats.openCount, 0);
  assert.equal(legacy.stats.getAllCount, 0);
  assert.equal(legacy.stats.getCount, 0);
  assert.equal(legacy.stats.deleteAttempts, 1);
  assert.equal(legacy.stats.deleteCount, 1);
  assert.deepEqual(legacy.stats.deletedRecordIds, []);
  assert.deepEqual(legacy.records(), []);
});

test('explicit remove reuses whole-database legacy cleanup and never reads a value', async () => {
  const legacy = createLegacyIndexedDB([
    { videoId: 'abcdefghijk', summary: { text: 'one' } },
    { videoId: 'lmnopqrstuv', summary: { text: 'two' } },
  ]);
  const loaded = loadCore({
    indexedDB: legacy,
    responseFor(message) {
      if (message.type === 'CACHE_EPOCH') return { ok: true, epoch: 1 };
      return { ok: true };
    },
  });

  assert.equal(await loaded.context.YTX.cache.remove('abcdefghijk'), true);
  assert.deepEqual(loaded.messages.map(message => message.type), ['CACHE_EPOCH', 'CACHE_REMOVE']);
  assert.equal(loaded.messages.at(-1).epoch, 1);
  assert.equal(legacy.stats.openCount, 0);
  assert.equal(legacy.stats.getAllCount, 0);
  assert.equal(legacy.stats.getCount, 0);
  assert.equal(legacy.stats.deleteAttempts, 1);
  assert.deepEqual(legacy.stats.deletedRecordIds, []);
  assert.deepEqual(legacy.records(), []);
});

test('legacy cleanup is idempotent for the content-script lifecycle', async () => {
  const legacy = createLegacyIndexedDB([
    { videoId: 'abcdefghijk', summary: { text: 'old' }, updatedAt: 1 },
    { videoId: 'lmnopqrstuv', summary: { text: 'stable' }, updatedAt: 1 },
  ]);
  const loaded = loadCore({ indexedDB: legacy });

  assert.equal(await loaded.context.YTX.cache.cleanupLegacy(), true);
  assert.equal(await loaded.context.YTX.cache.cleanupLegacy(), true);
  assert.equal(legacy.stats.openCount, 0);
  assert.equal(legacy.stats.getAllCount, 0);
  assert.equal(legacy.stats.getCount, 0);
  assert.equal(legacy.stats.deleteAttempts, 1);
  assert.equal(legacy.stats.deleteCount, 1);
  assert.deepEqual(legacy.stats.deletedRecordIds, []);
  assert.deepEqual(legacy.records(), []);
});

test('blocked or failed legacy deletion never blocks background cache access', async () => {
  for (const deleteMode of ['blocked', 'error']) {
    const legacy = createLegacyIndexedDB([
      { videoId: 'abcdefghijk', summary: { text: 'old' } },
    ], { deleteMode });
    const loaded = loadCore({
      indexedDB: legacy,
      responseFor(message) {
        if (message.type === 'CACHE_EPOCH') return { ok: true, epoch: 1 };
        if (message.type === 'CACHE_LOAD') return { ok: true, record: null, epoch: 1 };
        return { ok: true };
      },
    });

    assert.equal(await loaded.context.YTX.cache.load('abcdefghijk'), null);
    assert.deepEqual(loaded.messages.map(message => message.type), ['CACHE_EPOCH', 'CACHE_LOAD']);
    assert.equal(legacy.stats.deleteAttempts, 1);
    assert.equal(legacy.stats.openCount, 0);
    assert.equal(legacy.stats.getAllCount, 0);
    assert.equal(legacy.stats.getCount, 0);
  }
});

test('a content-script lifecycle captures one epoch before load and never adopts a post-clear epoch', async () => {
  const loaded = loadCore({
    indexedDB: createLegacyIndexedDB([]),
    responseFor(message) {
      if (message.type === 'CACHE_EPOCH') return { ok: true, epoch: 7 };
      if (message.type === 'CACHE_LOAD') return { ok: true, record: null, epoch: 8 };
      if (message.type === 'CACHE_SAVE') {
        return message.epoch === 7
          ? { ok: false, stale: true, epoch: 8, error: '缓存代际已变化' }
          : { ok: true, epoch: 8 };
      }
      return { ok: true };
    },
  });

  assert.equal(await loaded.context.YTX.cache.captureEpoch(), 7);
  assert.equal(await loaded.context.YTX.cache.save('abcdefghijk', 'summary', { text: 'old work' }), false);
  assert.equal(await loaded.context.YTX.cache.load('abcdefghijk'), null);
  assert.equal(await loaded.context.YTX.cache.save('abcdefghijk', 'html', { text: 'still old work' }), false);
  const saves = loaded.messages.filter(message => message.type === 'CACHE_SAVE');
  assert.deepEqual(saves.map(message => message.epoch), [7, 7]);
});

test('renderError treats remote-looking text as text, not markup', () => {
  const loaded = loadCore();
  const container = loaded.context.document.createElement('div');
  const payload = '<img src=x onerror=alert(1)> upstream failed';

  const error = loaded.context.YTX.renderError(container, payload);
  assert.equal(container.children.length, 1);
  assert.equal(error.textContent, payload);
  assert.equal(error.className, 'ytx-error');
});

test('getSettings rejects runtime storage errors instead of hanging', async () => {
  const loaded = loadCore({
    storageGet(_keys, callback, runtime) {
      queueMicrotask(() => {
        runtime.lastError = { message: 'storage unavailable' };
        callback(undefined);
        runtime.lastError = null;
      });
    },
  });

  await assert.rejects(loaded.context.YTX.getSettings(), /storage unavailable/);
});

test('generate-all invalidation prevents an old same-video run from starting features', async () => {
  const loaded = loadCore({
    storageGet(_keys, callback) {
      queueMicrotask(() => callback({
        generateAllSummary: true,
        generateAllMindmap: false,
        generateAllHtml: false,
      }));
    },
  });
  const allButton = { blur() {}, disabled: false, innerHTML: '' };
  loaded.context.YTX.panel = {
    querySelector(selector) { return selector === '#ytx-generate-all' ? allButton : null; },
  };
  loaded.context.YTX.currentVideoId = 'abcdefghijk';
  let resolveTranscript;
  loaded.context.YTX.ensureTranscript = () => new Promise(resolve => { resolveTranscript = resolve; });
  let starts = 0;
  loaded.context.YTX.features.summary = {
    isGenerating: false,
    start() { starts++; return Promise.resolve(); },
  };

  const work = loaded.context.YTX.generateAll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveTranscript, 'function');
  loaded.context.YTX._generateAllToken = null;
  allButton.disabled = false;
  allButton.innerHTML = 'reset-state';
  resolveTranscript();
  await work;

  assert.equal(starts, 0);
  assert.equal(allButton.innerHTML, 'reset-state');
});

test('timestamp parsing supports long videos and rejects invalid minute/second fields', () => {
  const loaded = loadCore();
  const { YTX } = loaded.context;

  assert.equal(YTX.fmtTime(6000), '100:00');
  assert.equal(YTX.parseTime('100:00'), 6000);
  assert.equal(YTX.parseTime('1:40:00'), 6000);
  assert.equal(YTX.safeTime('1:40:00'), '100:00');
  assert.equal(YTX.safeTime('12:99'), null);
  assert.equal(YTX.safeTime('1:60:00'), null);
  assert.equal(YTX.safeTime('not-a-time'), null);
});

test('subtitle request watchdog rejects a background message channel that never settles', async () => {
  const loaded = loadCore();
  loaded.context.YTX.FETCH_TRANSCRIPT_WATCHDOG_MS = 5;
  loaded.context.YTX.currentVideoId = 'abcdefghijk';
  loaded.context.YTX.sendToBg = function () { return new Promise(function () {}); };
  await assert.rejects(loaded.context.YTX.fetchTranscript(), /等待超时/);
});

test('Gemini transcript mode commits only on success and applies the shared size limit', async () => {
  const oversized = 'line\n'.repeat(50000);
  const loaded = loadCore({
    responseFor(message) {
      if (message.type === 'TRANSCRIBE_VIDEO') return { started: true, requestId: message.requestId };
      return { ok: true };
    },
  });
  const { YTX } = loaded.context;
  loaded.context.document.querySelector = () => null;
  loaded.context.document.querySelectorAll = () => [];
  YTX.currentVideoId = 'abcdefghijk';
  YTX._transcriptGeneration = 1;

  const success = YTX._analyzeVideoWithGemini(1);
  await new Promise(resolve => setImmediate(resolve));
  const successRequest = loaded.messages.find(message => message.type === 'TRANSCRIBE_VIDEO');
  YTX.settleTranscribeDeferred(successRequest.requestId, null, oversized, {});
  await success;
  assert.equal(YTX.videoMode, true);
  assert.equal(YTX.transcriptData.truncated, true);
  assert.match(YTX.transcriptData.full, /字幕过长，已截断/);
  assert.ok(YTX.transcriptData.full.length < oversized.length);

  const failed = loadCore({
    responseFor(message) {
      if (message.type === 'TRANSCRIBE_VIDEO') return { started: true, requestId: message.requestId };
      return { ok: true };
    },
  });
  failed.context.document.querySelector = () => null;
  failed.context.document.querySelectorAll = () => [];
  failed.context.YTX.currentVideoId = 'abcdefghijk';
  failed.context.YTX._transcriptGeneration = 1;
  const failure = failed.context.YTX._analyzeVideoWithGemini(1);
  await new Promise(resolve => setImmediate(resolve));
  const failedRequest = failed.messages.find(message => message.type === 'TRANSCRIBE_VIDEO');
  failed.context.YTX.settleTranscribeDeferred(failedRequest.requestId, new Error('transcription failed'));
  await assert.rejects(failure, /transcription failed/);
  assert.equal(failed.context.YTX.videoMode, false);
});
