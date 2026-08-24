'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'offscreen', 'network-host.js'), 'utf8');

function loadHost() {
  let inbound;
  let workerInstance;
  const posted = [];
  const intervals = new Map();
  let nextTimerId = 1;
  const port = {
    onMessage: { addListener(listener) { inbound = listener; } },
    onDisconnect: { addListener() {} },
    postMessage(message) { posted.push(structuredClone(message)); },
  };
  class FakeWorker {
    constructor() { workerInstance = this; this.messages = []; }
    postMessage(message) { this.messages.push(structuredClone(message)); }
    terminate() {}
  }
  const context = vm.createContext({
    chrome: {
      runtime: {
        connect() { return port; },
        getURL(resource) { return `chrome-extension://test-extension/${resource}`; },
      },
    },
    clearInterval(id) { intervals.delete(id); },
    clearTimeout() {},
    console,
    crypto: webcrypto,
    setInterval(callback, ms) {
      const id = nextTimerId++;
      intervals.set(id, { callback, ms });
      return id;
    },
    setTimeout() { return nextTimerId++; },
    structuredClone,
    Worker: FakeWorker,
  });
  vm.runInContext(source, context, { filename: 'offscreen/network-host.js' });
  return { context, inbound, intervals, posted, worker: workerInstance };
}

test('offscreen host keeps the service worker alive only for active routes without leaking request data', () => {
  const loaded = loadHost();
  assert.equal(loaded.intervals.size, 0, 'an idle host must not wake the service worker');

  const route = {
    tabId: 7, frameId: 0, documentId: 'document-12345678', requestId: 'slow-oauth-provider',
    prefix: 'SUMMARY', kind: 'provider',
  };
  const jobId = '12345678-1234-1234-1234-123456789abc';
  loaded.inbound({
    type: 'NETWORK_START',
    job: {
      jobId,
      route,
      request: {
        url: 'https://auth.openai.com/oauth/token',
        headers: { authorization: 'Bearer must-never-enter-heartbeat' },
        body: '{"refresh_token":"secret"}',
      },
    },
  });

  assert.equal(loaded.intervals.size, 1);
  const progressTimer = Array.from(loaded.intervals.values())[0];
  assert.equal(progressTimer.ms, 15000, 'progress must arrive well before Chrome\'s 30s idle deadline');
  progressTimer.callback();
  progressTimer.callback();
  progressTimer.callback();
  const progressMessages = loaded.posted.filter(message => message.type === 'NETWORK_PROGRESS');
  assert.equal(progressMessages.length, 3, 'a 45s slow-header wait must renew the deadline three times');
  const progress = progressMessages.at(-1);
  assert.equal(progress.type, 'NETWORK_PROGRESS');
  assert.equal(progress.activeJobs, 1);
  assert.equal(JSON.stringify(progress).includes('secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(progress, 'jobId'), false);

  loaded.worker.onmessage({ data: { type: 'EVENT', jobId, event: { kind: 'DONE' } } });
  loaded.inbound({ type: 'NETWORK_ACK', jobId });
  assert.equal(loaded.intervals.size, 0, 'terminal ACK must stop active progress events');
});

test('offscreen host atomically expands a shared OAuth recovery route and replays an already-retained terminal', () => {
  const loaded = loadHost();
  const first = {
    tabId: 31, frameId: 0, documentId: 'first-document-1234', requestId: 'first-waiter',
    prefix: 'SUMMARY', kind: 'provider',
  };
  const second = {
    tabId: 32, frameId: 4, documentId: 'second-document-1234', requestId: 'second-waiter',
    prefix: 'TRANSLATE', kind: 'provider',
  };
  const jobId = '22345678-1234-1234-1234-123456789abc';
  const route = {
    kind: 'internal', prefix: 'INTERNAL', requestId: `internal-${jobId}`,
    recoveryRoutes: [first], routeRevision: 1,
  };
  loaded.inbound({ type: 'NETWORK_START', job: { jobId, route, request: {} } });
  loaded.worker.onmessage({
    data: { type: 'EVENT', jobId, event: { kind: 'DONE', json: { access_token: 'bounded' } } },
  });
  loaded.inbound({
    type: 'NETWORK_ROUTE_UPDATE', jobId,
    route: Object.assign({}, route, { recoveryRoutes: [first, second], routeRevision: 2 }),
  });
  const updateAck = loaded.posted.find(message => message.type === 'NETWORK_ROUTE_UPDATED');
  assert.equal(updateAck.routeRevision, 2);
  const terminals = loaded.posted.filter(message => message.type === 'NETWORK_EVENT' && message.jobId === jobId);
  assert.equal(terminals.length, 2, 'route update must replay a terminal that raced with the update');
  assert.deepEqual(terminals.at(-1).route.recoveryRoutes, [first, second]);
  loaded.inbound({ type: 'NETWORK_ACK', jobId });
  assert.equal(loaded.intervals.size, 0);
});
