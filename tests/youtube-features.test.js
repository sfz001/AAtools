'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadYoutubeModules(files) {
  const runtime = {
    id: 'test-extension',
    lastError: null,
    sendMessage(_message, callback) { if (callback) queueMicrotask(() => callback({ ok: true })); },
  };
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        _text: '',
        innerHTML: '',
        children: [],
        set textContent(value) {
          this._text = String(value);
          this.innerHTML = this._text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
        get textContent() { return this._text; },
        appendChild(child) { this.children.push(child); },
      };
    },
  };
  const context = {
    URL,
    crypto: {
      randomUUID() { return '123e4567-e89b-42d3-a456-426614174000'; },
      getRandomValues(bytes) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = i;
        return bytes;
      },
    },
    chrome: {
      runtime,
      storage: {
        sync: {
          get(_keys, callback) { queueMicrotask(() => callback({})); },
          set() {},
        },
      },
    },
    clearInterval,
    clearTimeout,
    console,
    document,
    isFinite,
    location: { pathname: '/watch' },
    setInterval,
    setTimeout,
    window: { scrollTo() {} },
  };
  vm.createContext(context);
  for (const file of ['youtube/core.js', ...files]) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('chat history keeps only complete turns at the 40-message boundary', () => {
  const { YTX } = loadYoutubeModules(['youtube/chat.js']);
  const messages = [];
  for (let i = 1; i <= 21; i++) {
    messages.push({ role: 'user', content: 'q' + i });
    messages.push({ role: 'assistant', content: 'a' + i });
  }
  messages.unshift({ role: 'assistant', content: 'orphan' });
  messages.push({ role: 'user', content: 'failed pending question' });

  const trimmed = plain(YTX.trimChatHistory(messages, 40));
  assert.equal(trimmed.length, 40);
  assert.equal(trimmed[0].role, 'user');
  assert.equal(trimmed[0].content, 'q2');
  assert.equal(trimmed.at(-1).role, 'assistant');
  assert.equal(trimmed.at(-1).content, 'a21');
});

