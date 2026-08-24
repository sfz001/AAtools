'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('manifest keeps arbitrary gateway access optional and enables translation in frames', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const required = new Set(manifest.host_permissions || []);
  const optional = new Set(manifest.optional_host_permissions || []);

  assert.ok((manifest.permissions || []).includes('offscreen'));

  assert.equal(required.has('https://*/*'), false);
  assert.equal(required.has('http://*/*'), false);
  assert.equal(optional.has('https://*/*'), true);
  assert.equal(optional.has('http://localhost/*'), true);
  assert.equal(optional.has('http://127.0.0.1/*'), true);
  assert.equal(required.has('https://auth.openai.com/*'), true);
  assert.equal(required.has('https://chatgpt.com/*'), true);

  const translation = manifest.content_scripts.find(group =>
    Array.isArray(group.js) && group.js.includes('translate/translate.js'));
  assert.ok(translation, 'translation content script is declared');
  assert.equal(translation.all_frames, true);

  const xhs = manifest.content_scripts.find(group =>
    Array.isArray(group.js) && group.js.includes('xhs/xhs-scroll-fix.js'));
  assert.ok(xhs, 'XHS scroll fix is declared');
  assert.equal(xhs.run_at, 'document_start');

  const exposed = (manifest.web_accessible_resources || []).flatMap(group => group.resources || []);
  assert.equal(exposed.some(resource => resource.startsWith('offscreen/')), false,
    'offscreen host and worker must never be web-accessible resources');
});

test('long provider fetches exist only in the dedicated offscreen worker', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'offscreen/network-worker.js'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'offscreen/network-host.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'offscreen/network-host.html'), 'utf8');

  assert.match(worker, /await fetch\(request\.url/);
  assert.doesNotMatch(background, /api\.(?:anthropic|openai|minimax|deepseek|moonshot)[^\n]+fetch|fetch\([^\n]+chatgpt\.com/);
  assert.match(host, /chrome\.runtime\.connect\(\{ name: PORT_NAME \}\)/);
  assert.doesNotMatch(host, /runtime\.sendMessage/);
  assert.match(html, /worker-src 'self'/);
  assert.match(html, /connect-src https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/,
    'offscreen CSP must allow an explicitly authorized loopback gateway on any port');
});

test('content scripts do not use page-controlled takeover events', () => {
  const files = [
    'youtube/panel.js',
    'translate/translate.js',
    'gestures/gestures.js',
    'xhs/xhs-scroll-fix.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /aatools-takeover-/i, file);
  }

  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.doesNotMatch(background, /reinjectContentScripts/i);

  const xhs = fs.readFileSync(path.join(root, 'xhs/xhs-scroll-fix.js'), 'utf8');
  assert.match(xhs, /document\.addEventListener\('wheel',\s*handleWheel/);
  assert.match(xhs, /stopImmediatePropagation\(\)/);
});
