'use strict';

// Offscreen document owns the dedicated Worker and a private Port to the
// extension service worker. Request headers (including credentials) only
// travel over this Port; runtime broadcasts are used neither for starts nor
// for cancellations.
const PORT_NAME = 'aatools-offscreen-network-v1';
const MAX_CONCURRENT_JOBS = 16;
const MAX_BUFFERED_EVENT_BYTES = 2_000_000;
const MAX_BUFFERED_EVENTS = 2048;
const ACTIVE_PROGRESS_INTERVAL_MS = 15000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PREFIXES = new Set(['SUMMARY', 'HTML', 'MINDMAP', 'CHAT', 'TRANSLATE', 'TRANSCRIBE', 'INTERNAL']);
const HOST_GENERATION = crypto.randomUUID();

let port = null;
let reconnectTimer = null;
let activeProgressTimer = null;
let worker = null;
const routes = new Map();
const terminalEvents = new Map();
let pendingEvents = [];
let pendingEventBytes = 0;

function boundedString(value, max) {
  return typeof value === 'string' && value.length <= max;
}

function validRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
  if (route.kind === 'internal') {
    if (route.prefix !== 'INTERNAL' || !boundedString(route.requestId, 200) || !REQUEST_ID_PATTERN.test(route.requestId)) return false;
    if (route.recoveryRoutes === undefined) return route.routeRevision === undefined;
    if (!Array.isArray(route.recoveryRoutes) || route.recoveryRoutes.length < 1 || route.recoveryRoutes.length > MAX_CONCURRENT_JOBS) return false;
    if (!Number.isSafeInteger(route.routeRevision) || route.routeRevision < 1 || route.routeRevision > 1000000) return false;
    return route.recoveryRoutes.every((recovery, index) => recovery?.kind === 'provider' && validRoute(recovery) &&
      route.recoveryRoutes.findIndex(other => sameRoute(other, recovery)) === index);
  }
  if (!Number.isInteger(route.tabId) || route.tabId < 0) return false;
  if (!Number.isInteger(route.frameId) || route.frameId < 0) return false;
  if (!boundedString(route.documentId, 128) || !/^[A-Za-z0-9_-]{8,128}$/.test(route.documentId)) return false;
  if (!boundedString(route.requestId, 200) || !REQUEST_ID_PATTERN.test(route.requestId)) return false;
  if (!PREFIXES.has(route.prefix)) return false;
  if (!['provider', 'transcribe'].includes(route.kind)) return false;
  if (route.kind === 'transcribe') {
    if (!boundedString(route.videoId, 11) || !/^[A-Za-z0-9_-]{11}$/.test(route.videoId)) return false;
    if (!Number.isFinite(route.videoDuration) || route.videoDuration < 0 || route.videoDuration > 86400) return false;
  }
  return true;
}

function sameRoute(left, right) {
  if (!left || !right || left.kind !== right.kind || left.prefix !== right.prefix || left.requestId !== right.requestId) return false;
  if (left.kind === 'internal') return true;
  return left.tabId === right.tabId && left.frameId === right.frameId && left.documentId === right.documentId &&
    left.videoId === right.videoId;
}

function updateActiveProgressTimer() {
  if (!routes.size) {
    if (activeProgressTimer) clearInterval(activeProgressTimer);
    activeProgressTimer = null;
    return;
  }
  if (activeProgressTimer) return;
  // An offscreen Port message is an extension event and therefore renews the
  // MV3 service-worker idle deadline. It contains only generation/count data:
  // request URLs, bodies, headers and credentials never enter the heartbeat.
  activeProgressTimer = setInterval(() => {
    if (!routes.size) {
      updateActiveProgressTimer();
      return;
    }
    sendToServiceWorker({
      type: 'NETWORK_PROGRESS', version: 1, generation: HOST_GENERATION,
      activeJobs: routes.size,
    });
  }, ACTIVE_PROGRESS_INTERVAL_MS);
}

function estimateEventBytes(event) {
  try { return JSON.stringify(event).length; } catch { return MAX_BUFFERED_EVENT_BYTES + 1; }
}

