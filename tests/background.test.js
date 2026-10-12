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
    atob(value) { return Buffer.from(value, 'base64').toString('binary'); },
    crypto: require('node:crypto'),
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
    setTimeout: options.setTimeout || setTimeout,
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
        onInstalled: { addListener() {} },
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
      webNavigation: {
        onBeforeNavigate: { addListener(listener) { tabListeners.navigated = listener; } },
      },
    },
  };
  if (options.storageGet) {
    context.chrome.storage = { sync: { get: options.storageGet } };
  }
  if (options.localStorage) {
    context.chrome.storage = context.chrome.storage || {};
    context.chrome.storage.local = {
      get(_fields, callback) { callback({ chatgptAuth: options.localStorage.chatgptAuth }); },
      set(value, callback) { Object.assign(options.localStorage, value); callback(); },
    };
  }
  if (options.executeScript) {
    context.chrome.scripting = { executeScript: options.executeScript };
  }
  vm.createContext(context);
  context.importScripts = (...files) => {
    for (const file of files) {
      if (file !== 'models.js') throw new Error('Unexpected importScripts: ' + file);
      const modelSource = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      vm.runInContext(modelSource, context, { filename: file });
    }
  };
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
  assert.equal(context.analyzeStreamPayload('deepseek', {
    choices: [{ delta: { content: '你好' }, finish_reason: null }],
  }, 'message').text, '你好');
  // deepseek thinking 模式思考阶段只有 reasoning_content，不应产出正文
  assert.equal(context.analyzeStreamPayload('deepseek', {
    choices: [{ delta: { reasoning_content: 'thinking...', content: null }, finish_reason: null }],
  }, 'message').text, '');
  assert.equal(context.analyzeStreamPayload('deepseek', {
    choices: [{ delta: {}, finish_reason: 'stop' }],
  }, 'message').terminal, true);
  assert.equal(context.analyzeStreamPayload('kimi', {
    choices: [{ delta: { reasoning_content: '思考中', content: null }, finish_reason: null }],
  }, 'message').text, '');
  assert.equal(context.analyzeStreamPayload('kimi', {
    choices: [{ delta: { content: '正文' }, finish_reason: null }],
  }, 'message').text, '正文');
});