test('stream starts require an explicit started ack and surface synchronous rejection', async () => {
  const { YTX } = loadYoutubeModules([]);
  YTX.sendToBg = async function () { return { started: false, error: 'YouTube 助手功能已关闭' }; };
  await assert.rejects(
    YTX.startStreamRequest({ type: 'SUMMARIZE', requestId: 'ack-reject' }),
    /YouTube 助手功能已关闭/
  );

  YTX.sendToBg = async function () { return { started: 1 }; };
  await assert.rejects(
    YTX.startStreamRequest({ type: 'SUMMARIZE', requestId: 'bad-ack' }),
    /未能启动/
  );

  const ack = { started: true };
  YTX.sendToBg = async function () { return ack; };
  assert.equal(await YTX.startStreamRequest({ type: 'SUMMARIZE', requestId: 'ok' }), ack);

  for (const file of ['summary.js', 'chat.js', 'html-notes.js', 'mindmap.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'youtube', file), 'utf8');
    assert.match(source, /await YTX\.startStreamRequest\(Object\.assign\(/, `${file} must verify its start ack`);
  }
});

test('a lost provider terminal cannot leave a YouTube feature busy forever', async () => {
  const { YTX } = loadYoutubeModules([]);
  const requestId = 'watchdog-request';
  let failure = '';
  YTX.STREAM_WATCHDOG_MS = 5;
  YTX.features.summary = {
    requestId,
    onError(message) {
      failure = message;
      this.requestId = null;
    },
  };
  YTX.sendToBg = async function () { return { started: true }; };

  await YTX.startStreamRequest({ type: 'SUMMARIZE', requestId });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.match(failure, /等待超时/);
  assert.equal(YTX.features.summary.requestId, null);
});

test('authoritative DONE text repairs a provider chunk lost during service-worker restart', () => {
  const { YTX } = loadYoutubeModules([]);
  const summary = { text: 'prefix', _newlineCount: 0 };
  assert.equal(YTX.applyAuthoritativeStreamText(summary, 'SUMMARY', 'prefix + recovered suffix'), true);
  assert.equal(summary.text, 'prefix + recovered suffix');

  const chat = { replyText: 'partial', _newlineCount: 0 };
  assert.equal(YTX.applyAuthoritativeStreamText(chat, 'CHAT', 'complete\nanswer'), true);
  assert.equal(chat.replyText, 'complete\nanswer');
  assert.equal(chat._newlineCount, 1);
  assert.equal(YTX.applyAuthoritativeStreamText(chat, 'CHAT', 'x'.repeat(YTX.CHAT_REPLY_MAX_CHARS + 1)), false);
});

test('chat history also enforces per-message and total character budgets', () => {
  const context = loadYoutubeModules(['youtube/chat.js']);
  const { YTX } = context;
  const messages = [
    { role: 'user', content: 'old-q' },
    { role: 'assistant', content: 'x'.repeat(50_001) },
    { role: 'user', content: 'q2'.repeat(10_000) },
    { role: 'assistant', content: 'a2'.repeat(10_000) },
    { role: 'user', content: 'latest' },
    { role: 'assistant', content: 'answer' },
  ];
  const trimmed = plain(YTX.trimChatHistory(messages, 40, 45_000));
  assert.deepEqual(trimmed.map(item => item.content), [
    'q2'.repeat(10_000), 'a2'.repeat(10_000), 'latest', 'answer',
  ]);
  assert.equal(YTX.CHAT_QUESTION_MAX_CHARS, 10_000);
  assert.equal(YTX.CHAT_HISTORY_MAX_CHARS <= 240_000, true);
  assert.match(YTX.features.chat.contentHtml(), /ytx-chat-input-frame/);
  assert.doesNotMatch(YTX.features.chat.contentHtml(), /id="ytx-chat-input"/);
  assert.equal(YTX.makeCapabilityToken(), '123e4567e89b42d3a456426614174000');
  assert.match(YTX.makeCapabilityToken(), /^[a-f0-9]{32}$/);
  const originalRandomUUID = context.crypto.randomUUID;
  context.crypto.randomUUID = function () { return 'invalid'; };
  assert.match(YTX.makeCapabilityToken(), /^[a-f0-9]{64}$/);
  context.crypto.randomUUID = originalRandomUUID;
});

test('mind-map normalization rejects bad schemas and strips render metadata', () => {
  const { YTX } = loadYoutubeModules(['youtube/mindmap.js']);
  const child = { label: 'Child', time: '100:00', children: [], _x: 10 };
  const input = {
    label: 'Root',
    children: [child],
    _visibleChildren: [child],
    _subtreeHeight: 999,
  };

  const normalized = plain(YTX.normalizeMindmapData(input));
  assert.deepEqual(normalized, {
    label: 'Root',
    time: '',
    children: [{ label: 'Child', time: '100:00', children: [] }],
  });
  assert.ok(JSON.stringify(normalized).length < JSON.stringify(input).length);
  assert.throws(() => YTX.normalizeMindmapData({ label: 'Root', children: 'bad' }), /children/);
  assert.throws(() => YTX.normalizeMindmapData({ label: '', children: [] }), /label/);
});

test('structured HTML notes distinguish malformed JSON from legacy HTML and emit real timestamp links', () => {
  const { YTX } = loadYoutubeModules(['youtube/export.js', 'youtube/html-notes.js']);
  YTX.currentVideoId = 'abcdefghijk';

  const malformed = '{"summary":"broken"';
  assert.equal(YTX.HtmlNotes.parseNote(malformed), null);
  assert.equal(YTX.HtmlNotes.isLikelyJsonOutput(malformed), true);
  assert.equal(YTX.HtmlNotes.isLikelyJsonOutput('<!doctype html><p>legacy</p>'), false);

  const data = YTX.HtmlNotes.parseNote(JSON.stringify({
    summary: 'Summary',
    keyPoints: [{ time: '100:00', text: 'Long video point' }],
    sections: [],
    tags: [],
  }));
  assert.ok(data);
  const html = YTX.HtmlNotes.buildNoteHtml(data);
  assert.match(html, /watch\?v=abcdefghijk(?:&|&amp;)t=6000s/);
  assert.match(html, />100:00<\/a>/);

  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('抱歉，无法生成笔记'), false);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<p>Sorry, I cannot generate that.</p>'), false);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<div>抱歉，无法生成笔记</div>'), false);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<section><p>抱歉，无法生成笔记</p></section>'), false);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<main><h1>视频笔记</h1><p>摘要内容</p></main>'), true);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<!doctype html><html><body><p>历史笔记</p></body></html>'), true);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<div>' + '<span></span>'.repeat(10_001) + '</div>'), false);
  assert.equal(YTX.HtmlNotes.isLegacyHtmlOutput('<div>' + 'x'.repeat(YTX.LEGACY_HTML_MAX_CHARS) + '</div>'), false);
  assert.equal(YTX.HtmlNotes.parseNote(JSON.stringify({ summary: {}, keyPoints: [], sections: [] })), null);
});