function queueEvent(event) {
  const size = estimateEventBytes(event);
  const jobId = event.jobId;
  if (size > MAX_BUFFERED_EVENT_BYTES ||
      pendingEvents.length >= MAX_BUFFERED_EVENTS ||
      pendingEventBytes + size > MAX_BUFFERED_EVENT_BYTES) {
    // Drop buffered chunks for the affected job and retain one bounded terminal
    // failure. This prevents a disconnected service worker from turning the
    // offscreen page into an unbounded output store.
    const retained = [];
    pendingEventBytes = 0;
    for (const item of pendingEvents) {
      if (item.event.jobId === jobId) continue;
      retained.push(item);
      pendingEventBytes += item.size;
    }
    pendingEvents = retained;
    try { worker?.postMessage({ type: 'CANCEL', jobId }); } catch {}
    const overflow = {
      type: 'NETWORK_EVENT',
      jobId,
      route: event.route,
      event: { kind: 'ERROR', code: 'relay_overflow', message: '后台重连期间输出超过安全上限，请重试' },
    };
    const overflowSize = estimateEventBytes(overflow);
    terminalEvents.set(jobId, overflow);
    if (pendingEvents.length < MAX_BUFFERED_EVENTS && pendingEventBytes + overflowSize <= MAX_BUFFERED_EVENT_BYTES) {
      pendingEvents.push({ event: overflow, size: overflowSize });
      pendingEventBytes += overflowSize;
    }
    return;
  }
  pendingEvents.push({ event, size });
  pendingEventBytes += size;
}

function sendToServiceWorker(message) {
  if (port) {
    try {
      port.postMessage(message);
      return true;
    } catch {}
  }
  if (message.type === 'NETWORK_EVENT') queueEvent(message);
  return false;
}

function flushPendingEvents() {
  if (!port || !pendingEvents.length) return;
  const queued = pendingEvents;
  pendingEvents = [];
  pendingEventBytes = 0;
  for (let i = 0; i < queued.length; i++) {
    try {
      port.postMessage(queued[i].event);
    } catch {
      for (let j = i; j < queued.length; j++) queueEvent(queued[j].event);
      break;
    }
  }
}

function connectServiceWorker() {
  if (port) return;
  try {
    const next = chrome.runtime.connect({ name: PORT_NAME });
    port = next;
    next.onMessage.addListener(handlePortMessage);
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectServiceWorker, 250);
    });
    next.postMessage({
      type: 'NETWORK_HELLO',
      version: 1,
      generation: HOST_GENERATION,
      jobs: Array.from(routes.entries()).map(([jobId, route]) => ({ jobId, route })),
    });
    flushPendingEvents();
    // A terminal posted immediately before a Port disconnect may not have been
    // observed by the old service worker. Replaying terminal messages is safe
    // and keeps the route alive until the new worker acknowledges it.
    for (const terminal of terminalEvents.values()) {
      try { next.postMessage(terminal); } catch { queueEvent(terminal); }
    }
  } catch {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectServiceWorker, 500);
  }
}

function emitWorkerFailure(message) {
  const error = boundedString(message, 500) ? message : '网络 Worker 异常退出，请重试';
  for (const [jobId, route] of routes) {
    if (terminalEvents.has(jobId)) continue;
    const relay = {
      type: 'NETWORK_EVENT', jobId, route,
      event: { kind: 'ERROR', code: 'worker_crashed', message: error },
    };
    terminalEvents.set(jobId, relay);
    sendToServiceWorker(relay);
  }
}

function createNetworkWorker() {
  const next = new Worker(chrome.runtime.getURL('offscreen/network-worker.js'));
  worker = next;
  next.onmessage = (messageEvent) => {
    const data = messageEvent.data;
    if (!data || data.type !== 'EVENT' || !boundedString(data.jobId, 128)) return;
    const route = routes.get(data.jobId);
    if (!route) return;
    const event = data.event;
    if (!event || typeof event !== 'object') return;
    const relay = { type: 'NETWORK_EVENT', jobId: data.jobId, route, event };
    if (terminalEvents.has(data.jobId)) return;
    if (['DONE', 'ERROR', 'HTTP_ERROR'].includes(event.kind)) terminalEvents.set(data.jobId, relay);
    sendToServiceWorker(relay);
  };
  next.onerror = () => {
    if (worker !== next) return;
    emitWorkerFailure('网络 Worker 异常退出，请重试');
    try { next.terminate(); } catch {}
    worker = null;
    setTimeout(createNetworkWorker, 250);
  };
  next.onmessageerror = () => {
    if (worker !== next) return;
    emitWorkerFailure('网络 Worker 返回了无法解析的数据，请重试');
    try { next.terminate(); } catch {}
    worker = null;
    setTimeout(createNetworkWorker, 250);
  };
}

function handlePortMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'NETWORK_START') {
    const job = message.job;
    if (!job || !boundedString(job.jobId, 128) || !/^[A-Za-z0-9-]{16,128}$/.test(job.jobId) ||
        !validRoute(job.route) || !job.request || typeof job.request !== 'object') {
      return;
    }
    if (routes.has(job.jobId) || routes.size >= MAX_CONCURRENT_JOBS) {
      sendToServiceWorker({
        type: 'NETWORK_EVENT', jobId: job.jobId, route: job.route,
        event: { kind: 'ERROR', code: 'capacity', message: '并发网络请求过多，请稍后重试' },
      });
      return;
    }
    routes.set(job.jobId, job.route);
    updateActiveProgressTimer();
    try {
      worker.postMessage({ type: 'START', jobId: job.jobId, request: job.request });
    } catch {
      routes.delete(job.jobId);
      updateActiveProgressTimer();
      sendToServiceWorker({
        type: 'NETWORK_EVENT', jobId: job.jobId, route: job.route,
        event: { kind: 'ERROR', code: 'worker_unavailable', message: '网络 Worker 暂不可用，请重试' },
      });
    }
    return;
  }
  if (message.type === 'NETWORK_CANCEL') {
    const jobIds = [];
    for (const [jobId, route] of routes) {
      if (message.jobId && message.jobId !== jobId) continue;
      if (Number.isInteger(message.tabId) && message.tabId !== route.tabId) continue;
      if (message.requestId && message.requestId !== route.requestId) continue;
      jobIds.push(jobId);
    }
    for (const jobId of jobIds) {
      try { worker.postMessage({ type: 'CANCEL', jobId }); } catch {}
    }
    return;
  }
  if (message.type === 'NETWORK_ROUTE_UPDATE') {
    if (!boundedString(message.jobId, 128) || !/^[A-Za-z0-9-]{16,128}$/.test(message.jobId) || !validRoute(message.route)) return;
    const previous = routes.get(message.jobId);
    if (!previous || previous.kind !== 'internal' || message.route.kind !== 'internal' || !sameRoute(previous, message.route)) return;
    const sameRevision = message.route.routeRevision === previous.routeRevision;
    if (sameRevision && JSON.stringify(message.route) !== JSON.stringify(previous)) return;
    if (!sameRevision && message.route.routeRevision !== previous.routeRevision + 1) return;
    routes.set(message.jobId, message.route);
    sendToServiceWorker({
      type: 'NETWORK_ROUTE_UPDATED', version: 1, generation: HOST_GENERATION,
      jobId: message.jobId, routeRevision: message.route.routeRevision,
    });
    if (sameRevision) return;
    // A terminal may already have been queued/replayed while the Port's HELLO
    // and this update crossed. Rewrite every retained copy, then replay the
    // updated terminal so the service worker can validate all recovery routes.
    pendingEventBytes = 0;
    let routeUpdateOverflow = false;
    for (const item of pendingEvents) {
      if (item.event.jobId === message.jobId) {
        item.event.route = message.route;
        item.size = estimateEventBytes(item.event);
      }
      pendingEventBytes += item.size;
      if (item.size > MAX_BUFFERED_EVENT_BYTES || pendingEventBytes > MAX_BUFFERED_EVENT_BYTES) routeUpdateOverflow = true;
    }
    if (routeUpdateOverflow) {
      pendingEvents = pendingEvents.filter(item => item.event.jobId !== message.jobId);
      pendingEventBytes = pendingEvents.reduce((total, item) => total + item.size, 0);
      try { worker?.postMessage({ type: 'CANCEL', jobId: message.jobId }); } catch {}
      const overflow = {
        type: 'NETWORK_EVENT', jobId: message.jobId, route: message.route,
        event: { kind: 'ERROR', code: 'relay_overflow', message: '后台重连期间输出超过安全上限，请重试' },
      };
      terminalEvents.set(message.jobId, overflow);
      sendToServiceWorker(overflow);
      return;
    }
    const terminal = terminalEvents.get(message.jobId);
    if (terminal) {
      terminal.route = message.route;
      sendToServiceWorker(terminal);
    }
    return;
  }
  if (message.type === 'NETWORK_ACK') {
    if (!boundedString(message.jobId, 128) || !terminalEvents.has(message.jobId)) return;
    terminalEvents.delete(message.jobId);
    routes.delete(message.jobId);
    updateActiveProgressTimer();
    const retained = [];
    pendingEventBytes = 0;
    for (const item of pendingEvents) {
      if (item.event.jobId === message.jobId) continue;
      retained.push(item);
      pendingEventBytes += item.size;
    }
    pendingEvents = retained;
  }
}

createNetworkWorker();
connectServiceWorker();
