'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen', 'network-worker.js'), 'utf8');

function streamResponse(text, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { status });
}

function loadWorker(fetchImpl) {
  const events = [];
  const self = { postMessage(message) { events.push(structuredClone(message)); }, onmessage: null };
  const context = vm.createContext({
    AbortController, DOMException, Promise, ReadableStream, Response, TextDecoder, TextEncoder, URL,
    clearTimeout, fetch: fetchImpl, self, setTimeout,
  });
  vm.runInContext(source, context, { filename: 'offscreen/network-worker.js' });
  return { context, self, events };
}

function baseRequest(overrides = {}) {
  return Object.assign({
    url: 'https://api.openai.com/v1/chat/completions',
    allowedOrigin: 'https://api.openai.com',
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: '{}', provider: 'openai', parseAs: 'openai', maxOutputChars: 1000,
    timeouts: { firstByteMs: 1000, idleMs: 1000, totalMs: 5000 },
  }, overrides);
}

async function waitForTerminal(loaded, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const terminal = loaded.events.find(item => ['DONE', 'ERROR', 'HTTP_ERROR'].includes(item.event?.kind));
    if (terminal) return terminal;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('worker terminal event timeout');
}

test('worker SSE parser handles CRLF boundaries, compact data fields, multiline data, and EOF', () => {
  const loaded = loadWorker(async () => { throw new Error('unused'); });
  const events = [];
  loaded.context.__events = events;
  const parser = vm.runInContext('createSSEParser((event) => __events.push(event))', loaded.context);
  parser.push('\uFEFFevent: custom\r');
  parser.push('\ndata:first\r\ndata: second\r\n: heartbeat\r\n\r\ndata:last');
  parser.finish();
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { event: 'custom', data: 'first\nsecond' },
    { event: 'message', data: 'last' },
  ]);
});

