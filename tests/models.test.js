'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const models = require('../models.js');

test('only current catalog models can be selected and used as provider defaults', () => {
  for (const [provider, config] of Object.entries(models.providers)) {
    assert.ok(config.models.length);
    assert.equal(models.defaults[provider], config.models[0].value);
    assert.equal(new Set(config.models.map(m => m.value)).size, config.models.length);
    for (const model of config.models) {
      assert.equal(models.isSelectable(provider, model.value), true, provider + ': ' + model.value);
      assert.equal(models.sanitizeModel(provider, model.value), model.value);
    }
  }
  assert.deepEqual(models.providers.sub2api.models.map(m => m.value),
    ['claude', 'openai', 'gemini'].flatMap(p => models.providers[p].models.map(m => m.value)));
});

const migrations = [
  ['claude', 'claude-opus-5', 'claude-opus-5-5'],
  ['claude', 'claude-opus-4-20250514', 'claude-opus-5-5'],
  ['claude', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5-5'],
  ['claude', 'claude-haiku-4-5', 'claude-haiku-5-5'],
  ['claude', 'claude-3-haiku-20240307', 'claude-haiku-5-5'],
  ['claude', 'claude-3-5-sonnet-20241022', 'claude-sonnet-5-5'],
  ['claude', 'claude-instant-1.2', 'claude-haiku-5-5'],
  ['claude', 'claude-mythos-5', 'claude-fable-5-1'],
  ['claude', 'claude-fable-5', 'claude-fable-5-1'],
  ['claude', 'claude-2.1', 'claude-fable-5-1'],
  ['openai', 'gpt-5.6-sol', 'gpt-6.1-sol'],
  ['openai', 'gpt-6-sol', 'gpt-6.1-sol'],
  ['openai', 'gpt-4.1', 'gpt-6.1-sol'],
  ['openai', 'gpt-4o-mini', 'gpt-6-luna'],
  ['openai', 'gpt-4.1-nano', 'gpt-6-luna'],
  ['openai', 'gpt-5.2-pro', 'gpt-6-astra'],
  ['chatgpt', 'gpt-5.6-terra', 'gpt-6.1-sol'],
  ['chatgpt', 'gpt-5.4', 'gpt-6.1-sol'],
  ['chatgpt', 'gpt-5.6-luna', 'gpt-6-luna'],
  ['gemini', 'gemini-2.0-flash', 'gemini-3.8-flash'],
  ['gemini', 'gemini-3.7-flash', 'gemini-3.8-flash'],
  ['gemini', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
  ['gemini', 'gemini-3.1-flash-lite-preview', 'gemini-3.5-flash-lite'],
  ['gemini', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'],
  ['gemini', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
  ['deepseek', 'deepseek-chat', 'deepseek-flash'],
  ['deepseek', 'deepseek-reasoner', 'deepseek-flash'],
  ['deepseek', 'deepseek-v4-flash', 'deepseek-flash'],
  ['deepseek', 'deepseek-v4-flash-vision-exp', 'deepseek-flash'],
  ['kimi', 'kimi-k2.5', 'kimi-k3'],
  ['kimi', 'kimi-k2.6', 'kimi-k3'],
  ['kimi', 'kimi-k2.7-code', 'kimi-k3'],
  ['kimi', 'moonshot-v1-32k', 'kimi-k3'],
  ['minimax', 'MiniMax-M2.5', 'MiniMax-M3'],
  ['minimax', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3'],
  ['sub2api', 'claude-fable-5', 'claude-fable-5-1'],
  ['sub2api', 'claude-haiku-4-5', 'claude-haiku-5-5'],
  ['sub2api', 'gemini-2.5-flash', 'gemini-3.8-flash'],
  ['sub2api', 'gemini-3.7-flash', 'gemini-3.8-flash'],
  ['sub2api', 'gemini-2.5-pro', 'gemini-3.1-pro-preview'],
  ['sub2api', 'GPT_5.6', 'gpt-6.1-sol'],
];

test('saved old IDs migrate by family but are never selectable', () => {
  for (const [provider, oldModel, current] of migrations) {
    assert.equal(models.isSelectable(provider, oldModel), false, provider + ': ' + oldModel);
    assert.equal(models.sanitizeModel(provider, oldModel), current, provider + ': ' + oldModel);
    assert.equal(models.isSelectable(provider, current), true);
    assert.equal(models.sanitizeModel(provider, current), current);
  }
});

test('unknown and incompatible IDs cannot enter the text catalog', () => {
  for (const [provider, model] of [
    ['openai', 'gpt-image-1'], ['openai', 'gpt-5-codex'], ['chatgpt', 'gpt-5-codex'],
    ['openai', 'gpt-realtime'], ['openai', 'gpt-6.1-sol-audio'],
    ['gemini', 'gemini-3.8-flash-tts'], ['gemini', 'gemini-3.1-flash-image'],
    ['openai', 'claude-fable-5-1'], ['claude', 'gpt-6.1-sol'],
    ['kimi', 'gpt-6.1-sol'], ['minimax', 'image-01'],
    ['sub2api', 'custom-gateway-model'], ['unknown', 'gpt-6.1-sol'],
    ['openai', null], ['gemini', ''], ['claude', '   '],
  ]) {
    assert.equal(models.isSelectable(provider, model), false, String(model));
    assert.equal(models.sanitizeModel(provider, model), '', String(model));
  }
  assert.equal(models.isSelectable('openai', 'gpt-7-new'), false);
});

test('thinking policies cover each current family and exclude obsolete IDs', () => {
  assert.equal(models.getPolicy('claude', 'claude-sonnet-5-5').thinkingType, 'between_tools');
  assert.equal(models.getPolicy('claude', 'claude-haiku-5-5').thinkingType, 'disabled');
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5']) {
    const policy = models.getPolicy('claude', model);
    assert.equal(policy.thinkingType, null);
    assert.equal(policy.effortField, 'output_config');
    assert.equal(policy.minOutputTokens, 16000);
  }
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']) {
    for (const provider of ['openai', 'chatgpt', 'sub2api']) {
      assert.equal(models.getPolicy(provider, model).effortField, 'reasoning_effort');
      assert.equal(models.getPolicy(provider, model).minOutputTokens, 16000);
    }
  }
  assert.equal(models.getPolicy('gemini', 'gemini-3.5-flash-lite').effortField, null);
  assert.equal(models.getPolicy('gemini', 'gemini-3.8-flash').effortField, 'thinkingLevel');
  assert.equal(models.getPolicy('gemini', 'gemini-3.1-pro-preview').effortField, 'thinkingLevel');
  assert.equal(models.getPolicy('deepseek', 'deepseek-flash').thinkingType, 'disabled');
  assert.equal(models.getPolicy('deepseek', 'deepseek-v4-pro').thinkingType, 'disabled');
  assert.equal(models.getPolicy('minimax', 'MiniMax-M3').reasoningSplit, true);
  assert.equal(models.getPolicy('minimax', 'MiniMax-M3').disableThinking, true);
  assert.equal(models.getPolicy('kimi', 'kimi-k3').defaultEffort, 'low');
  assert.equal(models.getPolicy('kimi', 'kimi-k3').minOutputTokens, 16000);
  for (const [provider, oldModel] of migrations) {
    assert.equal(models.getPolicy(provider, oldModel).effortField, null, oldModel);
    assert.equal(models.getPolicy(provider, oldModel).thinkingType, null, oldModel);
  }
});
