// Shared provider catalog and request capabilities for the worker and settings page.
// Verified 2026-10-11. Only the latest supported model in each product family is selectable.
// Sources:
// https://developers.openai.com/api/docs/guides/latest-model
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/build-with-claude/thinking
// https://ai.google.dev/gemini-api/docs/deprecations
// https://api-docs.deepseek.com/quick_start/pricing/
// https://platform.minimax.io/docs/guides/models-intro
// https://platform.kimi.com/docs/models
(function (scope) {
  'use strict';
  const providers = {
  "claude": {
    "label": "Claude API Key",
    "keyField": "claudeKey",
    "placeholder": "sk-ant-api03-...",
    "helpUrl": "https://console.anthropic.com/settings/keys",
    "models": [
      {
        "value": "claude-fable-5-1",
        "label": "Fable 5.1 — 深度推理"
      },
      {
        "value": "claude-opus-5-5",
        "label": "Opus 5.5 — 综合能力"
      },
      {
        "value": "claude-sonnet-5-5",
        "label": "Sonnet 5.5 — 速度与质量兼顾"
      },
      {
        "value": "claude-haiku-5-5",
        "label": "Haiku 5.5 — 快速低价"
      }
    ]
  },
  "openai": {
    "label": "OpenAI API Key",
    "keyField": "openaiKey",
    "placeholder": "sk-...",
    "helpUrl": "https://platform.openai.com/api-keys",
    "models": [
      {
        "value": "gpt-6.1-sol",
        "label": "GPT-6.1 Sol — 推荐，兼顾质量与成本"
      },
      {
        "value": "gpt-6-astra",
        "label": "GPT-6 Astra — 复杂任务"
      },
      {
        "value": "gpt-6-luna",
        "label": "GPT-6 Luna — 快速轻量"
      }
    ]
  },
  "chatgpt": {
    "label": "ChatGPT 订阅授权",
    "keyField": null,
    "placeholder": "",
    "helpUrl": "https://developers.openai.com/codex/cli/",
    "models": [
      {
        "value": "gpt-6.1-sol",
        "label": "GPT-6.1 Sol — 推荐，兼顾质量与成本"
      },
      {
        "value": "gpt-6-astra",
        "label": "GPT-6 Astra — 复杂任务"
      },
      {
        "value": "gpt-6-luna",
        "label": "GPT-6 Luna — 快速轻量"
      }
    ]
  },
  "gemini": {
    "label": "Gemini API Key",
    "keyField": "geminiKey",
    "placeholder": "AIza...",
    "helpUrl": "https://aistudio.google.com/apikey",
    "models": [
      {
        "value": "gemini-3.8-flash",
        "label": "Gemini 3.8 Flash — 推荐"
      },
      {
        "value": "gemini-3.5-flash-lite",
        "label": "Gemini 3.5 Flash-Lite — 快速低价"
      },
      {
        "value": "gemini-3.1-pro-preview",
        "label": "Gemini 3.1 Pro — 预览版"
      }
    ]
  },
  "minimax": {
    "label": "MiniMax API Key",
    "keyField": "minimaxKey",
    "placeholder": "eyJ...",
    "helpUrl": "https://platform.minimax.io/console/access",
    "models": [
      {
        "value": "MiniMax-M3",
        "label": "MiniMax-M3 — 1M 上下文"
      }
    ]
  },
  "deepseek": {
    "label": "DeepSeek API Key",
    "keyField": "deepseekKey",
    "placeholder": "sk-...",
    "helpUrl": "https://platform.deepseek.com/api_keys",
    "models": [
      {
        "value": "deepseek-flash",
        "label": "DeepSeek V4.1 Flash — 推荐"
      },
      {
        "value": "deepseek-v4-pro",
        "label": "DeepSeek V4 Pro"
      }
    ]
  },
  "kimi": {
    "label": "Kimi API Key",
    "keyField": "kimiKey",
    "placeholder": "sk-...",
    "helpUrl": "https://platform.kimi.com/console/api-keys",
    "models": [
      {
        "value": "kimi-k3",
        "label": "Kimi K3 — 1M 上下文"
      }
    ]
  },
  "sub2api": {
    "label": "Sub2API API Key",
    "keyField": "sub2apiKey",
    "placeholder": "sk-...",
    "helpUrl": "https://github.com/Wei-Shaw/sub2api",
    "models": [
      {
        "value": "claude-fable-5-1",
        "label": "Fable 5.1 — 深度推理（需网关支持）"
      },
      {
        "value": "claude-opus-5-5",
        "label": "Opus 5.5 — 综合能力（需网关支持）"
      },
      {
        "value": "claude-sonnet-5-5",
        "label": "Sonnet 5.5 — 速度与质量兼顾（需网关支持）"
      },
      {
        "value": "claude-haiku-5-5",
        "label": "Haiku 5.5 — 快速低价（需网关支持）"
      },
      {
        "value": "gpt-6.1-sol",
        "label": "GPT-6.1 Sol — 推荐，兼顾质量与成本（需网关支持）"
      },
      {
        "value": "gpt-6-astra",
        "label": "GPT-6 Astra — 复杂任务（需网关支持）"
      },
      {
        "value": "gpt-6-luna",
        "label": "GPT-6 Luna — 快速轻量（需网关支持）"
      },
      {
        "value": "gemini-3.8-flash",
        "label": "Gemini 3.8 Flash — 推荐（需网关支持）"
      },
      {
        "value": "gemini-3.5-flash-lite",
        "label": "Gemini 3.5 Flash-Lite — 快速低价（需网关支持）"
      },
      {
        "value": "gemini-3.1-pro-preview",
        "label": "Gemini 3.1 Pro — 预览版（需网关支持）"
      }
    ]
  }
};
  const defaults = Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, provider.models[0].value]));
  function normalizeModel(provider, model) {
    if (typeof model !== 'string') return '';
    return provider === 'sub2api'
      ? model.trim().replace(/^(gpt|claude|gemini)[\s_-]*(?=\d)/i, (_, prefix) => prefix.toLowerCase() + '-')
      : model.trim();
  }
  function isSelectable(provider, model) {
    if (!Object.prototype.hasOwnProperty.call(providers, provider)) return false;
    const id = normalizeModel(provider, model);
    return providers[provider].models.some(model => model.value === id);
  }
  // Old saved selections migrate by product family. API model lists and caches
  // must use isSelectable so an old alias cannot reappear as a selectable option.
  function sanitizeModel(provider, model) {
    if (!Object.prototype.hasOwnProperty.call(providers, provider)) return '';
    const id = normalizeModel(provider, model);
    if (!id) return '';
    if (isSelectable(provider, id)) return id;
    let family = provider;
    if (provider === 'sub2api') {
      family = /^gpt-/.test(id) ? 'openai' : /^claude-/.test(id) ? 'claude'
        : /^gemini-/.test(id) ? 'gemini' : '';
    }
    let replacement = '';
    if (family === 'openai' || family === 'chatgpt') {
      if (!/^gpt-\d/.test(id) || /(?:image|realtime|audio|transcrib|tts|instruct|search|deep-research|embedding|moderation|codex)/i.test(id)) return '';
      replacement = /(?:^|-)(?:luna|mini|nano)(?:-|$)/.test(id) ? 'gpt-6-luna'
        : /(?:^|-)(?:astra|pro)(?:-|$)/.test(id) ? 'gpt-6-astra' : 'gpt-6.1-sol';
    } else if (family === 'claude') {
      if (!/^claude-/.test(id)) return '';
      const line = id.match(/(?:^|-)(fable|mythos|opus|sonnet|haiku|instant)(?:-|$)/)?.[1];
      replacement = line === 'opus' ? 'claude-opus-5-5'
        : line === 'sonnet' ? 'claude-sonnet-5-5'
        : line === 'haiku' || line === 'instant' ? 'claude-haiku-5-5'
        : line === 'fable' || line === 'mythos' || /^claude-[12](?:[.-]|$)/.test(id) ? 'claude-fable-5-1' : '';
    } else if (family === 'gemini') {
      if (!/^gemini-\d/.test(id) || /(?:image|banana|tts|live|audio|embedding|robotics|computer-use|transcrib)/i.test(id)) return '';
      replacement = /flash-lite/.test(id) ? 'gemini-3.5-flash-lite'
        : /(?:^|-)pro(?:-|$)/.test(id) ? 'gemini-3.1-pro-preview'
        : /(?:^|-)flash(?:-|$)/.test(id) ? 'gemini-3.8-flash' : '';
    } else if (family === 'deepseek') {
      if (/^deepseek-(?:v\d(?:\.\d+)?-)?(?:flash|pro|chat|reasoner)(?:-|$)/.test(id)) {
        replacement = /(?:^|-)pro(?:-|$)/.test(id) ? 'deepseek-v4-pro' : 'deepseek-flash';
      }
    } else if (family === 'kimi') {
      if (/^(?:kimi-(?:k\d|latest)|moonshot-v1-)/.test(id)) replacement = 'kimi-k3';
    } else if (family === 'minimax') {
      if (/^minimax-m\d(?:[.-]|$)/i.test(id)) replacement = 'MiniMax-M3';
    }
    return isSelectable(provider, replacement) ? replacement : '';
  }
  // Policies apply to the current catalog; callers migrate saved IDs first.
  function getPolicy(provider, model) {
    const policy = { minOutputTokens: 0, disableThinking: false, thinkingType: null,
      effortField: null, defaultEffort: null, reasoningSplit: false };
    if (!isSelectable(provider, model)) return policy;
    const id = normalizeModel(provider, model);
    if (provider === 'sub2api') {
      provider = /^gemini-/.test(id) ? 'gemini' : /^gpt-/.test(id) ? 'chatgpt' : 'claude';
    }
    if (provider === 'openai' || provider === 'chatgpt') {
      policy.minOutputTokens = 16000;
      policy.effortField = 'reasoning_effort';
    } else if (provider === 'claude') {
      if (id === 'claude-sonnet-5-5') {
        // Sonnet 5.5 rejects disabled; no-tools requests return text only here.
        policy.thinkingType = 'between_tools';
      } else if (id === 'claude-haiku-5-5') {
        policy.disableThinking = true;
        policy.thinkingType = 'disabled';
      } else {
        policy.minOutputTokens = 16000;
        policy.effortField = 'output_config';
      }
    } else if (provider === 'gemini') {
      if (id !== 'gemini-3.5-flash-lite') policy.effortField = 'thinkingLevel';
    } else if (provider === 'deepseek' || provider === 'minimax') {
      policy.disableThinking = true;
      policy.thinkingType = 'disabled';
      policy.reasoningSplit = provider === 'minimax';
    } else if (provider === 'kimi') {
      policy.minOutputTokens = 16000;
      policy.effortField = 'reasoning_effort';
      policy.defaultEffort = 'low';
    }
    return policy;
  }
  const registry = { providers, defaults, sanitizeModel, isSelectable, getPolicy };
  scope.AATModels = registry;
  if (typeof module !== 'undefined' && module.exports) module.exports = registry;
})(globalThis);
