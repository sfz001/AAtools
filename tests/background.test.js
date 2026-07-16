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
  let permissionAllowed = options.permissionAllowed !== false;
  const sentMessages = [];
  const fetchCalls = [];
  const tabListeners = {};
  const context = {
    AbortController,
    DOMException,
    Map,
    Promise,
    Set,
    TextDecoder,
    URL,
    clearInterval,
    clearTimeout,
    console,
    fetch(...args) {
      fetchCalls.push(args);
      if (!options.fetch) throw new Error('Unexpected fetch');
      return options.fetch(...args);
    },
    indexedDB: options.indexedDB || createFakeIndexedDB(),
    setInterval,
    setTimeout,
    chrome: {
      permissions: {
        contains(query, callback) {
          if (options.permissionContains) options.permissionContains(query, callback);
          else callback(permissionAllowed);
        },
      },
      runtime: {
        id: 'test-extension',
        lastError: null,
        getPlatformInfo(callback) { if (callback) callback({ os: 'mac' }); },
        onMessage: {
          addListener(listener) { messageListener = listener; },
        },
      },
      tabs: {
        onRemoved: { addListener(listener) { tabListeners.removed = listener; } },
        onUpdated: { addListener(listener) { tabListeners.updated = listener; } },
        sendMessage(tabId, message) {
          sentMessages.push({ tabId, message });
          return Promise.resolve();
        },
      },
    },
  };
  if (options.storageGet) {
    context.chrome.storage = { sync: { get: options.storageGet } };
  }
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
    sentMessages,
    tabListeners,
    setPermissionAllowed(value) { permissionAllowed = value; },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('SSE parser handles CRLF boundaries, compact data fields, multiline data, and EOF', () => {
  const { context } = loadBackground();
  const events = [];
  const parser = context.createSSEParser((event) => events.push(event));

  parser.push('\uFEFFevent: custom\r');
  parser.push('\ndata:first\r\ndata: second\r\n: heartbeat\r\n\r\ndata:last');
  parser.finish();

  assert.deepEqual(plain(events), [
    { event: 'custom', data: 'first\nsecond' },
    { event: 'message', data: 'last' },
  ]);
});

test('provider payload analysis distinguishes text, errors, and abnormal finishes', () => {
  const { context } = loadBackground();

  assert.equal(context.analyzeStreamPayload('openai', {
    choices: [{ delta: { content: 'hello' }, finish_reason: null }],
  }, 'message').text, 'hello');
  assert.match(context.analyzeStreamPayload('openai', {
    choices: [{ delta: {}, finish_reason: 'length' }],
  }, 'message').abnormal, /finish_reason=length/);
  assert.equal(context.analyzeStreamPayload('openai-responses', {
    type: 'response.output_text.delta', delta: 'world',
  }, 'response.output_text.delta').text, 'world');
  assert.match(context.analyzeStreamPayload('claude', {
    type: 'error', error: { message: 'bad stream' },
  }, 'error').error, /bad stream/);
  assert.match(context.analyzeStreamPayload('gemini', {
    promptFeedback: { blockReason: 'SAFETY' },
  }, 'message').error, /SAFETY/);
  assert.match(context.analyzeStreamPayload('minimax', {
    base_resp: { status_code: 1001, status_msg: 'denied' },
  }, 'message').error, /denied/);
});

test('stream consumer requires meaningful text and a normal terminal event', async () => {
  const { context } = loadBackground();
  const encoder = new TextEncoder();

  function responseFor(chunks) {
    let index = 0;
    return {
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
            async cancel() {},
          };
        },
      },
    };
  }

  function requestContext() {
    const controller = new AbortController();
    return { signal: controller.signal, markActivity() {} };
  }

  const output = [];
  const ok = await context.consumeSSEStream(responseFor([
    'data:{"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\ndata: not-json-after-terminal\r\n\r\n',
  ]), 'openai', requestContext(), (text) => output.push(text));
  assert.equal(ok.error, '');
  assert.deepEqual(output, ['hello']);

  const interrupted = await context.consumeSSEStream(responseFor([
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
  ]), 'openai', requestContext(), () => {});
  assert.match(interrupted.error, /意外中断/);

  const empty = await context.consumeSSEStream(responseFor(['data: [DONE]\n\n']), 'openai', requestContext(), () => {});
  assert.match(empty.error, /未返回任何文本/);
});

