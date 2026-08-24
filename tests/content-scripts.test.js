'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    if (options.signal && options.signal.aborted) return;
    const entries = this.listeners.get(type) || [];
    entries.push({ listener, options });
    this.listeners.set(type, entries);
    if (options.signal) {
      options.signal.addEventListener('abort', () => this.removeEventListener(type, listener), { once: true });
    }
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    this.listeners.set(type, entries.filter(entry => entry.listener !== listener));
  }

  dispatch(type, event = {}) {
    event.type = type;
    event.target ||= this;
    event.isTrusted ??= true;
    event.stopPropagation ||= function () {};
    event.preventDefault ||= function () {};
    for (const entry of [...(this.listeners.get(type) || [])]) entry.listener.call(this, event);
  }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.length = 0;
  }

  refreshIndexes() {
    for (let i = 0; i < this.length; i++) delete this[i];
    const names = [...this.values.keys()];
    names.forEach((name, index) => { this[index] = name; });
    this.length = names.length;
  }

  setProperty(name, value, priority = '') {
    this.values.set(String(name), { value: String(value), priority: String(priority) });
    this.refreshIndexes();
  }

  getPropertyValue(name) {
    return this.values.get(name)?.value || '';
  }

  getPropertyPriority(name) {
    return this.values.get(name)?.priority || '';
  }

  set cssText(text) {
    this.values.clear();
    for (const declaration of String(text).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim();
      let value = declaration.slice(colon + 1).trim();
      if (!name) continue;
      let priority = '';
      if (/!important$/i.test(value)) {
        value = value.replace(/!important$/i, '').trim();
        priority = 'important';
      }
      this.values.set(name, { value, priority });
    }
    this.refreshIndexes();
  }

  get cssText() {
    return [...this.values].map(([name, item]) =>
      `${name}: ${item.value}${item.priority ? ` !${item.priority}` : ''};`).join(' ');
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

class FakeNode extends FakeEventTarget {
  constructor(document, tagName = '') {
    super();
    this.ownerDocument = document;
    this.tagName = tagName ? tagName.toUpperCase() : '';
    this.nodeType = tagName ? 1 : 11;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.id = '';
    this.textContent = '';
    this.innerHTML = '';
  }

  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }
  get isConnected() {
    if (this === this.ownerDocument.documentElement) return true;
    return !!(this.parentNode && this.parentNode.isConnected);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    this.ownerDocument.notifyMutation(this, 'childList');
    return child;
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.children.indexOf(reference);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentNode = this;
    this.ownerDocument.notifyMutation(this, 'childList');
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    this.ownerDocument.notifyMutation(this, 'childList');
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'style') this.style.cssText = value;
    this.ownerDocument.notifyMutation(this, 'attributes', name);
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    if (!this.attributes.delete(name)) return;
    this.ownerDocument.notifyMutation(this, 'attributes', name);
  }
  toggleAttribute(name, force) {
    const next = force === undefined ? !this.hasAttribute(name) : !!force;
    if (next) this.setAttribute(name, '');
    else this.removeAttribute(name);
    return next;
  }

  attachShadow(options) {
    if (this._shadowRoot) throw new Error('Shadow root already attached');
    this._shadowRoot = new FakeShadowRoot(this.ownerDocument, this, options.mode);
    this.ownerDocument.shadowAttachments.push({ host: this, root: this._shadowRoot, mode: options.mode });
    return this._shadowRoot;
  }

  get shadowRoot() {
    return this._shadowRoot && this._shadowRoot.mode === 'open' ? this._shadowRoot : null;
  }

  matchesSelector(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matchesSelector(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matchesSelector(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

class FakeShadowRoot extends FakeNode {
  constructor(document, host, mode) {
    super(document);
    this.host = host;
    this.mode = mode;
    this.activeElement = null;
  }
  get isConnected() { return this.host.isConnected; }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.observers = [];
    this.shadowAttachments = [];
    this.documentElement = new FakeNode(this, 'html');
    this.body = new FakeNode(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = null;
    this.hidden = false;
  }

  createElement(tagName) { return new FakeNode(this, tagName); }
  querySelector(selector) {
    if (this.documentElement.matchesSelector(selector)) return this.documentElement;
    return this.documentElement.querySelector(selector);
  }
  getSelection() { return { toString: () => '', rangeCount: 0 }; }

  notifyMutation(target, type, attributeName) {
    for (const observer of [...this.observers]) {
      if (!observer.active) continue;
      const registration = observer.registrations.find(item =>
        item.target === target && item.options[type] &&
        (!attributeName || !item.options.attributeFilter || item.options.attributeFilter.includes(attributeName)));
      if (registration) observer.callback([{ target, type, attributeName }], observer);
    }
  }
}

function createTranslationHarness(options = {}) {
  const document = new FakeDocument();
  if (options.hostileCustomElementRegistry) {
    const createElement = document.createElement.bind(document);
    document.createElement = function (tagName) {
      const node = createElement(tagName);
      if (String(tagName).toLowerCase() === 'aatools-translate-root') {
        node.attachShadow({ mode: 'closed' });
      }
      return node;
    };
  }
  const messages = [];
  const runtimeMessageListeners = new Set();
  const storageListeners = new Set();
  const window = new FakeEventTarget();
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.getSelection = () => document.getSelection();
  window.top = window;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.registrations = [];
      this.active = true;
      document.observers.push(this);
    }
    observe(target, options) { this.registrations.push({ target, options }); }
    disconnect() { this.active = false; this.registrations = []; }
  }

  const runtime = {
    id: 'test-extension',
    lastError: null,
    getURL(file) { return `chrome-extension://test-extension/${file}`; },
    sendMessage(message, callback) {
      messages.push(structuredClone(message));
      if (callback) queueMicrotask(() => callback(message.type === 'TRANSLATE' ? { started: true } : { ok: true }));
    },
    onMessage: {
      addListener(listener) { runtimeMessageListeners.add(listener); },
      removeListener(listener) { runtimeMessageListeners.delete(listener); },
    },
  };

  const chrome = {
    runtime,
    storage: {
      sync: {
        get(keys, callback) {
          queueMicrotask(() => {
            if (keys.length === 1 && keys[0] === 'enableTranslate') callback({ enableTranslate: true });
            else callback({ provider: 'openai', openaiModel: 'test-model' });
          });
        },
      },
      onChanged: {
        addListener(listener) { storageListeners.add(listener); },
        removeListener(listener) { storageListeners.delete(listener); },
      },
    },
  };

  const context = {
    AbortController,
    Array,
    chrome,
    clearTimeout,
    console,
    document,
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('#ytx-translate-icon{display:none}') }),
    MutationObserver: FakeMutationObserver,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Promise,
    queueMicrotask,
    requestAnimationFrame: callback => queueMicrotask(callback),
    setTimeout,
    window,
  };
  context.globalThis = context;
  vm.createContext(context);

  const file = path.join(__dirname, '..', 'translate', 'translate.js');
  const original = fs.readFileSync(file, 'utf8');
  const marker = '\n})();';
  const index = original.lastIndexOf(marker);
  assert.notEqual(index, -1, 'translation IIFE marker exists');
  const instrumented = original.slice(0, index) + `
  globalThis.__translateTestHooks = {
    ensureElements: ensureElements,
    doTranslate: doTranslate,
    handleRuntimeMessage: handleRuntimeMessage,
    applyAuthoritativeTranslation: applyAuthoritativeTranslation,
    completionWarning: translationCompletionWarning,
    dispose: dispose,
    state: function () {
      return {
        currentRequestId: currentRequestId,
        disposed: disposed,
        featureEnabled: featureEnabled,
        resultText: resultText,
        stylesReady: stylesReady
      };
    }
  };
` + original.slice(index);
  vm.runInContext(instrumented, context, { filename: 'translate/translate.js' });

  return {
    document,
    hooks: context.__translateTestHooks,
    messages,
    runtimeMessageListeners,
    storageListeners,
    emitStorage(changes) {
      for (const listener of [...storageListeners]) listener(changes, 'sync');
    },
  };
}

