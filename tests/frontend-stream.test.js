'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function element() {
  let html = '', text = '';
  return {
    style: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    disabled: false, scrollTop: 50, scrollHeight: 1000, clientHeight: 200,
    get innerHTML() { return html || escape(text); },
    set innerHTML(value) { html = value; text = ''; this.renders = (this.renders || 0) + 1; },
    get textContent() { return text; }, set textContent(value) { text = String(value); html = ''; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    insertBefore(child) { this.appendChild(child); },
    insertAdjacentHTML(position, value) { this.innerHTML = this.innerHTML + value; },
    setAttribute() {}, addEventListener() {}, focus() {}, select() {}, remove() {}, contains() { return false; },
  };
}

function timers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, delay) { pending.set(++next, { fn, delay }); return next; },
    clearTimeout(id) { pending.delete(id); },
    flush() { for (const [id, item] of [...pending]) { pending.delete(id); item.fn(); } },
  };
}

function loadYoutube(file = 'youtube/chat.js') {
  const timer = timers();
  const nodes = new Map();
  const get = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const context = vm.createContext({
    console, URL, ...timer,
    document: { createElement: element, querySelector() { return null; }, addEventListener() {}, removeEventListener() {} },
    chrome: { storage: { sync: { get(keys, cb) { cb({}); } } } },
  });
  vm.runInContext(read('youtube/core.js'), context);
  const ytx = context.YTX;
  Object.assign(ytx, {
    panel: { querySelector: get }, currentVideoId: 'abcdefghijk',
    escapeHtml: escape, renderMarkdown: text => '<p>' + escape(text) + '</p>',
    cancelRequest() {}, btnRefresh() {}, btnPrimary() {}, cache: { save() {} },
  });
  vm.runInContext(read(file), context);
  return { context, ytx, timer, get };
}

test('chat batches chunks, flushes on DONE, shows partial output and preserves manual scrolling', () => {
  const { ytx, timer, get } = loadYoutube();
  const chat = ytx.features.chat;
  chat.requestId = 'r1'; chat.isChatting = true;
  const bubble = get('.ytx-chat-ai:last-child');
  const container = get('#ytx-chat-messages');
  chat.onChunk('one'); chat.onChunk(' two');
  assert.equal(timer.pending.size, 1);
  assert.equal(bubble.renders || 0, 0);
  timer.flush();
  assert.match(bubble.innerHTML, /one two/);
  assert.equal(container.scrollTop, 50);
  chat.onChunk(' three');
  chat.onDone({ truncated: true, warning: '输出不完整 <img>' });
  assert.equal(timer.pending.size, 0);
  assert.match(bubble.innerHTML, /one two three/);
  assert.match(bubble.innerHTML, /输出不完整 &lt;img&gt;/);
  assert.equal(chat.messages[0].content, 'one two three');
  assert.equal(container.scrollTop, 50);

  chat.replyText = ''; chat.warning = ''; chat.truncated = false;
  chat.requestId = 'r2'; chat.isChatting = true;
  container.scrollTop = 800;
  chat.onChunk('complete'); chat.onDone({});
  assert.equal(container.scrollTop, 1000);
  assert.doesNotMatch(bubble.innerHTML, /ytx-result-warning/);
});

test('chat error, reset, clear and replaced panels cannot render a pending old chunk', () => {
  for (const action of ['onError', 'reset', 'clear']) {
    const { ytx, timer, get } = loadYoutube();
    const chat = ytx.features.chat;
    chat.requestId = 'old'; chat.isChatting = true;
    chat.onChunk('old answer');
    const stale = [...timer.pending.values()][0].fn;
    chat[action]('failed');
    assert.equal(timer.pending.size, 0);
    stale();
    assert.doesNotMatch(get('.ytx-chat-ai:last-child').innerHTML, /old answer/);
  }
  const { ytx, timer, get } = loadYoutube();
  const chat = ytx.features.chat;
  chat.requestId = 'old'; chat.isChatting = true;
  chat.onChunk('old answer');
  ytx.panel = { querySelector: get };
  timer.flush();
  assert.doesNotMatch(get('.ytx-chat-ai:last-child').innerHTML, /old answer/);
});