test('dedicated worker owns slow-header fetch and parses bounded SSE', async () => {
  let called = false;
  const loaded = loadWorker(async () => {
    called = true;
    await new Promise(resolve => setTimeout(resolve, 40));
    return streamResponse('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  });
  loaded.self.onmessage({ data: { type: 'START', jobId: '12345678-1234-1234-1234-123456789abc', request: baseRequest() } });
  const terminal = await waitForTerminal(loaded);
  assert.equal(called, true);
  assert.equal(terminal.event.kind, 'DONE');
  assert.equal(terminal.event.text, 'hello');
  assert.equal(loaded.events.filter(item => item.event?.kind === 'CHUNK').map(item => item.event.text).join(''), 'hello');
});

test('worker cancellation aborts a pending fetch with one terminal error', async () => {
  const loaded = loadWorker((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const jobId = '22345678-1234-1234-1234-123456789abc';
  loaded.self.onmessage({ data: { type: 'START', jobId, request: baseRequest() } });
  loaded.self.onmessage({ data: { type: 'CANCEL', jobId } });
  const terminal = await waitForTerminal(loaded);
  assert.equal(terminal.event.kind, 'ERROR');
  assert.equal(terminal.event.code, 'cancelled');
  assert.equal(loaded.events.filter(item => ['DONE', 'ERROR', 'HTTP_ERROR'].includes(item.event?.kind)).length, 1);
});

test('worker rejects forged origins before fetch and bounds oversized streams', async () => {
  let calls = 0;
  const forged = loadWorker(async () => { calls++; return streamResponse('data: [DONE]\n\n'); });
  forged.self.onmessage({ data: {
    type: 'START', jobId: '32345678-1234-1234-1234-123456789abc',
    request: baseRequest({ url: 'https://evil.example/v1', allowedOrigin: 'https://evil.example' }),
  } });
  assert.match((await waitForTerminal(forged)).event.message, /允许列表/);
  assert.equal(calls, 0);

  const hugeText = 'x'.repeat(1200);
  const oversized = loadWorker(async () => streamResponse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: hugeText } }] })}\n\ndata: [DONE]\n\n`
  ));
  oversized.self.onmessage({ data: {
    type: 'START', jobId: '42345678-1234-1234-1234-123456789abc', request: baseRequest({ maxOutputChars: 100 }),
  } });
  const overflowTerminal = await waitForTerminal(oversized);
  assert.equal(overflowTerminal.event.kind, 'ERROR');
  assert.match(overflowTerminal.event.message, /100 字符/);
});

test('worker bounds non-2xx bodies and oversized JSON responses', async () => {
  const http = loadWorker(async () => new Response('E'.repeat(70000), { status: 500 }));
  http.self.onmessage({ data: {
    type: 'START', jobId: '47345678-1234-1234-1234-123456789abc', request: baseRequest(),
  } });
  const httpTerminal = await waitForTerminal(http);
  assert.equal(httpTerminal.event.kind, 'HTTP_ERROR');
  assert.ok(httpTerminal.event.body.length <= 65570);
  assert.match(httpTerminal.event.body, /已截断/);

  const json = loadWorker(async () => new Response(JSON.stringify({ value: 'x'.repeat(610000) }), { status: 200 }));
  json.self.onmessage({ data: {
    type: 'START', jobId: '48345678-1234-1234-1234-123456789abc',
    request: baseRequest({
      url: 'https://auth.openai.com/oauth/token', allowedOrigin: 'https://auth.openai.com',
      headers: { 'content-type': 'application/json' }, provider: 'chatgpt-auth', parseAs: undefined,
      responseMode: 'json', maxOutputChars: 1,
      body: JSON.stringify({
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token',
        refresh_token: 'refresh', scope: 'openid profile email',
      }),
    }),
  } });
  const jsonTerminal = await waitForTerminal(json);
  assert.equal(jsonTerminal.event.kind, 'ERROR');
  assert.equal(jsonTerminal.event.code, 'json_too_large');
});

test('MiniMax cumulative deltas emit each character once', async () => {
  const sse = [
    { choices: [{ delta: { content: 'A', reasoning_content: 'r1' } }] },
    { choices: [{ delta: { content: 'AB', reasoning_details: ['r2'] } }] },
    { choices: [{ delta: { content: 'ABC' }, finish_reason: 'stop' }] },
  ].map(item => `data: ${JSON.stringify(item)}\n\n`).join('');
  const loaded = loadWorker(async () => streamResponse(sse));
  loaded.self.onmessage({ data: {
    type: 'START', jobId: '52345678-1234-1234-1234-123456789abc',
    request: baseRequest({
      url: 'https://api.minimax.io/v1/chat/completions', allowedOrigin: 'https://api.minimax.io',
      provider: 'minimax', parseAs: 'minimax',
    }),
  } });
  assert.equal((await waitForTerminal(loaded)).event.kind, 'DONE');
  assert.equal(loaded.events.filter(item => item.event?.kind === 'CHUNK').map(item => item.event.text).join(''), 'ABC');
});

test('tiny provider deltas are coalesced into bounded IPC chunks', async () => {
  const count = 50000;
  const sse = Array.from({ length: count }, () =>
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'
  ).join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
  const loaded = loadWorker(async () => streamResponse(sse));
  loaded.self.onmessage({ data: {
    type: 'START', jobId: '57345678-1234-1234-1234-123456789abc',
    request: baseRequest({ maxOutputChars: count + 1 }),
  } });
  assert.equal((await waitForTerminal(loaded)).event.kind, 'DONE');
  const chunks = loaded.events.filter(item => item.event?.kind === 'CHUNK').map(item => item.event.text);
  assert.equal(chunks.join(''), 'x'.repeat(count));
  assert.ok(chunks.length <= Math.ceil(count / 8192) + 1, `too many IPC chunks: ${chunks.length}`);
  assert.ok(chunks.every(chunk => chunk.length <= 8192));
});

test('Anthropic streaming refusal is an explicit bounded error', async () => {
  const explanation = 'This request cannot be completed safely.';
  const sse = `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { explanation } } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const loaded = loadWorker(async () => streamResponse(sse));
  loaded.self.onmessage({ data: {
    type: 'START', jobId: '62345678-1234-1234-1234-123456789abc',
    request: baseRequest({
      url: 'https://api.anthropic.com/v1/messages', allowedOrigin: 'https://api.anthropic.com',
      provider: 'claude', parseAs: 'claude', headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
    }),
  } });
  const terminal = await waitForTerminal(loaded);
  assert.equal(terminal.event.kind, 'ERROR');
  assert.match(terminal.event.message, /Claude 拒绝处理/);
  assert.match(terminal.event.message, /cannot be completed/);
});