test('Markdown rendering and stream batching remain bounded under newline and tiny-chunk floods', () => {
  const { YTX } = loadYoutubeModules(['youtube/markdown.js']);
  const newlineFlood = 'x\n'.repeat(YTX.MARKDOWN_OUTPUT_MAX_LINES);
  assert.equal(YTX.markdownMetrics(newlineFlood), null);
  const bounded = YTX.limitMarkdownForRender(newlineFlood);
  assert.ok(bounded.length <= YTX.MARKDOWN_OUTPUT_MAX_CHARS);
  assert.ok(bounded.split('\n').length <= YTX.MARKDOWN_OUTPUT_MAX_LINES);
  assert.doesNotThrow(() => YTX.renderMarkdown(newlineFlood));

  const batch = YTX.createChunkBatch(YTX.TRANSCRIPT_MAX_CHARS, 256);
  for (let i = 0; i < 50_000; i++) assert.equal(batch.push('x'), true);
  const stats = plain(batch.stats());
  assert.equal(stats.chars, 50_000);
  assert.ok(stats.blocks <= Math.ceil(50_000 / 256));
  assert.equal(batch.drain(), 'x'.repeat(50_000));
  assert.deepEqual(plain(batch.stats()), { chars: 0, blocks: 0, chunks: 0 });
});

