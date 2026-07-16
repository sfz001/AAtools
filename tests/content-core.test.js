'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createLegacyIndexedDB(records) {
  const storedRecords = structuredClone(records);
  const stats = { deleteCount: 0, deletedRecordIds: [], openCount: 0 };
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
              const request = { result: null, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                request.result = structuredClone(storedRecords);
                if (request.onsuccess) request.onsuccess();
              });
              return request;
            },
            get(videoId) {
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
      const request = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        databaseExists = false;
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

test('unchanged legacy cache records are removed only after every record is acknowledged', async () => {
  const records = [
    { videoId: 'abcdefghijk', summary: { text: 'one' } },
    { videoId: 'lmnopqrstuv', summary: { text: 'two' } },
  ];
  const legacy = createLegacyIndexedDB(records);
  const loaded = loadCore({
    indexedDB: legacy,
    responseFor(message) {
      if (message.type === 'CACHE_LOAD') return { ok: true, record: null };
      return { ok: true };
    },
  });

  assert.equal(await loaded.context.YTX.cache.load('abcdefghijk'), null);
  assert.deepEqual(loaded.messages.map(message => message.type), [
    'CACHE_MIGRATE_RECORD', 'CACHE_MIGRATE_RECORD', 'CACHE_LOAD',
  ]);
  assert.equal(legacy.stats.deleteCount, 0);
  assert.deepEqual(legacy.stats.deletedRecordIds, ['abcdefghijk', 'lmnopqrstuv']);

  const migrationOpenCount = legacy.stats.openCount;
  await loaded.context.YTX.cache.save('abcdefghijk', 'summary', { text: 'new' });
  assert.equal(legacy.stats.openCount, migrationOpenCount, 'daily cache writes must not reopen page-origin IndexedDB');
});

test('failed legacy acknowledgement preserves the old database but does not block new cache', async () => {
  const legacy = createLegacyIndexedDB([
    { videoId: 'abcdefghijk', summary: { text: 'one' } },
    { videoId: 'lmnopqrstuv', summary: { text: 'two' } },
  ]);
  let migrationCount = 0;
  const loaded = loadCore({
    indexedDB: legacy,
    responseFor(message) {
      if (message.type === 'CACHE_MIGRATE_RECORD') {
        migrationCount++;
        return migrationCount === 2 ? { ok: false, error: 'write failed' } : { ok: true };
      }
      if (message.type === 'CACHE_LOAD') return { ok: true, record: { videoId: message.videoId } };
      return { ok: true };
    },
  });

  const record = await loaded.context.YTX.cache.load('abcdefghijk');
  assert.equal(record.videoId, 'abcdefghijk');
  assert.equal(legacy.stats.deleteCount, 0);
  assert.equal(loaded.messages.at(-1).type, 'CACHE_LOAD');

  assert.equal(await loaded.context.YTX.cache.remove('abcdefghijk'), true);
  assert.deepEqual(legacy.stats.deletedRecordIds, ['abcdefghijk']);
});

test('legacy records updated during migration are retained for the next migration', async () => {
  const legacy = createLegacyIndexedDB([
    { videoId: 'abcdefghijk', summary: { text: 'old' }, updatedAt: 1 },
    { videoId: 'lmnopqrstuv', summary: { text: 'stable' }, updatedAt: 1 },
  ]);
  const loaded = loadCore({
    indexedDB: legacy,
    responseFor(message) {
      if (message.type === 'CACHE_MIGRATE_RECORD' && message.record.videoId === 'abcdefghijk') {
        legacy.replaceRecord({ videoId: 'abcdefghijk', summary: { text: 'new' }, updatedAt: 2 });
      }
      if (message.type === 'CACHE_LOAD') return { ok: true, record: null };
      return { ok: true };
    },
  });

  await loaded.context.YTX.cache.load('abcdefghijk');
  assert.deepEqual(legacy.stats.deletedRecordIds, ['lmnopqrstuv']);
  assert.equal(legacy.records()[0].summary.text, 'new');
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
        generateAllCards: false,
        generateAllVocab: false,
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