test('generated summary, HTML and mindmap persist partial metadata and clear it on complete output', () => {
  for (const [key, file, render] of [
    ['summary', 'youtube/summary.js', 'renderFinal'],
    ['html', 'youtube/html-notes.js', 'renderContent'],
    ['mindmap', 'youtube/mindmap.js', 'render'],
  ]) {
    const { ytx } = loadYoutube(file);
    const feature = ytx.features[key];
    let saved, visible;
    feature[render] = function () { visible = ytx.resultWarningHtml(this); };
    ytx.extractJSON = () => ({ label: 'root' });
    ytx.cache.save = (videoId, featureKey, data) => { saved = data; };
    feature.onDone({ truncated: true, warning: '内容不完整' });
    assert.equal(saved.truncated, true);
    assert.equal(saved.warning, '内容不完整');
    assert.match(visible, /内容不完整/);
    feature.onDone({});
    assert.equal(saved.truncated, false);
    assert.equal(saved.warning, '');
    assert.equal(visible, '');
  }
});

test('panel passes completion metadata only to the active request', () => {
  const { context, ytx } = loadYoutube();
  let received, handler;
  const feature = { requestId: 'active', onDone(data) { received = data; } };
  context.prefixMap = { SUMMARY: feature }; context.destroyed = false;
  context.chrome.runtime = { onMessage: { addListener(fn) { handler = fn; } } };
  const source = read('youtube/panel.js');
  const begin = source.indexOf('  chrome.runtime.onMessage.addListener');
  const end = source.indexOf('  // ── 启动', begin);
  vm.runInContext(source.slice(begin, end), context);
  handler({ type: 'SUMMARY_DONE', requestId: 'old', truncated: true });
  assert.equal(received, undefined);
  const message = { type: 'SUMMARY_DONE', requestId: 'active', warning: 'partial', truncated: true };
  handler(message);
  assert.equal(received, message);
});

test('cached result warnings restore for summary, HTML, mindmap and video transcription', async () => {
  const { context, ytx, get } = loadYoutube();
  const record = { transcript: { full: '[0:00] partial', videoMode: true, truncated: true, warning: '字幕不完整' } };
  ytx.featureOrder = ['summary', 'html', 'mindmap'];
  for (const [key, render] of [['summary', 'renderFinal'], ['html', 'renderContent'], ['mindmap', 'render']]) {
    record[key] = { text: 'partial', data: { label: 'root' }, warning: key + '不完整', truncated: true };
    ytx.features[key] = { [render]() { this.visibleWarning = ytx.resultWarningHtml(this); } };
  }
  ytx.cache.load = async () => record;
  const source = read('youtube/panel.js');
  const restoreStart = source.indexOf('  function restoreFromCache');
  vm.runInContext(source.slice(restoreStart, source.indexOf('  function getVideoId', restoreStart)), context);
  const transcriptStart = source.indexOf('  YTX.renderTranscript =');
  vm.runInContext(source.slice(transcriptStart, source.indexOf('  function toggleTranscript', transcriptStart)), context);
  context.restoreFromCache('abcdefghijk');
  await Promise.resolve(); await Promise.resolve();
  for (const key of ytx.featureOrder) {
    assert.equal(ytx.features[key].truncated, true);
    assert.match(ytx.features[key].visibleWarning, new RegExp(key + '不完整'));
  }
  assert.equal(ytx.transcriptData.truncated, true);
  assert.match(get('#ytx-transcript-body').innerHTML, /字幕不完整/);
});

function loadTranslate({ clipboard, execCommand = () => true } = {}) {
  const timer = timers();
  const listeners = new Map();
  let onMessage;
  const nodes = new Map();
  const get = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const host = element();
  const document = {
    documentElement: host, body: host, activeElement: null,
    createElement: element, querySelectorAll() { return []; }, execCommand,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  const runtime = {
    id: 'test', lastError: null,
    onMessage: { addListener(fn) { onMessage = fn; } },
    sendMessage(message, callback) { if (callback) callback({ started: true }); },
  };
  const context = vm.createContext({
    console, document, ...timer, navigator: { clipboard },
    window: { getSelection() { return null; } },
    Event: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} disconnect() {} },
    chrome: { runtime, storage: { sync: { get(keys, callback) { callback({}); } }, onChanged: { addListener() {} } } },
  });
  const source = read('translate/translate.js').replace(/\}\)\(\);\s*$/,
    'globalThis.testTranslation = { doTranslate, hideAll, copyText, setPopup(value) { popup = value; }, state() { return { currentRequestId, resultText }; } }; })();');
  vm.runInContext(source, context);
  context.testTranslation.setPopup({ querySelector: get, style: { display: 'flex' } });
  return { api: context.testTranslation, timer, get, listeners, document, onMessage };
}