test('YouTube private UI uses an extension iframe and disables cross-document selection leakage', () => {
  const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'chat-frame.html'), 'utf8');
  const chatJs = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'chat-frame.js'), 'utf8');
  const chatFeatureJs = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'chat.js'), 'utf8');
  const htmlNotesJs = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'html-notes.js'), 'utf8');
  const exportJs = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'export.js'), 'utf8');
  const panelJs = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'panel.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'youtube', 'content.css'), 'utf8');
  const allYoutubeJs = fs.readdirSync(path.join(__dirname, '..', 'youtube'))
    .filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(__dirname, '..', 'youtube', file), 'utf8'))
    .join('\n');

  assert.match(chatHtml, /Content-Security-Policy/);
  assert.match(chatHtml, /spellcheck="false"/);
  assert.match(chatHtml, /autocomplete="off"/);
  assert.match(chatHtml, /maxlength="10000"/);
  assert.match(chatJs, /chrome\.runtime\.onMessage\.addListener/);
  assert.doesNotMatch(chatJs, /window\.addEventListener\(['"]message/);
  assert.match(chatFeatureJs, /YTX_CHAT_FRAME_STATE_RELAY/);
  assert.match(chatFeatureJs, /YTX\.makeCapabilityToken\(\)/);
  assert.doesNotMatch(chatFeatureJs, /makeRequestId\(\)\s*\+\s*YTX\.makeRequestId/);
  assert.match(chatJs, /\[a-f0-9\]\{32\}/);
  assert.match(panelJs, /fetch\(chrome\.runtime\.getURL\('youtube\/content\.css'\)/);
  const chunkRoute = panelJs.slice(
    panelJs.indexOf("message.type === 'TRANSCRIBE_CHUNK'"),
    panelJs.indexOf("message.type === 'TRANSCRIBE_PROGRESS'")
  );
  assert.match(chunkRoute, /queueTranscribeChunk/);
  assert.doesNotMatch(chunkRoute, /\.split\s*\(/);
  assert.match(panelJs, /_transcribeScanOffset/);
  assert.match(panelJs, /window\.addEventListener\('pagehide', onPageHide\)/);
  assert.match(panelJs, /window\.addEventListener\('pageshow', onPageShow\)/);
  assert.match(panelJs, /event\.persisted !== true/);
  assert.match(panelJs, /YTX\.currentVideoId = null;[\s\S]*?removePanel\(\);[\s\S]*?onNavigate\(\);/);
  assert.match(panelJs, /settleTranscribeDeferred\(transcribeRequestId, new Error/);
  assert.match(css, /user-select:\s*none/);
  assert.match(htmlNotesJs, /sandbox['"],\s*['"]allow-popups allow-popups-to-escape-sandbox/);
  assert.doesNotMatch(htmlNotesJs, /sandbox['"],\s*['"][^'"]*allow-same-origin/);
  assert.match(htmlNotesJs, /noopener,noreferrer/);
  assert.match(allYoutubeJs, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
  assert.match(exportJs, /name === 'ping'/);
  assert.match(exportJs, /script, template, base/);
  assert.match(exportJs, /applet, svg, math/);
  assert.match(exportJs, /animate, set, animateMotion, animateTransform, discard/);
  assert.doesNotMatch(allYoutubeJs, /execCommand\s*\(/);
});

test('Obsidian metadata escapes backslashes and uses the local calendar date', () => {
  const { YTX } = loadYoutubeModules(['youtube/export.js']);
  assert.equal(YTX.Export.yamlString('title\\'), '"title\\\\"');
  assert.equal(YTX.Export.yamlString('a"b'), '"a\\"b"');
  assert.equal(YTX.Export.localDate(new Date(2026, 0, 2, 1, 30)), '2026-01-02');
  const safe = YTX.Export.sanitizeMarkdownForExport([
    '![inline](https://evil.example/a.png)',
    '![ref][img]',
    '![shortcut]',
    '![[obsidian-embed]]',
    '[run](ObSiDiAn://open?vault=x)',
    '[local][target]',
    '[target]: file:///etc/passwd',
    '<javascript:alert(1)>',
    'data:text/html,boom',
    'vscode:file/workspace',
    'custom+app://singlehost/path',
    'x://handler/payload',
    'a://b',
    'steam:run/123',
    'foo:payload',
    'x\\:escaped-handler',
    'key:value',
    String.raw`\/\/evil\.example/path`,
    String.raw`foo\:\/\/evil\.example/path`,
    String.raw`\/\/127\.0\.0\.1/x`,
    String.raw`foo\@example\.com`,
    'https&#58;//evil.example/entity',
    'obsidian&#x3a;//open?vault=x',
    'h&#116;tp&#58;//evil.example/entity-letter',
    '&#106;&#97;vascript&#x3a;alert(2)',
    'java\u200bscript:alert(3)',
    'java\u00adscript:alert(4)',
    'java\u061cscript:alert(5)',
    'java\u180escript:alert(6)',
    'ｊａｖａｓｃｒｉｐｔ：alert(7)',
    '𝐣𝐚𝐯𝐚𝐬𝐜𝐫𝐢𝐩𝐭:alert(8)',
    '//evil.example/path',
    '//例子.测试/path',
    'https：／／evil．example/path',
    'www.evil.example/path',
    'evil.example/path',
    'evil。example/path',
    'evil\u2024example/path',
    'evil\uFE52example/path',
    '例子.测试/path',
    'evil.xn--p1ai/path',
    'foo@example.com',
    'foo＠example．com',
    '192.168.1.10/admin',
    '192．168．1．10/admin',
    'localhost:8787/private',
    'localhost：8787/private',
    'file\\:///etc/passwd',
    '\\[escaped](https://evil.example/escaped)',
    '<img src="https://evil.example/raw.png">',
    '```dataviewjs\ndv.paragraph("owned")\n```',
    '~~~javascript\nalert(1)\n~~~',
    '`$= dv.current()`',
    '｀｀｀dataviewjs\ndv.paragraph("nfkc")\n｀｀｀',
    '`＄＝ dv.current()`',
  ].join('\n'));
  assert.doesNotMatch(safe, /!\[/);
  assert.doesNotMatch(safe, /(^|[^&])\[/);
  assert.doesNotMatch(safe, /<img/i);
  assert.match(safe, /&lt;img/);
  assert.doesNotMatch(safe, /\b(?:https?|file|obsidian|javascript|data|vscode)\s*:/i);
  assert.doesNotMatch(safe, /custom\+app:\/\//i);
  assert.doesNotMatch(safe, /(?:^|\s)(?:x:\/\/|a:\/\/|steam:run|foo:payload|x\\?:escaped-handler|key:value)/im);
  assert.doesNotMatch(safe, /h&#116;tp|&#106;&#97;vascript/i);
  assert.doesNotMatch(safe, /(^|[^:])\/\/(?=[A-Za-z0-9])/m);
  assert.doesNotMatch(safe, /\b(?:www\.)?evil\.example\b/i);
  assert.doesNotMatch(safe, /\/\/例子\.测试|例子\.测试|evil\.xn--p1ai/u);
  assert.doesNotMatch(safe, /foo@example\.com|192\.168\.1\.10|localhost:8787/i);
  const normalized = safe.normalize('NFKC');
  assert.doesNotMatch(normalized, /\b(?:https?|file|obsidian|javascript|data)\s*:/i);
  assert.doesNotMatch(normalized, /(?:^|\s)(?:x:\/\/|a:\/\/|steam:run|foo:payload|x\\?:escaped-handler|key:value)/im);
  assert.doesNotMatch(normalized, /(?:evil|例子)\.(?:example|测试)|foo@example\.com|192\.168\.1\.10|localhost:8787/iu);
  const afterCommonmarkUnescape = normalized.replace(/\\+./g, (match) => {
    const punctuation = match.at(-1);
    return "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".includes(punctuation)
      ? punctuation
      : match;
  });
  assert.doesNotMatch(afterCommonmarkUnescape, /(^|[^:])\/\/(?=[A-Za-z0-9])/m);
  assert.doesNotMatch(afterCommonmarkUnescape, /(?:evil\.example|127\.0\.0\.1|foo@example\.com)/i);
  assert.match(safe, /```text[\s\S]*?```/);
  assert.match(safe, /~~~text[\s\S]*?~~~/);
  assert.doesNotMatch(safe, /```dataviewjs|~~~javascript|\$=/i);
  assert.doesNotMatch(safe.normalize('NFKC'), /```dataviewjs|~~~javascript|\$=/i);
});

test('AI stream buffers enforce one shared cap and every feature fails closed on overflow', async () => {
  const { YTX } = loadYoutubeModules([
    'youtube/export.js',
    'youtube/summary.js',
    'youtube/chat.js',
    'youtube/html-notes.js',
    'youtube/mindmap.js',
  ]);

  assert.equal(YTX.AI_OUTPUT_MAX_CHARS, 1_000_000);
  assert.equal(YTX.appendCappedText('ab', 'cd', 4), 'abcd');
  assert.equal(YTX.appendCappedText('ab', 'cd', 3), null);
  assert.equal(YTX.appendCappedText('', 123, 10), null);

  const panelElement = {
    classList: { add() {}, remove() {} },
    disabled: false,
    focus() {},
    innerHTML: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollHeight: 0,
    scrollTop: 0,
  };
  YTX.panel = { querySelector() { return panelElement; } };
  YTX.btnPrimary = function () {};
  YTX.renderMarkdown = function () { return ''; };
  const cancelled = [];
  const errors = [];
  const cacheWrites = [];
  YTX.cancelRequest = function (requestId) {
    cancelled.push(requestId);
    return Promise.resolve(true);
  };
  YTX.renderError = function (_element, message) { errors.push(String(message)); };
  YTX.cache.save = function () { cacheWrites.push([...arguments]); return Promise.resolve(true); };

  const atLimit = 'x'.repeat(YTX.AI_OUTPUT_MAX_CHARS);
  const cases = [
    { feature: YTX.features.summary, buffer: 'text', active: 'isGenerating', deferred: true },
    { feature: YTX.features.chat, buffer: 'replyText', active: 'isChatting', deferred: false },
    { feature: YTX.features.html, buffer: 'text', active: 'isGenerating', deferred: true },
    { feature: YTX.features.mindmap, buffer: 'rawText', active: 'isGenerating', deferred: true },
  ];

  for (const [index, item] of cases.entries()) {
    const requestId = `overflow-${index}`;
    const feature = item.feature;
    feature.requestId = requestId;
    feature[item.buffer] = atLimit;
    feature[item.active] = true;
    feature._pendingTurn = { user: { role: 'user', content: 'q' }, baseHistory: [] };
    if (feature.cleanupZoomPan) feature.cleanupZoomPan = function () {};

    let rejected = null;
    if (item.deferred) {
      feature._deferred = YTX.createDeferred();
      rejected = feature._deferred.promise.then(
        () => null,
        error => error
      );
    }

    feature.onChunk('!');

    assert.equal(feature[item.buffer].length, YTX.AI_OUTPUT_MAX_CHARS, `${requestId} must stop accumulating`);
    assert.equal(feature[item.buffer].endsWith('!'), false, `${requestId} must discard the overflow chunk`);
    assert.equal(feature.requestId, null, `${requestId} must become unroutable`);
    assert.equal(feature[item.active], false, `${requestId} must leave the active state`);
    assert.ok(cancelled.includes(requestId), `${requestId} must cancel the background stream`);
    assert.match(errors.at(-1), /过长|上限|限制/, `${requestId} must expose a bounded-output error`);
    if (rejected) {
      const error = await rejected;
      assert.match(String(error && error.message), /过长|上限|限制/);
      assert.equal(feature._deferred, null);
    }
  }

  assert.equal(cacheWrites.length, 0, 'overflowed partial output must never be cached');
});