test('truncated streams keep the partial text as a warning instead of an error', async () => {
  const { context } = loadBackground();
  const encoder = new TextEncoder();

  function responseFor(chunks) {
    let index = 0;
    return {
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(chunks[index++]) };
            },
            async cancel() {},
          };
        },
      },
    };
  }

  function requestContext() {
    const controller = new AbortController();
    return { signal: controller.signal, markActivity() {} };
  }

  // OpenAI finish_reason=length：已有文本 → 部分结果保留，warning 而非 error
  const openaiOutput = [];
  const openaiTruncated = await context.consumeSSEStream(responseFor([
    'data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
  ]), 'openai', requestContext(), (text) => openaiOutput.push(text));
  assert.equal(openaiTruncated.error, '');
  assert.match(openaiTruncated.warning, /finish_reason=length/);
  assert.deepEqual(openaiOutput, ['partial answer']);

  // Gemini MAX_TOKENS：长视频转录撞输出上限时必须保留已转录文本
  const geminiOutput = [];
  const geminiTruncated = await context.consumeSSEStream(responseFor([
    'data: {"candidates":[{"content":{"parts":[{"text":"0:01 hello"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
  ]), 'gemini', requestContext(), (text) => geminiOutput.push(text));
  assert.equal(geminiTruncated.error, '');
  assert.match(geminiTruncated.warning, /MAX_TOKENS/);
  assert.deepEqual(geminiOutput, ['0:01 hello']);

  // 异常结束且没有任何文本时仍然作为错误上抛
  const emptyTruncated = await context.consumeSSEStream(responseFor([
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
  ]), 'openai', requestContext(), () => {});
  assert.match(emptyTruncated.error, /finish_reason=length/);
});

test('stream emitter sends exactly one terminal message', () => {
  const { context } = loadBackground();
  const sent = [];
  const emitter = context.createStreamEmitter((message) => sent.push(message), 'SUMMARY');
  emitter.chunk('a');
  emitter.error('failed');
  emitter.done();
  emitter.chunk('late');

  assert.deepEqual(plain(sent), [
    { type: 'SUMMARY_CHUNK', text: 'a' },
    { type: 'SUMMARY_ERROR', error: 'failed' },
  ]);
});

test('custom gateway validation enforces HTTPS and exact-origin authorization', async () => {
  const loaded = loadBackground();
  const { context } = loaded;

  const valid = context.validateSub2ApiBase('https://gateway.example/v1/responses/');
  assert.equal(valid.baseUrl, 'https://gateway.example');
  assert.equal(valid.permissionOrigin, 'https://gateway.example/*');
  assert.equal(context.validateSub2ApiBase('http://localhost:8787/api').baseUrl, 'http://localhost:8787/api');
  assert.match(context.validateSub2ApiBase('http://gateway.example').error, /HTTPS/);
  assert.match(context.validateSub2ApiBase('https://user:pass@gateway.example').error, /用户名或密码/);
  assert.match(context.validateSub2ApiBase('https://gateway.example?token=secret').error, /查询参数/);

  assert.equal(await context.hasGatewayPermission(valid.permissionOrigin), true);
  loaded.setPermissionAllowed(false);
  assert.equal(await context.hasGatewayPermission(valid.permissionOrigin), false);
});

test('provider config read failures resolve to visible errors instead of hanging', async () => {
  const loaded = loadBackground();
  const config = await loaded.context.loadProviderConfig('claude');
  assert.match(config.error, /读取扩展设置失败|undefined/);

  await loaded.context.handleSummarize({
    provider: 'claude', requestId: 'settings-error', transcript: 'text', prompt: '{transcript}',
  }, 5, 'SUMMARY');
  assert.equal(loaded.sentMessages[0].message.type, 'SUMMARY_ERROR');
  assert.match(loaded.sentMessages[0].message.error, /读取扩展设置失败/);
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
  });
  assert.equal(denied.fetchCalls.length, 0);
  assert.match(denied.sentMessages[0].message.error, /尚未授权/);

  const encoder = new TextEncoder();
  const approved = loadBackground({
    fetch: async () => {
      let read = false;
      return {
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                if (read) return { done: true, value: undefined };
                read = true;
                return {
                  done: false,
                  value: encoder.encode(
                    'event: content_block_delta\n' +
                    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                  ),
                };
              },
              async cancel() {},
            };
          },
        },
      };
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
  });
  assert.equal(approved.fetchCalls[0][0], 'https://gateway.example:8443/v1/messages');
  assert.deepEqual(approved.sentMessages.map(item => item.message.type), [
    'SUMMARY_MODEL', 'SUMMARY_CHUNK', 'SUMMARY_DONE',
  ]);
});

