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

test('sanitizeModel rejects retired model names and wrong-provider prefixes', () => {
  const { context } = loadBackground();

  // deepseek 旧模型名（2026-07-24 退役）清空回退默认模型
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-chat'), '');
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-reasoner'), '');
  assert.equal(context.sanitizeModel('deepseek', 'deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.equal(context.sanitizeModel('deepseek', 'gpt-5.6'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-3-5-sonnet-20241022'), '');

  // Claude Opus 4 / Sonnet 4（2026-06-15）与 Opus 4.1（2026-08-05）已退役：别名与带日期真名都拦；4.5+ 仍在服务
  assert.equal(context.sanitizeModel('claude', 'claude-opus-4-1'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-opus-4-1-20250805'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-sonnet-4-0'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-opus-4-20250514'), '');
  assert.equal(context.sanitizeModel('claude', 'claude-opus-4-5-20251101'), 'claude-opus-4-5-20251101');
  assert.equal(context.sanitizeModel('claude', 'claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(context.sanitizeModel('claude', 'claude-opus-5'), 'claude-opus-5');

  // kimi：moonshot-v1 / kimi-k2.5（2026-08-31 下线）、旧 K2 线 kimi-k2-*、kimi-latest 都视为退役
  assert.equal(context.sanitizeModel('kimi', 'kimi-k2.6'), 'kimi-k2.6');
  assert.equal(context.sanitizeModel('kimi', 'kimi-k3'), 'kimi-k3');
  assert.equal(context.sanitizeModel('kimi', 'moonshot-v1-8k'), '');
  assert.equal(context.sanitizeModel('kimi', 'kimi-k2.5'), '');
  assert.equal(context.sanitizeModel('kimi', 'kimi-k2-thinking'), '');
  assert.equal(context.sanitizeModel('kimi', 'kimi-latest'), '');
  assert.equal(context.sanitizeModel('kimi', 'deepseek-v4-flash'), '');

  // Codex（ChatGPT 登录）通道 2026-08-31 下线 gpt-5.4 / gpt-5.4-mini；openai 直连不受该退役表影响
  assert.equal(context.sanitizeModel('chatgpt', 'gpt-5.4'), '');
  assert.equal(context.sanitizeModel('chatgpt', 'gpt-5.4-mini'), '');
  assert.equal(context.sanitizeModel('chatgpt', 'gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(context.sanitizeModel('openai', 'gpt-5.4'), 'gpt-5.4');
});

test('kimi request body follows each model tier thinking contract', async () => {
  const encoder = new TextEncoder();

  async function bodyFor(model) {
    const loaded = loadBackground({
      fetch: async () => ({
        ok: true,
        body: {
          getReader() {
            let read = false;
            return {
              async read() {
                if (read) return { done: true, value: undefined };
                read = true;
                return {
                  done: false,
                  value: encoder.encode(
                    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
                    'data: [DONE]\n\n'
                  ),
                };
              },
              async cancel() {},
            };
          },
        },
      }),
    });
    // 2048 = 划词翻译档，思考模型下最容易被吃光的那一档
    await loaded.context.callProvider('kimi', {
      key: 'k', systemPrompt: '', messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2048, tabId: 1, PREFIX: 'TRANSLATE', requestId: 'r1', model,
    });
    return { url: loaded.fetchCalls[0][0], body: JSON.parse(loaded.fetchCalls[0][1].body) };
  }

  // 思考可关（k2.6；k2.5 已退役由 sanitizeModel 拦截）：关掉即可，预算无需放大
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

test('claude body keeps thinking on for fable / opus-5 with enlarged budget and translate-only effort', async () => {
  const translate = await captureRequest('claude', { model: 'claude-opus-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(translate.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(translate.body.thinking, undefined);
  assert.equal(translate.body.max_tokens, 16000);
  assert.deepEqual(translate.body.output_config, { effort: 'low' });

  // 总结等长文场景沿用模型默认 effort（不传），但预算同样要放大
  const summary = await captureRequest('claude', { model: 'claude-fable-5', PREFIX: 'SUMMARY', sse: CLAUDE_SSE });
  assert.equal(summary.body.thinking, undefined);
  assert.equal(summary.body.max_tokens, 16000);
  assert.equal(summary.body.output_config, undefined);

  // sonnet-5 可关思考：关掉即可，预算与 effort 都不动
  const sonnet = await captureRequest('claude', { model: 'claude-sonnet-5', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.deepEqual(sonnet.body.thinking, { type: 'disabled' });
  assert.equal(sonnet.body.max_tokens, 2048);
  assert.equal(sonnet.body.output_config, undefined);

  // Opus 4.x 不传 thinking 即不思考：什么都不加
  const opus48 = await captureRequest('claude', { model: 'claude-opus-4-8', PREFIX: 'TRANSLATE', sse: CLAUDE_SSE });
  assert.equal(opus48.body.thinking, undefined);
  assert.equal(opus48.body.max_tokens, 2048);
  assert.equal(opus48.body.output_config, undefined);
});

test('minimax uses the OpenAI-compatible endpoint and keeps only the final answer', async () => {
  const m3 = await captureRequest('minimax', { model: 'MiniMax-M3', PREFIX: 'TRANSLATE' });
  assert.equal(m3.url, 'https://api.minimax.io/v1/chat/completions');
  assert.deepEqual(m3.body.thinking, { type: 'disabled' });
  assert.equal(m3.body.reasoning_split, true);
  assert.equal(m3.body.max_completion_tokens, 2048);
  assert.equal(m3.body.max_tokens, undefined);

  // M2.x 思考关不掉：思考单独走 reasoning_details（解析丢弃），并放大预算
  const m27 = await captureRequest('minimax', { model: 'MiniMax-M2.7-highspeed', PREFIX: 'TRANSLATE' });
  assert.equal(m27.body.thinking, undefined);
  assert.equal(m27.body.reasoning_split, true);
  assert.equal(m27.body.max_completion_tokens, 16000);
});

test('translation lowers reasoning effort on gpt-5 / gemini 3 / responses api and leaves other scenes at defaults', async () => {
  const gptTranslate = await captureRequest('openai', { model: 'gpt-5.6-sol', PREFIX: 'TRANSLATE' });
  assert.equal(gptTranslate.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(gptTranslate.body.reasoning_effort, 'low');
  assert.equal(gptTranslate.body.max_completion_tokens, 2048);
  const gptSummary = await captureRequest('openai', { model: 'gpt-5.6-sol', PREFIX: 'SUMMARY' });
  assert.equal(gptSummary.body.reasoning_effort, undefined);
  // gpt-4.x 老模型不认 reasoning_effort
  const gpt41 = await captureRequest('openai', { model: 'gpt-4.1', PREFIX: 'TRANSLATE' });
  assert.equal(gpt41.body.reasoning_effort, undefined);

  const gemTranslate = await captureRequest('gemini', { model: 'gemini-3.7-flash', PREFIX: 'TRANSLATE', sse: GEMINI_SSE });
  assert.match(gemTranslate.url, /\/models\/gemini-3\.7-flash:streamGenerateContent/);
  assert.deepEqual(gemTranslate.body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
  assert.deepEqual(gemTranslate.body.systemInstruction, { parts: [{ text: 'sys' }] });
  const gemSummary = await captureRequest('gemini', { model: 'gemini-3.7-flash', PREFIX: 'SUMMARY', sse: GEMINI_SSE });
  assert.deepEqual(gemSummary.body.generationConfig, { maxOutputTokens: 8096 });
  // Flash-Lite 默认已是 minimal；2.5 只认 thinkingBudget —— 都不传 thinkingLevel
  const lite = await captureRequest('gemini', { model: 'gemini-3.5-flash-lite', PREFIX: 'TRANSLATE', sse: GEMINI_SSE });
  assert.deepEqual(lite.body.generationConfig, { maxOutputTokens: 2048 });
  const g25 = await captureRequest('gemini', { model: 'gemini-2.5-flash', PREFIX: 'TRANSLATE', sse: GEMINI_SSE });
  assert.deepEqual(g25.body.generationConfig, { maxOutputTokens: 2048 });

  const respTranslate = await captureRequest('sub2api', { model: 'gpt-5.6-sol', PREFIX: 'TRANSLATE', sse: RESPONSES_SSE, baseUrl: 'https://gateway.example' });
  assert.equal(respTranslate.url, 'https://gateway.example/v1/responses');
  assert.equal(respTranslate.body.reasoning.effort, 'low');
  const respSummary = await captureRequest('sub2api', { model: 'gpt-5.6-sol', PREFIX: 'SUMMARY', sse: RESPONSES_SSE, baseUrl: 'https://gateway.example' });
  assert.equal(respSummary.body.reasoning.effort, 'medium');

  // sub2api 的 gemini 槽位与直连共用 buildGeminiBody
  const subGem = await captureRequest('sub2api', { model: 'gemini-3.7-flash', PREFIX: 'TRANSLATE', sse: GEMINI_SSE, baseUrl: 'https://gateway.example' });
  assert.match(subGem.url, /^https:\/\/gateway\.example\/v1beta\/models\/gemini-3\.7-flash:streamGenerateContent/);
  assert.deepEqual(subGem.body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } });
});

test('video transcription is pinned to gemini-3.5-flash-lite instead of a drifting alias', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(source, /const model = 'gemini-3\.5-flash-lite';/);
  assert.doesNotMatch(source, /gemini-flash-lite-latest'/);
});
