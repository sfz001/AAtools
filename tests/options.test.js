'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadOptions() {
  const elements = new Map();
  const permissionRequests = [];
  const permissionRemovals = [];
  const savedSettings = [];
  let requestGranted = true;

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        checked: false,
        className: '',
        textContent: '',
        value: '',
      });
    }
    return elements.get(selector);
  }

  const runtime = {
    id: 'test-extension',
    lastError: null,
  };
  const context = {
    URL,
    chrome: {
      permissions: {
        request(query, callback) {
          permissionRequests.push(query);
          callback(requestGranted);
        },
        remove(query, callback) {
          permissionRemovals.push(query);
          callback(true);
        },
      },
      runtime,
      storage: {
        sync: {
          set(data, callback) {
            savedSettings.push(structuredClone(data));
            callback();
          },
        },
      },
    },
    clearTimeout() {},
    console,
    document: {
      addEventListener() {},
      querySelector(selector) { return element(selector); },
    },
    setTimeout() { return 1; },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'options.js' });
  return {
    context,
    element,
    permissionRemovals,
    permissionRequests,
    savedSettings,
    setRequestGranted(value) { requestGranted = value; },
  };
}

test('gateway permission request uses the exact normalized origin including port', async () => {
  const loaded = loadOptions();
  loaded.element('#sub2apiBaseUrl').value = 'https://gateway.example:8443/api';

  const granted = await new Promise(resolve => loaded.context.requestGatewayPermission('sub2api', resolve));
  assert.equal(granted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.permissionRequests)), [{ origins: ['https://gateway.example:8443/*'] }]);

  loaded.setRequestGranted(false);
  const denied = await new Promise(resolve => loaded.context.requestGatewayPermission('sub2api', resolve));
  assert.equal(denied, false);
});

test('automatic saves keep the last authorized gateway instead of persisting an unapproved draft', () => {
  const loaded = loadOptions();
  loaded.context.setSavedGatewayBase('sub2api', 'https://approved.example');
  loaded.element('#sub2apiBaseUrl').value = 'https://unapproved.example';

  loaded.context.saveSettings(false);
  assert.equal(loaded.savedSettings[0].sub2apiBaseUrl, 'https://approved.example');
});

test('a gateway changed while the permission prompt is open cannot be committed under the old grant', () => {
  const loaded = loadOptions();
  let permissionCallback;
  let authorization;
  loaded.context.chrome.permissions.request = (_query, callback) => { permissionCallback = callback; };
  loaded.element('#sub2apiBaseUrl').value = 'https://first.example/api';
  loaded.context.requestGatewayPermission('sub2api', (granted, value) => {
    assert.equal(granted, true);
    authorization = value;
  });

  loaded.element('#sub2apiBaseUrl').value = 'https://second.example/api';
  permissionCallback(true);
  assert.equal(loaded.context.saveAuthorizedGateway(authorization), false);
  assert.equal(loaded.savedSettings.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.permissionRemovals)), [{ origins: ['https://first.example/*'] }]);

  // Path changes under the same authorized origin are safe and use the current captured field value.
  const sameOrigin = loadOptions();
  sameOrigin.element('#sub2apiBaseUrl').value = 'https://first.example/api';
  let sameOriginAuthorization;
  sameOrigin.context.requestGatewayPermission('sub2api', (_granted, value) => { sameOriginAuthorization = value; });
  sameOrigin.element('#sub2apiBaseUrl').value = 'https://first.example/other-api';
  assert.equal(sameOrigin.context.saveAuthorizedGateway(sameOriginAuthorization), true);
  assert.equal(sameOrigin.savedSettings[0].sub2apiBaseUrl, 'https://first.example/other-api');
});

test('unused historical gateway permissions are revoked but shared and required origins are retained', () => {
  const loaded = loadOptions();
  loaded.context.setSavedGatewayBase('sub2api', 'https://shared.example');
  loaded.context.setSavedGatewayBase('sub2api2', 'https://shared.example');
  loaded.context.revokeGatewayOriginIfUnused('https://shared.example/*');
  assert.equal(loaded.permissionRemovals.length, 0);

  loaded.context.setSavedGatewayBase('sub2api', '');
  loaded.context.setSavedGatewayBase('sub2api2', '');
  loaded.context.revokeGatewayOriginIfUnused('https://shared.example/*');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.permissionRemovals)), [{ origins: ['https://shared.example/*'] }]);

  loaded.context.revokeGatewayOriginIfUnused('https://api.openai.com/*');
  assert.equal(loaded.permissionRemovals.length, 1);
});

test('import validation rejects invalid providers, types, URLs, and model-list shapes', () => {
  const { context } = loadOptions();
  const settingKeys = ['provider', 'sub2apiBaseUrl', 'enableGestures'];
  const localKeys = ['fetchedModels_openai'];

  assert.throws(() => context.validateImportedSettings({ provider: 'unknown' }, settingKeys, localKeys), /无效的 AI 服务商/);
  assert.throws(() => context.validateImportedSettings({ enableGestures: 'yes' }, settingKeys, localKeys), /类型无效/);
  assert.throws(() => context.validateImportedSettings({ sub2apiBaseUrl: 'http://evil.example' }, settingKeys, localKeys), /HTTPS/);
  assert.throws(() => context.validateImportedSettings({
    fetchedModels_openai: [{ value: 'gpt-test' }],
  }, settingKeys, localKeys), /模型列表/);

  const valid = context.validateImportedSettings({
    provider: 'sub2api',
    sub2apiBaseUrl: 'https://gateway.example:9443/api',
    enableGestures: true,
    fetchedModels_openai: [{ value: 'gpt-test', label: 'GPT Test', extra: 'discarded' }],
  }, settingKeys, localKeys);
  assert.equal(valid.filtered.sub2apiBaseUrl, 'https://gateway.example:9443/api');
  assert.deepEqual(JSON.parse(JSON.stringify(valid.localFiltered.fetchedModels_openai)), [
    { value: 'gpt-test', label: 'GPT Test' },
  ]);
});