test('sanitizeModel migrates old configurations to current models and rejects incompatible families', () => {
  const { context } = loadBackground();
  const cases = [
    ['deepseek', 'deepseek-chat', 'deepseek-flash'],
    ['deepseek', 'deepseek-reasoner', 'deepseek-flash'],
    ['deepseek', 'deepseek-v4-flash', 'deepseek-flash'],
    ['claude', 'claude-3-5-haiku-20241022', 'claude-haiku-5-5'],
    ['claude', 'claude-3-5-sonnet-20241022', 'claude-sonnet-5-5'],
    ['claude', 'claude-opus-4-1-20250805', 'claude-opus-5-5'],
    ['claude', 'claude-sonnet-4-0', 'claude-sonnet-5-5'],
    ['claude', 'claude-fable-5', 'claude-fable-5-1'],
    ['kimi', 'moonshot-v1-8k', 'kimi-k3'],
    ['kimi', 'kimi-k2.5', 'kimi-k3'],
    ['kimi', 'kimi-k2-thinking', 'kimi-k3'],
    ['kimi', 'kimi-latest', 'kimi-k3'],
    ['openai', 'gpt-4.1', 'gpt-6.1-sol'],
    ['openai', 'gpt-5.6-terra', 'gpt-6.1-sol'],
    ['openai', 'gpt-5.6-luna', 'gpt-6-luna'],
    ['chatgpt', 'gpt-5.4', 'gpt-6.1-sol'],
    ['chatgpt', 'gpt-5.4-mini', 'gpt-6-luna'],
    ['chatgpt', 'gpt-5.6-sol', 'gpt-6.1-sol'],
    ['minimax', 'MiniMax-M2.7-highspeed', 'MiniMax-M3'],
    ['gemini', 'gemini-2.5-flash', 'gemini-3.8-flash'],
    ['gemini', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
    ['sub2api', 'gpt-5.6-sol', 'gpt-6.1-sol'],
    ['sub2api', 'claude-sonnet-5', 'claude-sonnet-5-5'],
    ['sub2api', 'gemini-2.5-flash', 'gemini-3.8-flash'],
  ];
  for (const [provider, oldModel, expected] of cases) {
    assert.equal(context.sanitizeModel(provider, oldModel), expected, provider + ': ' + oldModel);
  }
  assert.equal(context.sanitizeModel('deepseek', 'gpt-5.6'), '');
  assert.equal(context.sanitizeModel('kimi', 'deepseek-v4-flash'), '');
  assert.equal(context.sanitizeModel('openai', 'gpt-image-1'), '');
  assert.equal(context.sanitizeModel('gemini', 'gemini-2.5-flash-image'), '');
});

test('legacy Kimi configurations all use the latest K3 request contract', async () => {
  for (const model of ['moonshot-v1-8k', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3']) {
    const result = await captureRequest('kimi', { model, PREFIX: 'TRANSLATE' });
    assert.equal(result.url, 'https://api.moonshot.cn/v1/chat/completions');
    assert.equal(result.body.model, 'kimi-k3');
    assert.equal(result.body.reasoning_effort, 'low');
    assert.equal(result.body.max_completion_tokens, 16000);
    assert.equal(result.body.max_tokens, undefined);
    assert.equal(result.body.thinking, undefined);
  }
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

test('gateway base url normalisation strips sdk path suffixes including a bare /v1', () => {
  const { context } = loadBackground();
  const cases = [
    ['https://gw.example/v1', 'https://gw.example'],
    ['https://gw.example/v1/', 'https://gw.example'],
    ['https://gw.example/v1/messages', 'https://gw.example'],
    ['https://gw.example/v1/responses', 'https://gw.example'],
    ['https://gw.example/v1/chat/completions', 'https://gw.example'],
    ['https://gw.example/v1beta', 'https://gw.example'],
    // 非路径后缀不受影响，/api 前缀网关保持原样
    ['https://gw.example/api', 'https://gw.example/api'],
    ['https://gw.example', 'https://gw.example'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(context.validateSub2ApiBase(input).baseUrl, expected, input);
  }
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

  tabListeners.navigated({ tabId: 3, frameId: 0, url: 'https://example.com/next' });
  assert.equal(second.signal.aborted, true);
  assert.equal(second.abortReason.message, '页面已导航，请求已取消');

  // 同文档导航（pushState / hash）不会触发 onBeforeNavigate，在途翻译必须存活；
  // 子框架导航也不能误杀页面级请求
  const historyOnly = context.createActiveRequest({ tabId: 8, requestId: 'history', kind: 'translate', totalMs: 1000 });
  tabListeners.navigated({ tabId: 8, frameId: 3, url: 'https://ads.example.com/frame' });
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
    if (lifecycleEvent === 'updated') loaded.tabListeners.navigated({ tabId: 42, frameId: 0, url: 'https://example.com/next' });
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
  loaded.tabListeners.navigated({ tabId: 12, frameId: 0, url: 'https://example.com/next' });
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
  loaded.tabListeners.navigated({ tabId: 15, frameId: 0, url: 'https://example.com/next' });
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
    mindmap: { data: { label: 'old Q' } },
    updatedAt: Date.now() + 1000,
    ignored: '<script>not migrated</script>',
  });

  const merged = plain(await context.cacheLoadRecord(videoId));
  assert.equal(merged.summary.text, 'new summary');
  assert.equal(merged.mindmap.data.label, 'old Q');
  assert.equal('ignored' in merged, false);

  // 旧标签在首次迁移后又更新了一个 legacy-owned 字段：允许刷新该字段，
  // 但新版扩展生成过的 summary 仍然优先。
  await context.cacheMergeLegacyRecord({
    videoId,
    summary: { text: 'still old' },
    mindmap: { data: { label: 'Q2' } },
    updatedAt: Date.now() + 2000,
  });
  const refreshedLegacy = plain(await context.cacheLoadRecord(videoId));
  assert.equal(refreshedLegacy.summary.text, 'new summary');
  assert.equal(refreshedLegacy.mindmap.data.label, 'Q2');

  // 新版中重新生成 mindmap 后，该字段也不再接受旧标签覆盖。
  await context.cacheSaveFeature(videoId, 'mindmap', { data: { label: 'new Q' } });
  await context.cacheMergeLegacyRecord({
    videoId,
    mindmap: { data: { label: 'legacy Q3' } },
    updatedAt: Date.now() + 3000,
  });
  assert.equal((await context.cacheLoadRecord(videoId)).mindmap.data.label, 'new Q');

  await context.cacheRemoveRecord(videoId);
  assert.equal(await context.cacheLoadRecord(videoId), null);

  await context.cacheSaveFeature(videoId, 'html', { text: '' });
  await context.cacheRemoveRecord(videoId);
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

// ── 各 provider 请求体契约（模型列表 / 思考分档 2026-08 更新）──────────────
function sseResponse(payload) {
  const encoder = new TextEncoder();
  return async () => ({
    ok: true,
    body: {
      getReader() {
        let read = false;
        return {
          async read() {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: encoder.encode(payload) };
          },
          async cancel() {},
        };
      },
    },
  });
}

const OPENAI_SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const CLAUDE_SSE = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const GEMINI_SSE = 'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n';
const RESPONSES_SSE = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';

// 2048 = 划词翻译档（思考模型下最容易被吃光的那一档）；SUMMARY 用 8096 模拟总结档
async function captureRequest(provider, { model, PREFIX = 'SUMMARY', maxTokens = PREFIX === 'TRANSLATE' ? 2048 : 8096, sse = OPENAI_SSE, baseUrl }) {
  const loaded = loadBackground({ fetch: sseResponse(sse) });
  await loaded.context.callProvider(provider, {
    key: 'k', systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }],
    maxTokens, tabId: 1, PREFIX, requestId: 'r-' + PREFIX, model, baseUrl,
  });
  assert.equal(loaded.fetchCalls.length, 1, provider + ' should issue exactly one fetch');
  assert.deepEqual(loaded.sentMessages.map(item => item.message.type), [`${PREFIX}_MODEL`, `${PREFIX}_CHUNK`, `${PREFIX}_DONE`]);
  const [url, init] = loaded.fetchCalls[0];
  return { url, body: JSON.parse(init.body) };
}

test('legacy Claude configurations use the latest family model and its thinking contract', async () => {
  const translate = await captureRequest('claude', { model: 'claude-opus-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(translate.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(translate.body.model, 'claude-opus-5-5');
  assert.equal(translate.body.thinking, undefined);
  assert.equal(translate.body.max_tokens, 16000);
  assert.deepEqual(translate.body.output_config, { effort: 'low' });

  const summary = await captureRequest('claude', { model: 'claude-fable-5', PREFIX: 'SUMMARY', sse: CLAUDE_SSE });
  assert.equal(summary.body.model, 'claude-fable-5-1');
  assert.equal(summary.body.thinking, undefined);
  assert.equal(summary.body.max_tokens, 16000);
  assert.equal(summary.body.output_config, undefined);

  const sonnet = await captureRequest('claude', { model: 'claude-sonnet-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(sonnet.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.body.thinking, { type: 'between_tools' });
  assert.equal(sonnet.body.max_tokens, 2048);
  assert.equal(sonnet.body.output_config, undefined);

  const haiku = await captureRequest('claude', { model: 'claude-3-5-haiku-20241022', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(haiku.body.model, 'claude-haiku-5-5');
  assert.deepEqual(haiku.body.thinking, { type: 'disabled' });
  assert.equal(haiku.body.max_tokens, 2048);
});

test('legacy MiniMax configurations use M3 on the OpenAI-compatible endpoint', async () => {
  for (const model of ['MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M3.1', 'MiniMax-M3.1-preview']) {
    const result = await captureRequest('minimax', { model, PREFIX: 'TRANSLATE' });
    assert.equal(result.url, 'https://api.minimax.io/v1/chat/completions');
    assert.equal(result.body.model, 'MiniMax-M3');
    assert.deepEqual(result.body.thinking, { type: 'disabled' });
    assert.equal(result.body.reasoning_split, true);
    assert.equal(result.body.max_completion_tokens, 2048);
    assert.equal(result.body.max_tokens, undefined);
  }
});

test('legacy GPT and Gemini configurations use current models and scene-specific reasoning', async () => {
  for (const model of ['gpt-4.1', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
    const result = await captureRequest('openai', { model, PREFIX: 'TRANSLATE' });
    assert.equal(result.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(result.body.model, 'gpt-6.1-sol');
    assert.equal(result.body.reasoning_effort, 'low');
    assert.equal(result.body.max_completion_tokens, 16000);
  }
  const luna = await captureRequest('openai', { model: 'gpt-5.4-mini', PREFIX: 'TRANSLATE' });
  assert.equal(luna.body.model, 'gpt-6-luna');
  assert.equal(luna.body.reasoning_effort, 'low');
  assert.equal(luna.body.max_completion_tokens, 16000);
  const gptSummary = await captureRequest('openai', { model: 'gpt-5.6-sol', PREFIX: 'SUMMARY' });
  assert.equal(gptSummary.body.model, 'gpt-6.1-sol');
  assert.equal(gptSummary.body.reasoning_effort, undefined);
  assert.equal(gptSummary.body.max_completion_tokens, 16000);

  for (const model of ['gemini-3.7-flash', 'gemini-2.5-flash']) {
    const result = await captureRequest('gemini', { model, PREFIX: 'TRANSLATE', sse: GEMINI_SSE });
    assert.match(result.url, /\/models\/gemini-3\.8-flash:streamGenerateContent/);
    assert.deepEqual(result.body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
    assert.deepEqual(result.body.systemInstruction, { parts: [{ text: 'sys' }] });
  }
  const gemSummary = await captureRequest('gemini', { model: 'gemini-3.7-flash', PREFIX: 'SUMMARY', sse: GEMINI_SSE });
  assert.deepEqual(gemSummary.body.generationConfig, { maxOutputTokens: 8096 });
  const lite = await captureRequest('gemini', { model: 'gemini-2.5-flash-lite', PREFIX: 'TRANSLATE', sse: GEMINI_SSE });
  assert.match(lite.url, /\/models\/gemini-3\.5-flash-lite:streamGenerateContent/);
  assert.deepEqual(lite.body.generationConfig, { maxOutputTokens: 2048 });
});

test('legacy Sub2API configurations migrate the model before choosing protocol and thinking', async () => {
  const baseUrl = 'https://gateway.example';
  const translate = await captureRequest('sub2api', { model: 'gpt-5.6-sol', PREFIX: 'TRANSLATE', sse: RESPONSES_SSE, baseUrl });
  assert.equal(translate.url, baseUrl + '/v1/responses');
  assert.equal(translate.body.model, 'gpt-6.1-sol');
  assert.equal(translate.body.reasoning.effort, 'low');
  const summary = await captureRequest('sub2api', { model: 'gpt-5.6-sol', PREFIX: 'SUMMARY', sse: RESPONSES_SSE, baseUrl });
  assert.equal(summary.body.model, 'gpt-6.1-sol');
  assert.equal(summary.body.reasoning.effort, 'medium');

  const claude = await captureRequest('sub2api', { model: 'claude-sonnet-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE, baseUrl });
  assert.equal(claude.url, baseUrl + '/v1/messages');
  assert.equal(claude.body.model, 'claude-sonnet-5-5');
  assert.deepEqual(claude.body.thinking, { type: 'between_tools' });

  const gemini = await captureRequest('sub2api', { model: 'gemini-2.5-flash', PREFIX: 'TRANSLATE', sse: GEMINI_SSE, baseUrl });
  assert.equal(gemini.url, baseUrl + '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=k');
  assert.deepEqual(gemini.body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
  const lite = await captureRequest('sub2api', { model: 'gemini-2.5-flash-lite', PREFIX: 'TRANSLATE', sse: GEMINI_SSE, baseUrl });
  assert.match(lite.url, /\/models\/gemini-3\.5-flash-lite:streamGenerateContent/);
  assert.deepEqual(lite.body.generationConfig, { maxOutputTokens: 2048 });
});

test('video transcription is pinned to gemini-3.5-flash-lite instead of a drifting alias', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(source, /const model = 'gemini-3\.5-flash-lite';/);
  assert.doesNotMatch(source, /gemini-flash-lite-latest'/);
});


test('GPT 6 translation receives the shared reasoning policy and enough output budget', async () => {
  const translate = await captureRequest('openai', { model: 'gpt-6.1-sol', PREFIX: 'TRANSLATE' });
  assert.equal(translate.body.model, 'gpt-6.1-sol');
  assert.equal(translate.body.reasoning_effort, 'low');
  assert.equal(translate.body.max_completion_tokens, 16000);
  const summary = await captureRequest('openai', { model: 'gpt-6.1-sol', PREFIX: 'SUMMARY' });
  assert.equal(summary.body.reasoning_effort, undefined);
  assert.equal(summary.body.max_completion_tokens, 16000);
});

test('Claude 5.5 thinking settings distinguish Sonnet, Haiku and Opus capabilities', async () => {
  const sonnet = await captureRequest('claude', { model: 'claude-sonnet-5-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.deepEqual(sonnet.body.thinking, { type: 'between_tools' });
  const haiku = await captureRequest('claude', { model: 'claude-haiku-5-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.deepEqual(haiku.body.thinking, { type: 'disabled' });
  const opus = await captureRequest('claude', { model: 'claude-opus-5-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(opus.body.thinking, undefined);
  assert.equal(opus.body.max_tokens, 16000);
});

test('truncated provider completion reaches content scripts with warning metadata', async () => {
  const loaded = loadBackground({ fetch: sseResponse('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n') });
  await loaded.context.callProvider('openai', {
    key: 'test', model: 'gpt-6.1-sol', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2048, tabId: 1, PREFIX: 'SUMMARY', requestId: 'partial',
  });
  const done = loaded.sentMessages.at(-1).message;
  assert.equal(done.type, 'SUMMARY_DONE');
  assert.equal(done.truncated, true);
  assert.match(done.warning, /finish_reason=length/);
  assert.equal(loaded.sentMessages.filter(item => /_(DONE|ERROR)$/.test(item.message.type)).length, 1);
});

function expiredChatgptAuth() {
  return { access_token: 'expired-token', refresh_token: 'test-refresh-token', account_id: 'test-account' };
}

test('OAuth shared refresh times out stalled headers or response body and can retry', async () => {
  for (const phase of ['headers', 'body']) {
    const loaded = loadBackground({
      localStorage: { chatgptAuth: expiredChatgptAuth() },
      setTimeout(callback, ms) { return setTimeout(callback, ms === 30000 ? 5 : ms); },
      fetch: async () => phase === 'headers'
        ? new Promise(() => {})
        : { ok: true, json: () => new Promise(() => {}) },
    });
    const first = loaded.context.ensureChatgptAccessToken();
    const second = loaded.context.ensureChatgptAccessToken();
    const results = await Promise.all([first, second]);
    assert.equal(loaded.fetchCalls.length, 1, phase + ': concurrent callers share one refresh');
    for (const result of results) assert.match(result.error, /刷新超时/);
    assert.equal(loaded.fetchCalls[0][1].signal.aborted, true);
    assert.equal(vm.runInContext('chatgptRefreshInflight', loaded.context), null);
    const retry = await loaded.context.ensureChatgptAccessToken();
    assert.match(retry.error, /刷新超时/);
    assert.equal(loaded.fetchCalls.length, 2, phase + ': timeout releases the refresh slot');
  }
});

test('cancelling one OAuth caller immediately releases it without aborting the shared refresh', async () => {
  let finishRefresh;
  const localStorage = { chatgptAuth: expiredChatgptAuth() };
  const loaded = loadBackground({
    localStorage,
    fetch: async (url) => {
      if (url === 'https://auth.openai.com/oauth/token') {
        return new Promise(resolve => { finishRefresh = resolve; });
      }
      return sseResponse(RESPONSES_SSE)();
    },
  });
  const request = (requestId) => loaded.context.callProvider('chatgpt', {
    key: 'oauth', model: 'gpt-6.1-sol', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 2048, tabId: 1, PREFIX: 'SUMMARY', requestId,
  });
  const cancelled = request('cancelled-caller');
  const survivor = request('surviving-caller');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loaded.fetchCalls.length, 1);
    loaded.context.cancelRequestsForTab(1, 'cancelled-caller');
    await cancelled;
    assert.equal(loaded.fetchCalls[0][1].signal.aborted, false);
    const cancelMessage = loaded.sentMessages.find(item => item.message.type === 'SUMMARY_ERROR').message;
    assert.equal(cancelMessage.requestId, 'cancelled-caller');
    assert.equal(cancelMessage.cancelled, true);
    assert.equal(vm.runInContext('keepaliveRefCount', loaded.context), 1);
  } finally {
    if (finishRefresh) finishRefresh({ ok: true, json: async () => ({ access_token: 'fresh-token', refresh_token: 'rotated-token' }) });
    await Promise.all([cancelled, survivor]);
  }
  assert.equal(localStorage.chatgptAuth.refresh_token, 'rotated-token');
  assert.equal(loaded.fetchCalls.length, 2);
  assert.equal(loaded.sentMessages.at(-1).message.requestId, 'surviving-caller');
  assert.equal(loaded.sentMessages.at(-1).message.type, 'SUMMARY_DONE');
  assert.equal(vm.runInContext('keepaliveRefCount', loaded.context), 0);
});


test('stored old models migrate at request time without writing over settings', async () => {
  const cases = [
    ['openai', 'gpt-5.6-sol', 'gpt-6.1-sol', OPENAI_SSE],
    ['claude', 'claude-sonnet-5', 'claude-sonnet-5-5', CLAUDE_SSE],
    ['minimax', 'MiniMax-M2.7', 'MiniMax-M3', OPENAI_SSE],
    ['kimi', 'kimi-k2.6', 'kimi-k3', OPENAI_SSE],
    ['deepseek', 'deepseek-chat', 'deepseek-flash', OPENAI_SSE],
    ['gemini', 'gemini-2.5-flash', 'gemini-3.8-flash', GEMINI_SSE],
    ['sub2api', 'gpt-5.6-sol', 'gpt-6.1-sol', RESPONSES_SSE],
    ['chatgpt', 'gpt-5.4-mini', 'gpt-6-luna', RESPONSES_SSE],
  ];
  for (const [provider, oldModel, expected, sse] of cases) {
    const settings = { provider, [provider + 'Model']: oldModel, [provider + 'Key']: 'test-key', sub2apiBaseUrl: 'https://gateway.example' };
    const jwtPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const loaded = loadBackground({
      storageGet(_fields, callback) { callback(settings); },
      localStorage: { chatgptAuth: { access_token: 'header.' + jwtPayload + '.signature', account_id: 'test-account' } },
      fetch: sseResponse(sse),
    });
    let settingsWrites = 0;
    loaded.context.chrome.storage.sync.set = () => { settingsWrites++; };
    await loaded.context.handleSummarize({ provider, transcript: 'hello', prompt: '{transcript}', requestId: 'stored-' + provider }, 1);
    assert.equal(loaded.fetchCalls.length, 1, provider);
    const [url, init] = loaded.fetchCalls[0];
    const body = JSON.parse(init.body);
    if (provider === 'gemini') assert.ok(url.includes('/models/' + expected + ':'), provider);
    else assert.equal(body.model, expected, provider);
    assert.equal(loaded.sentMessages[0].message.model, expected, provider + ' model badge');
    assert.equal(loaded.sentMessages.at(-1).message.type, 'SUMMARY_DONE', provider);
    assert.equal(settingsWrites, 0, provider + ' must not overwrite settings');
    assert.equal(settings[provider + 'Model'], oldModel, provider + ' retains the saved value until settings migration');
  }
});


test('legacy shared model settings migrate only for their original provider', async () => {
  const cases = [
    { savedProvider: 'sub2api', provider: 'sub2api', model: 'gpt-5.4-mini', expected: 'gpt-6-luna', sse: RESPONSES_SSE, endpoint: '/v1/responses' },
    { savedProvider: 'sub2api', provider: 'sub2api', model: 'gemini-2.5-flash', expected: 'gemini-3.8-flash', sse: GEMINI_SSE, endpoint: '/v1beta/models/gemini-3.8-flash:' },
    { savedProvider: 'sub2api', provider: 'sub2api', model: 'gpt-5.4-mini', providerModel: 'claude-sonnet-5', expected: 'claude-sonnet-5-5', sse: CLAUDE_SSE, endpoint: '/v1/messages' },
    { savedProvider: 'sub2api', provider: 'openai', model: 'gpt-5.4-mini', expected: 'gpt-6.1-sol', sse: OPENAI_SSE, endpoint: '/v1/chat/completions' },
    { savedProvider: 'openai', provider: 'sub2api', model: 'gpt-5.4-mini', expected: 'claude-fable-5-1', sse: CLAUDE_SSE, endpoint: '/v1/messages' },
    { savedProvider: undefined, provider: 'claude', model: 'claude-sonnet-5', expected: 'claude-sonnet-5-5', sse: CLAUDE_SSE, endpoint: '/v1/messages' },
    { savedProvider: 'invalid-provider', provider: 'claude', model: 'claude-3-5-haiku-20241022', expected: 'claude-haiku-5-5', sse: CLAUDE_SSE, endpoint: '/v1/messages' },
  ];
  for (const row of cases) {
    const settings = { provider: row.savedProvider, model: row.model, [row.provider + 'Key']: 'test-key', sub2apiBaseUrl: 'https://gateway.example' };
    if (row.providerModel) settings[row.provider + 'Model'] = row.providerModel;
    let writes = 0;
    const loaded = loadBackground({
      storageGet(fields, callback) {
        assert.ok(fields.includes('provider'));
        assert.ok(fields.includes('model'));
        callback(settings);
      },
      fetch: sseResponse(row.sse),
    });
    loaded.context.chrome.storage.sync.set = () => { writes++; };
    await loaded.context.handleSummarize({ provider: row.provider, transcript: 'hello', prompt: '{transcript}', requestId: 'legacy-only' }, 1);
    assert.equal(loaded.fetchCalls.length, 1);
    const [url, init] = loaded.fetchCalls[0];
    assert.ok(url.includes(row.endpoint), row.provider + ': ' + url);
    if (!row.expected.startsWith('gemini-')) assert.equal(JSON.parse(init.body).model, row.expected);
    assert.equal(loaded.sentMessages[0].message.model, row.expected);
    assert.equal(loaded.sentMessages.at(-1).message.type, 'SUMMARY_DONE');
    assert.equal(writes, 0);
    assert.equal(settings.model, row.model);
  }
});