test('partial abnormal output completes with warning metadata instead of being overwritten', async () => {
  const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`;
  const loaded = loadWorker(async () => streamResponse(sse));
  loaded.self.onmessage({ data: { type: 'START', jobId: '72345678-1234-1234-1234-123456789abc', request: baseRequest() } });
  const terminal = await waitForTerminal(loaded);
  assert.equal(terminal.event.kind, 'DONE');
  assert.equal(terminal.event.incomplete, true);
  assert.equal(terminal.event.truncated, true);
  assert.equal(terminal.event.text, 'partial');
  assert.match(terminal.event.warning, /finish_reason=length/);
  assert.equal(loaded.events.filter(item => item.event?.kind === 'CHUNK').map(item => item.event.text).join(''), 'partial');
});

test('untrusted terminal metadata is bounded before it leaves the worker', async () => {
  const hugeReason = 'A'.repeat(5000);
  const empty = loadWorker(async () => streamResponse(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: hugeReason }] })}\n\n`
  ));
  empty.self.onmessage({ data: {
    type: 'START', jobId: '77345678-1234-1234-1234-123456789abc', request: baseRequest(),
  } });
  const errorTerminal = await waitForTerminal(empty);
  assert.equal(errorTerminal.event.kind, 'ERROR');
  assert.ok(errorTerminal.event.message.length <= 1000);

  const partial = loadWorker(async () => streamResponse(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: hugeReason }] })}\n\n`
  ));
  partial.self.onmessage({ data: {
    type: 'START', jobId: '78345678-1234-1234-1234-123456789abc', request: baseRequest(),
  } });
  const doneTerminal = await waitForTerminal(partial);
  assert.equal(doneTerminal.event.kind, 'DONE');
  assert.ok(doneTerminal.event.warning.length <= 500);
});

test('OAuth JSON jobs enforce exact endpoint and body schema', async () => {
  const loaded = loadWorker(async () => streamResponse(JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh' })));
  const request = baseRequest({
    url: 'https://auth.openai.com/oauth/token', allowedOrigin: 'https://auth.openai.com',
    headers: { 'content-type': 'application/json' }, provider: 'chatgpt-auth', parseAs: undefined,
    responseMode: 'json', maxOutputChars: 1,
    body: JSON.stringify({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token',
      refresh_token: 'refresh', scope: 'openid profile email',
    }),
  });
  loaded.self.onmessage({ data: { type: 'START', jobId: '82345678-1234-1234-1234-123456789abc', request } });
  const terminal = await waitForTerminal(loaded);
  assert.equal(terminal.event.kind, 'DONE');
  assert.equal(terminal.event.json.access_token, 'new-token');

  const invalid = loadWorker(async () => { throw new Error('must not fetch'); });
  invalid.self.onmessage({ data: {
    type: 'START', jobId: '92345678-1234-1234-1234-123456789abc',
    request: Object.assign({}, request, { url: 'https://auth.openai.com/other' }),
  } });
  assert.match((await waitForTerminal(invalid)).event.message, /来源未获授权|端点无效/);
});