test('translation batches output and flushes partial DONE without moving readers to the bottom', () => {
  const t = loadTranslate();
  t.api.doTranslate('hello');
  const id = t.api.state().currentRequestId;
  const body = t.get('.ytx-translate-result-text');
  const content = t.get('.ytx-translate-content');
  const startRenders = body.renders || 0;
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: id, text: 'one' });
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: id, text: ' two' });
  assert.equal(t.timer.pending.size, 1);
  assert.equal(body.renders || 0, startRenders);
  t.onMessage({ type: 'TRANSLATE_DONE', requestId: id, truncated: true });
  assert.equal(t.timer.pending.size, 0);
  assert.match(body.innerHTML, /one two/);
  assert.match(body.innerHTML, /内容不完整/);
  assert.equal(content.scrollTop, 50);
  t.api.doTranslate('again');
  const next = t.api.state().currentRequestId;
  content.scrollTop = 800;
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: id, text: 'STALE' });
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: next, text: 'complete' });
  t.timer.flush();
  assert.equal(content.scrollTop, 1000);
  t.onMessage({ type: 'TRANSLATE_DONE', requestId: next });
  assert.doesNotMatch(body.innerHTML, /STALE|内容不完整/);
});

test('translation error, close and takeover cancel pending rendering', () => {
  for (const action of ['error', 'close', 'takeover']) {
    const t = loadTranslate();
    t.api.doTranslate('hello');
    const id = t.api.state().currentRequestId;
    t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: id, text: 'old translation' });
    const stale = [...t.timer.pending.values()][0].fn;
    if (action === 'error') t.onMessage({ type: 'TRANSLATE_ERROR', requestId: id, error: 'failed' });
    if (action === 'close') t.api.hideAll();
    if (action === 'takeover') t.document.dispatchEvent({ type: 'aatools-takeover-translate' });
    assert.equal(t.timer.pending.size, 0);
    stale();
    assert.doesNotMatch(t.get('.ytx-translate-result-text').innerHTML, /old translation/);
  }
});

test('HTTP copying falls back without Clipboard API and reports a failed fallback', async () => {
  let copied = 0;
  const t = loadTranslate({ execCommand(command) { assert.equal(command, 'copy'); copied++; return true; } });
  t.api.copyText('hello', element());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, 1);
  const failed = loadTranslate({ execCommand() { return false; } });
  failed.api.copyText('hello', element());
  await new Promise(resolve => setImmediate(resolve));
  assert.match(failed.get('.ytx-translate-status').innerHTML, /复制失败/);
});


test('an already queued old callback cannot clear the new stream render timer', () => {
  const { ytx, timer, get } = loadYoutube();
  const chat = ytx.features.chat;
  chat.requestId = 'old'; chat.isChatting = true; chat.onChunk('old');
  const oldChatCallback = [...timer.pending.values()][0].fn;
  chat.reset(); chat.requestId = 'new'; chat.isChatting = true; chat.onChunk('fresh');
  const activeTimer = chat._renderTimer;
  oldChatCallback();
  assert.equal(chat._renderTimer, activeTimer);
  timer.flush();
  assert.match(get('.ytx-chat-ai:last-child').innerHTML, /fresh/);
  assert.doesNotMatch(get('.ytx-chat-ai:last-child').innerHTML, /old/);

  const t = loadTranslate();
  t.api.doTranslate('one');
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: t.api.state().currentRequestId, text: 'old' });
  const oldTranslationCallback = [...t.timer.pending.values()][0].fn;
  t.api.doTranslate('two');
  t.onMessage({ type: 'TRANSLATE_CHUNK', requestId: t.api.state().currentRequestId, text: 'fresh' });
  oldTranslationCallback();
  t.timer.flush();
  assert.match(t.get('.ytx-translate-result-text').innerHTML, /fresh/);
  assert.doesNotMatch(t.get('.ytx-translate-result-text').innerHTML, /old/);
});

test('a truncated malformed mindmap shows its incomplete warning without caching the broken tree', () => {
  const { ytx, get } = loadYoutube('youtube/mindmap.js');
  let cached = false;
  ytx.extractJSON = () => { throw new SyntaxError('incomplete JSON'); };
  ytx.cache.save = () => { cached = true; };
  ytx.features.mindmap.onDone({ truncated: true, warning: '导图输出达到上限' });
  assert.equal(cached, false);
  assert.equal(ytx.features.mindmap.data, null);
  assert.match(get('#ytx-content-mindmap').innerHTML, /导图输出达到上限/);
});