async function flushAsync() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function createXhsWheelHarness() {
  const document = new FakeDocument();
  const window = new FakeEventTarget();
  window.innerWidth = 1280;
  window.innerHeight = 800;
  window.top = window;
  window.document = document;
  document.defaultView = window;
  document.scrollingElement = document.documentElement;

  const background = document.documentElement;
  background.scrollTop = 200;
  background.scrollLeft = 0;
  background.scrollHeight = 3000;
  background.scrollWidth = 1280;
  background.clientHeight = 800;
  background.clientWidth = 1280;
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
  document.body.scrollHeight = 800;
  document.body.scrollWidth = 1280;
  document.body.clientHeight = 800;
  document.body.clientWidth = 1280;

  Object.defineProperties(window, {
    scrollX: { get: () => background.scrollLeft },
    scrollY: { get: () => background.scrollTop },
    pageXOffset: { get: () => background.scrollLeft },
    pageYOffset: { get: () => background.scrollTop },
  });
  window.scrollTo = function (leftOrOptions, top) {
    if (leftOrOptions && typeof leftOrOptions === 'object') {
      if (Number.isFinite(leftOrOptions.left)) background.scrollLeft = leftOrOptions.left;
      if (Number.isFinite(leftOrOptions.top)) background.scrollTop = leftOrOptions.top;
      return;
    }
    if (Number.isFinite(leftOrOptions)) background.scrollLeft = leftOrOptions;
    if (Number.isFinite(top)) background.scrollTop = top;
  };

  const overlay = document.createElement('div');
  const overlayTarget = document.createElement('div');
  overlay.appendChild(overlayTarget);
  document.body.appendChild(overlay);
  overlay.getBoundingClientRect = () => ({ left: 100, top: 100, right: 1180, bottom: 700, width: 1080, height: 600 });
  overlayTarget.getBoundingClientRect = () => ({ left: 200, top: 200, right: 400, bottom: 260, width: 200, height: 60 });
  document.body.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
  background.getBoundingClientRect = document.body.getBoundingClientRect;
  overlay.scrollTop = 0;
  overlay.scrollLeft = 0;
  overlay.scrollHeight = 600;
  overlay.scrollWidth = 1080;
  overlay.clientHeight = 600;
  overlay.clientWidth = 1080;
  overlayTarget.scrollTop = 0;
  overlayTarget.scrollLeft = 0;
  overlayTarget.scrollHeight = 60;
  overlayTarget.scrollWidth = 200;
  overlayTarget.clientHeight = 60;
  overlayTarget.clientWidth = 200;

  const computedStyle = (node) => ({
    position: node === overlay ? 'fixed' : 'static',
    display: 'block',
    visibility: 'visible',
    pointerEvents: 'auto',
    overflowX: node === background ? 'auto' : 'visible',
    overflowY: node === background ? 'auto' : 'visible',
  });
  window.getComputedStyle = computedStyle;

  const storageListeners = new Set();
  let nextAnimationFrameId = 1;
  let animationFrames = [];
  function requestAnimationFrame(callback) {
    const id = nextAnimationFrameId++;
    animationFrames.push({ id, callback });
    return id;
  }
  function cancelAnimationFrame(id) {
    animationFrames = animationFrames.filter(frame => frame.id !== id);
  }
  async function flushAnimationFrames(maxFrames = 4) {
    for (let frameIndex = 0; frameIndex < maxFrames && animationFrames.length; frameIndex++) {
      const frame = animationFrames;
      animationFrames = [];
      for (const item of frame) item.callback(frameIndex * 16);
      await Promise.resolve();
    }
    assert.equal(animationFrames.length, 0, 'animation-frame recovery must settle within the harness bound');
  }
  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;
  const context = {
    AbortController,
    cancelAnimationFrame,
    chrome: {
      runtime: { lastError: null },
      storage: {
        sync: {
          get(_keys, callback) { queueMicrotask(() => callback({ enableXhs: true })); },
        },
        onChanged: {
          addListener(listener) { storageListeners.add(listener); },
          removeListener(listener) { storageListeners.delete(listener); },
        },
      },
    },
    clearTimeout,
    console,
    document,
    getComputedStyle: computedStyle,
    location: { hostname: 'www.xiaohongshu.com' },
    Promise,
    queueMicrotask,
    requestAnimationFrame,
    setTimeout,
    window,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'xhs', 'xhs-scroll-fix.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'xhs/xhs-scroll-fix.js' });

  function listenerUsesCapture(entry) {
    return entry.options === true || Boolean(entry.options && entry.options.capture);
  }

  function dispatchWheel(target, init = {}) {
    let propagationStopped = false;
    let immediateStopped = false;
    const event = {
      type: 'wheel',
      target,
      currentTarget: null,
      isTrusted: true,
      ctrlKey: false,
      deltaX: 0,
      deltaY: 0,
      defaultPrevented: false,
      composedPath: () => [target, overlay, document.body, background, document, window],
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { propagationStopped = true; },
      stopImmediatePropagation() { propagationStopped = true; immediateStopped = true; },
      ...init,
    };

    const invoke = (node, capture) => {
      immediateStopped = false;
      event.currentTarget = node;
      for (const entry of [...(node.listeners.get('wheel') || [])]) {
        if (listenerUsesCapture(entry) !== capture) continue;
        entry.listener.call(node, event);
        if (immediateStopped) break;
      }
    };

    invoke(window, true);
    if (!propagationStopped) invoke(document, true);
    if (!propagationStopped) invoke(target, true);
    if (!propagationStopped) invoke(target, false);
    if (!propagationStopped) invoke(document, false);
    if (!propagationStopped) invoke(window, false);
    return event;
  }

  return {
    background,
    dispatchWheel,
    document,
    flushAnimationFrames,
    overlay,
    overlayTarget,
    requestAnimationFrame,
    window,
  };
}

test('translation UI lives in a closed shadow root and restores a removed host', async () => {
  const loaded = createTranslationHarness();
  await flushAsync();
  assert.equal(loaded.hooks.state().featureEnabled, true);
  assert.equal(loaded.hooks.state().stylesReady, true);

  loaded.hooks.ensureElements();
  const attachment = loaded.document.shadowAttachments[0];
  assert.ok(attachment, 'translation host attaches a shadow root');
  assert.equal(attachment.mode, 'closed');
  assert.equal(attachment.host.shadowRoot, null, 'page-facing shadowRoot remains inaccessible');
  assert.equal(attachment.host.children.length, 0, 'source and result controls are not light-DOM children');
  assert.equal(loaded.document.querySelector('#ytx-translate-popup'), null);

  attachment.host.remove();
  assert.equal(attachment.host.parentNode, loaded.document.documentElement, 'observer reconnects a removed host');

  attachment.host.setAttribute('hidden', '');
  assert.equal(attachment.host.hasAttribute('hidden'), false, 'observer removes page-supplied hidden state');
  attachment.host.setAttribute('style', 'visibility: hidden !important');
  assert.equal(attachment.host.style.getPropertyValue('visibility'), '', 'observer removes page-supplied host styles');
});

test('translation host cannot be preempted by a hostile custom-element registration', async () => {
  const loaded = createTranslationHarness({ hostileCustomElementRegistry: true });
  await flushAsync();
  assert.doesNotThrow(() => loaded.hooks.ensureElements());
  const attachment = loaded.document.shadowAttachments[0];
  assert.ok(attachment);
  assert.equal(attachment.host.tagName, 'DIV');
  assert.equal(attachment.mode, 'closed');
});

test('disabling translation cancels the active request and teardown removes listeners', async () => {
  const loaded = createTranslationHarness();
  await flushAsync();

  loaded.hooks.doTranslate('active request');
  await flushAsync();
  const request = loaded.messages.find(message => message.type === 'TRANSLATE');
  assert.ok(request?.requestId);

  loaded.emitStorage({ enableTranslate: { oldValue: true, newValue: false } });
  assert.equal(loaded.hooks.state().featureEnabled, false);
  assert.equal(loaded.hooks.state().currentRequestId, null);
  assert.ok(loaded.messages.some(message =>
    message.type === 'CANCEL_REQUEST' && message.requestId === request.requestId));

  loaded.hooks.dispose();
  assert.equal(loaded.hooks.state().disposed, true);
  assert.equal(loaded.runtimeMessageListeners.size, 0);
  assert.equal(loaded.storageListeners.size, 0);
});

test('superseded translation chunks and terminal messages cannot mutate the new request', async () => {
  const loaded = createTranslationHarness();
  await flushAsync();

  loaded.hooks.doTranslate('first');
  await flushAsync();
  const first = loaded.messages.find(message => message.type === 'TRANSLATE');
  assert.ok(first?.requestId);

  loaded.hooks.doTranslate('second');
  await flushAsync();
  const translations = loaded.messages.filter(message => message.type === 'TRANSLATE');
  const second = translations.at(-1);
  assert.notEqual(second.requestId, first.requestId);
  assert.ok(loaded.messages.some(message =>
    message.type === 'CANCEL_REQUEST' && message.requestId === first.requestId));

  loaded.hooks.handleRuntimeMessage({ type: 'TRANSLATE_CHUNK', requestId: first.requestId, text: 'stale' });
  loaded.hooks.handleRuntimeMessage({ type: 'TRANSLATE_DONE', requestId: first.requestId });
  const state = loaded.hooks.state();
  assert.equal(state.currentRequestId, second.requestId);
  assert.equal(state.resultText, '');
});

test('translation DONE replaces a partial stream with authoritative full text', async () => {
  const loaded = createTranslationHarness();
  await flushAsync();
  assert.equal(loaded.hooks.applyAuthoritativeTranslation('partial'), true);
  assert.equal(loaded.hooks.applyAuthoritativeTranslation('complete authoritative translation'), true);
  assert.equal(loaded.hooks.state().resultText, 'complete authoritative translation');
  assert.equal(loaded.hooks.applyAuthoritativeTranslation('x'.repeat(100001)), false);
});

test('translation popup has no same-document secret input and model output is not natively selectable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'translate', 'translate.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'translate', 'translate.css'), 'utf8');

  assert.doesNotMatch(source, /<textarea|contenteditable\s*=/i);
  assert.match(source, /class="ytx-translate-source-text"/);
  assert.match(css, /\.ytx-translate-result-text\s*\{[\s\S]*?user-select:\s*none/);
  assert.match(source, /navigator\.clipboard\.writeText\(text\)/);
  assert.doesNotMatch(source, /execCommand\(['"]copy/i);
});

test('partial translation completion remains visibly incomplete', async () => {
  const loaded = createTranslationHarness();
  await flushAsync();
  assert.equal(loaded.hooks.completionWarning({ type: 'TRANSLATE_DONE' }), '');
  assert.match(loaded.hooks.completionWarning({
    type: 'TRANSLATE_DONE', incomplete: true, warning: 'finish_reason=length',
  }), /finish_reason=length/);
  assert.match(loaded.hooks.completionWarning({
    type: 'TRANSLATE_DONE', truncated: true,
  }), /不完整翻译/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'translate', 'translate.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'translate', 'translate.css'), 'utf8');
  assert.match(source, /Incomplete translation/);
  assert.match(source, /ytx-translate-incomplete-warning/);
  assert.match(source, /REQUEST_WATCHDOG_MS = 16 \* 60 \* 1000/);
  assert.match(source, /armRequestWatchdog\(requestId\)/);
  assert.match(source, /翻译请求等待超时，请重试/);
  assert.match(source, /applyAuthoritativeTranslation\(msg\.text\)[\s\S]*?finishCurrentRequest\(msg\.requestId\)/,
    'translation DONE must reconcile to its authoritative full text');
  assert.match(css, /\.ytx-translate-status\.incomplete/);
});

test('XHS wheel restores capture-phase background scrolling without suppressing the overlay target', async () => {
  const loaded = createXhsWheelHarness();
  await flushAsync();

  let captureRuns = 0;
  let overlayTargetRuns = 0;
  // The extension registered at document_start, but a page window-capture
  // listener still runs before its document-bubble guard by DOM event order.
  loaded.window.addEventListener('wheel', (event) => {
    captureRuns++;
    loaded.background.scrollTop += event.deltaY;
  }, { capture: true });
  loaded.overlayTarget.addEventListener('wheel', () => {
    overlayTargetRuns++;
  });

  const event = loaded.dispatchWheel(loaded.overlayTarget, { deltaY: 60 });
  await flushAsync();
  await loaded.flushAnimationFrames();

  assert.equal(captureRuns, 1, 'the page capture listener reproduces the pre-bubble side effect');
  assert.equal(overlayTargetRuns, 1, 'the overlay target must retain its own wheel processing');
  assert.equal(event.defaultPrevented, true, 'an exhausted overlay still prevents native background scroll chaining');
  assert.equal(loaded.background.scrollTop, 200,
    'capture-phase page code must not leave the background scroller displaced');
});

test('XHS wheel restores a capture handler microtask that scrolls the background', async () => {
  const loaded = createXhsWheelHarness();
  await flushAsync();

  let overlayTargetRuns = 0;
  loaded.window.addEventListener('wheel', (event) => {
    queueMicrotask(() => {
      loaded.background.scrollTop += event.deltaY;
    });
  }, { capture: true });
  loaded.overlayTarget.addEventListener('wheel', () => {
    overlayTargetRuns++;
  });

  loaded.dispatchWheel(loaded.overlayTarget, { deltaY: 60 });
  await flushAsync();
  await loaded.flushAnimationFrames();

  assert.equal(overlayTargetRuns, 1, 'deferred background defense must not suppress overlay target handling');
  assert.equal(loaded.background.scrollTop, 200,
    'the extension recovery must run after page capture microtasks and restore the background');
});

test('XHS wheel restores a capture handler animation frame that scrolls the background', async () => {
  const loaded = createXhsWheelHarness();
  await flushAsync();

  let overlayTargetRuns = 0;
  loaded.window.addEventListener('wheel', (event) => {
    loaded.requestAnimationFrame(() => {
      loaded.background.scrollTop += event.deltaY;
    });
  }, { capture: true });
  loaded.overlayTarget.addEventListener('wheel', () => {
    overlayTargetRuns++;
  });

  loaded.dispatchWheel(loaded.overlayTarget, { deltaY: 60 });
  await flushAsync();
  await loaded.flushAnimationFrames();

  assert.equal(overlayTargetRuns, 1, 'frame-delayed background defense must retain overlay target handling');
  assert.equal(loaded.background.scrollTop, 200,
    'the document-bubble frame recovery must run after capture-handler animation frames');
});

test('mouse gestures ignore AAtools shadow hosts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gestures', 'gestures.js'), 'utf8');
  assert.match(source, /function isAAToolsUiEvent\(e\)/);
  assert.match(source, /node\.id === 'ytx-panel-host'/);
  assert.match(source, /node\.tagName === 'DIV'/);
  assert.match(source, /getAttribute\('data-aatools-ui'\) === 'translate'/);
  assert.doesNotMatch(source, /AATOOLS-TRANSLATE-ROOT/);
  assert.match(source, /e\.button !== 2 \|\| isAAToolsUiEvent\(e\)/);
  assert.match(source, /response\.ok !== true/);
  assert.match(source, /showActionError\(error, generation\)/);
  assert.doesNotMatch(source, /\.catch\(\(\) => \{\}\)/);

  const document = new FakeDocument();
  const window = new FakeEventTarget();
  window.top = window;
  window.scrollTo = function () {};
  const context = {
    AbortController,
    chrome: {
      runtime: { lastError: null, sendMessage: () => Promise.resolve({ ok: true }) },
      storage: {
        sync: { get(_keys, callback) { callback({ enableGestures: true, gestureKeepMenu: true }); } },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
    clearTimeout,
    console,
    document,
    history: { back() {}, forward() {} },
    navigator: { platform: '' },
    Promise,
    setTimeout,
    window,
  };
  context.globalThis = context;
  vm.createContext(context);
  const marker = '\n})();';
  const markerIndex = source.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1);
  const instrumented = source.slice(0, markerIndex) +
    '\n  globalThis.__gestureTestHooks = { isAAToolsUiEvent: isAAToolsUiEvent };' +
    source.slice(markerIndex);
  vm.runInContext(instrumented, context, { filename: 'gestures/gestures.js' });

  const translateHost = new FakeNode(document, 'div');
  translateHost.setAttribute('data-aatools-ui', 'translate');
  const translateControl = new FakeNode(document, 'button');
  assert.equal(context.__gestureTestHooks.isAAToolsUiEvent({
    composedPath: () => [translateControl, translateHost, document.documentElement],
  }), true, 'the built-in DIV shadow host must block gesture tracking');

  const unrelated = new FakeNode(document, 'div');
  assert.equal(context.__gestureTestHooks.isAAToolsUiEvent({
    composedPath: () => [unrelated, document.documentElement],
  }), false);
});