test('request registry cancels active and not-yet-registered work and keeps references balanced', async () => {
  const { context, tabListeners } = loadBackground();
  const first = context.createActiveRequest({ tabId: 3, requestId: 'first', kind: 'summary', totalMs: 1000 });
  const second = context.createActiveRequest({ tabId: 3, requestId: 'second', kind: 'chat', totalMs: 1000 });
  assert.equal(vm.runInContext('keepaliveRefCount', context), 2);

  const cancelled = context.cancelRequestsForTab(3, 'first');
  assert.equal(cancelled.cancelled, 1);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.abortReason.code, 'cancelled');
  first.cleanup();
  assert.equal(vm.runInContext('keepaliveRefCount', context), 1);

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
  assert.equal(vm.runInContext('keepaliveRefCount', context), 0);
});

test('navigation and tab close invalidate provider work still waiting for configuration', async () => {
  for (const lifecycleEvent of ['updated', 'removed']) {
    let releaseConfig;
    const loaded = loadBackground({
      storageGet(_fields, callback) {
        releaseConfig = () => callback({ claudeKey: 'secret', claudeModel: 'claude-sonnet-5' });
      },
      fetch: async () => { throw new Error('stale work must not fetch'); },
    });

    const work = loaded.context.handleSummarize({
      provider: 'claude', requestId: `stale-${lifecycleEvent}`, transcript: 'text', prompt: '{transcript}',
    }, 42, 'SUMMARY');
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
    permissionContains(_query, callback) { releasePermission = () => callback(true); },
    fetch: async () => { throw new Error('stale work must not fetch'); },
  });
  const work = loaded.context.callProvider('sub2api', {
    key: 'secret', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 128, tabId: 12, PREFIX: 'SUMMARY', requestId: 'permission-race',
    baseUrl: 'https://gateway.example', model: 'claude-sonnet-5', navigationEpoch: 0,
  });
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
    fetch: async () => ({
      ok: true,
      async json() { return { events: [{ tStartMs: 1000, segs: [{ utf8: 'new transcript' }] }] }; },
    }),
  });
  loaded.context.location = { href: `https://www.youtube.com/watch?v=${targetVideoId}` };
  loaded.context.document = { querySelector(selector) { return selector === '#movie_player' ? player : null; } };
  loaded.context.performance = {
    now() { return 1; },
    getEntriesByType() {
      return [{ name: `https://www.youtube.com/api/timedtext?v=${targetVideoId}&pot=test&fmt=json3` }];
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
    queueMicrotask(callback);
    return 1;
  };

  const result = await loaded.context.scrapeTranscriptFromDOM(targetVideoId);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.segments[0].text, 'new panel transcript');
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

test('extension cache merges legacy data without overwriting newer extension values', async () => {
  const { context } = loadBackground();
  const videoId = 'abcdefghijk';

  await context.cacheSaveFeature(videoId, 'summary', { text: 'new summary' });
  await context.cacheMergeLegacyRecord({
    videoId,
    summary: { text: 'old summary' },
    cards: { data: [{ front: 'Q', back: 'A' }] },
    updatedAt: Date.now() + 1000,
    ignored: '<script>not migrated</script>',
  });

  const merged = plain(await context.cacheLoadRecord(videoId));
  assert.equal(merged.summary.text, 'new summary');
  assert.equal(merged.cards.data[0].front, 'Q');
  assert.equal('ignored' in merged, false);

  // 旧标签在首次迁移后又更新了一个 legacy-owned 字段：允许刷新该字段，
  // 但新版扩展生成过的 summary 仍然优先。
  await context.cacheMergeLegacyRecord({
    videoId,
    summary: { text: 'still old' },
    cards: { data: [{ front: 'Q2', back: 'A2' }] },
    updatedAt: Date.now() + 2000,
  });
  const refreshedLegacy = plain(await context.cacheLoadRecord(videoId));
  assert.equal(refreshedLegacy.summary.text, 'new summary');
  assert.equal(refreshedLegacy.cards.data[0].front, 'Q2');

  // 新版中重新生成 cards 后，该字段也不再接受旧标签覆盖。
  await context.cacheSaveFeature(videoId, 'cards', { data: [{ front: 'new Q', back: 'new A' }] });
  await context.cacheMergeLegacyRecord({
    videoId,
    cards: { data: [{ front: 'legacy Q3', back: 'legacy A3' }] },
    updatedAt: Date.now() + 3000,
  });
  assert.equal((await context.cacheLoadRecord(videoId)).cards.data[0].front, 'new Q');

  await context.cacheRemoveRecord(videoId);
  assert.equal(await context.cacheLoadRecord(videoId), null);

  await context.cacheSaveFeature(videoId, 'vocab', { data: [] });
  await context.cacheClearRecords();
  assert.equal(await context.cacheLoadRecord(videoId), null);
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
  assert.deepEqual(plain(accepted), { ok: true, record: null });
});
