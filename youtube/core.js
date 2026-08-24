// src/core.js — YTX 命名空间、共享状态、工具函数、字幕获取、settings

var YTX = {
  // 共享状态
  panel: null,
  currentVideoId: null,
  transcriptData: null,
  videoMode: false, // true = 无字幕，使用 Gemini 视频模式
  activeTab: 'summary',
  isFetchingTranscript: false, // true = 正在获取字幕，禁止生成操作
  _transcriptGeneration: 0, // 同一视频内清缓存/重开字幕时隔离旧异步结果
  resizerInjected: false,
  panelCollapsed: true,
  resizerSplitRatio: 3 / 5,

  // 各功能模块注册到这里
  features: {},

  // 功能模块加载顺序（panel.js 中用于遍历）
  featureOrder: ['summary', 'mindmap', 'html', 'chat'],
};

// ── 按钮图标 ─────────────────────────────────────────
YTX.icons = {
  zap: '<svg width="42" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  spinner: '<svg class="ytx-btn-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>',
};

// 设置按钮为 refresh 灰色态 / 恢复 primary 态
YTX.btnRefresh = function (btn) {
  btn.innerHTML = YTX.icons.refresh;
  btn.classList.remove('ytx-btn-primary');
  btn.classList.add('ytx-btn-secondary');
};
YTX.btnPrimary = function (btn, icon) {
  btn.innerHTML = icon || YTX.icons.play;
  btn.classList.remove('ytx-btn-secondary');
  btn.classList.add('ytx-btn-primary');
};

YTX.renderError = function (contentEl, message) {
  if (!contentEl) return null;
  contentEl.textContent = '';
  var errorEl = document.createElement('div');
  errorEl.className = 'ytx-error';
  errorEl.textContent = String(message || '操作失败');
  contentEl.appendChild(errorEl);
  return errorEl;
};

YTX.parseError = function (contentEl, label, err) {
  var detail = err && err.message ? err.message : String(err || '未知错误');
  YTX.renderError(contentEl, label + '解析失败: ' + detail + '\n可尝试重新生成');
};

// ── 工具函数 ──────────────────────────────────────────

YTX.fmtTime = function (seconds) {
  seconds = Number(seconds);
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
};

// 严格解析 M:SS / MM:SS / H:MM:SS。分钟位在两段格式中不设上限，
// 因而 100 分钟以上的视频仍可使用字幕实际产生的 100:00 格式。
YTX.parseTime = function (str) {
  if (typeof str !== 'string') return null;
  var parts = str.trim().split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!/^\d+$/.test(parts[0])) return null;
  // 秒位，以及三段格式中的分钟位，必须固定两位。
  if (!/^\d{2}$/.test(parts[parts.length - 1])) return null;
  if (parts.length === 3 && !/^\d{2}$/.test(parts[1])) return null;

  var nums = parts.map(Number);
  if (!nums.every(function (n) { return Number.isSafeInteger(n) && n >= 0; })) return null;
  if (parts.length === 2) {
    if (nums[1] >= 60) return null;
    var minuteTotal = nums[0] * 60 + nums[1];
    return Number.isSafeInteger(minuteTotal) ? minuteTotal : null;
  }
  if (nums[1] >= 60 || nums[2] >= 60) return null;
  var hourTotal = nums[0] * 3600 + nums[1] * 60 + nums[2];
  return Number.isSafeInteger(hourTotal) ? hourTotal : null;
};

YTX.timeToSeconds = function (str) {
  var seconds = YTX.parseTime(str);
  return seconds == null ? NaN : seconds;
};

// AI 返回的 time 字段：严格校验并规范成总分钟 M:SS，避免无效秒位和 DOM 注入。
// 用途：mindmap 渲染时拼到 innerHTML，必须先校验防 DOM 注入
YTX.safeTime = function (str) {
  var seconds = YTX.parseTime(str);
  return seconds == null ? null : YTX.fmtTime(seconds);
};

// 所有长文本在 content script 侧再设一道硬上限；background 也会限流，
// 这里用于防御异常/恶意 provider 消息在超时窗口内拖垮页面。
YTX.AI_OUTPUT_MAX_CHARS = 1000000;
YTX.TRANSCRIPT_MAX_CHARS = 200000;
YTX.TRANSCRIPT_MAX_SEGMENTS = 20000;
YTX.TRANSCRIPT_SEGMENT_MAX_CHARS = 4000;
YTX.MARKDOWN_OUTPUT_MAX_CHARS = 200000;
YTX.MARKDOWN_OUTPUT_MAX_LINES = 10000;
YTX.CHAT_QUESTION_MAX_CHARS = 10000;
YTX.CHAT_REPLY_MAX_CHARS = 50000;
YTX.CHAT_HISTORY_MAX_CHARS = 220000;
YTX.CHAT_HISTORY_MESSAGE_MAX_CHARS = 50000;
YTX.LEGACY_HTML_MAX_CHARS = 250000;
YTX.HTML_MAX_ELEMENTS = 10000;
YTX.TRANSCRIBE_WATCHDOG_MS = 46 * 60 * 1000;
YTX.FETCH_TRANSCRIPT_WATCHDOG_MS = 210000;
YTX.STREAM_WATCHDOG_MS = 16 * 60 * 1000;
YTX._streamWatchdogs = Object.create(null);

YTX.settleTranscribeDeferred = function (requestId, error, text, completion) {
  var pending = YTX._transcribeDeferred;
  if (!pending || pending.requestId !== requestId) return false;
  YTX._transcribeDeferred = null;
  if (pending.timer) clearTimeout(pending.timer);
  if (error) pending.reject(error instanceof Error ? error : new Error(String(error)));
  else pending.resolve({ text: text, completion: completion || {} });
  return true;
};

YTX.appendCappedText = function (current, chunk, maxChars) {
  if (typeof current !== 'string' || typeof chunk !== 'string') return null;
  var limit = maxChars == null ? YTX.AI_OUTPUT_MAX_CHARS : Number(maxChars);
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  if (current.length > limit || chunk.length > limit - current.length) return null;
  return current + chunk;
};

YTX.applyAuthoritativeStreamText = function (feature, prefix, text) {
  var specs = {
    SUMMARY: { field: 'text', max: YTX.MARKDOWN_OUTPUT_MAX_CHARS, markdown: true },
    HTML: { field: 'text', max: 350000 },
    MINDMAP: { field: 'rawText', max: 200000 },
    CHAT: { field: 'replyText', max: YTX.CHAT_REPLY_MAX_CHARS, markdown: true },
  };
  var spec = specs[prefix];
  if (!feature || !spec || typeof text !== 'string' || !text || text.length > spec.max) return false;
  if (spec.markdown) {
    var metrics = YTX.markdownMetrics(text, spec.max);
    if (!metrics) return false;
    feature._newlineCount = metrics.newlines;
  }
  feature[spec.field] = text;
  return true;
};

// 高频小 chunk 先按固定消息数组成块；每个字符只参与一次块内 join 和一次 drain，
// 避免对 growing string 做逐消息拼接/扫描。返回对象便于纯函数级洪水测试。
YTX.createChunkBatch = function (maxChars, blockMessageCount) {
  var limit = Number(maxChars);
  var blockSize = Number(blockMessageCount || 256);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('批次字符上限无效');
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 4096) throw new Error('批次大小无效');
  var blocks = [];
  var chunks = [];
  var chars = 0;
  return {
    push: function (chunk) {
      if (typeof chunk !== 'string' || chunk.length > limit - chars) return false;
      chunks.push(chunk);
      chars += chunk.length;
      if (chunks.length >= blockSize) {
        blocks.push(chunks.join(''));
        chunks = [];
      }
      return true;
    },
    drain: function () {
      var value = blocks.concat(chunks).join('');
      blocks = [];
      chunks = [];
      chars = 0;
      return value;
    },
    stats: function () {
      return { chars: chars, blocks: blocks.length, chunks: chunks.length };
    },
  };
};

YTX.markdownMetrics = function (value, maxChars) {
  if (typeof value !== 'string') return null;
  var charLimit = maxChars == null ? YTX.MARKDOWN_OUTPUT_MAX_CHARS : Number(maxChars);
  if (!Number.isSafeInteger(charLimit) || charLimit < 0 || value.length > charLimit) return null;
  var newlines = 0;
  for (var i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10 && ++newlines >= YTX.MARKDOWN_OUTPUT_MAX_LINES) return null;
  }
  return { chars: value.length, newlines: newlines };
};

// 流式 Markdown 同时按字符数和行数增量限界，避免百万空行在 split/DOM 阶段放大。
YTX.appendCappedMarkdown = function (current, chunk, currentNewlines, maxChars) {
  var next = YTX.appendCappedText(current, chunk,
    maxChars == null ? YTX.MARKDOWN_OUTPUT_MAX_CHARS : maxChars);
  if (next === null) return null;

  var newlines = Number.isSafeInteger(currentNewlines) && currentNewlines >= 0
    ? currentNewlines
    : null;
  if (newlines == null) {
    var currentMetrics = YTX.markdownMetrics(current, maxChars);
    if (!currentMetrics) return null;
    newlines = currentMetrics.newlines;
  }
  for (var i = 0; i < chunk.length; i++) {
    if (chunk.charCodeAt(i) === 10 && ++newlines >= YTX.MARKDOWN_OUTPUT_MAX_LINES) return null;
  }
  return { text: next, newlines: newlines };
};

// renderMarkdown 的最后一道边界。正常 summary/chat 会在流阶段拒绝超限；这里
// 仍做有界截断，保护未来调用方或被污染的内存状态不直接 split 海量行。
YTX.limitMarkdownForRender = function (value) {
  value = typeof value === 'string' ? value : String(value == null ? '' : value);
  if (YTX.markdownMetrics(value)) return value;

  var notice = '\n[... 内容过长，显示已截断 ...]';
  var charBudget = Math.max(0, YTX.MARKDOWN_OUTPUT_MAX_CHARS - notice.length);
  var lineBudget = Math.max(1, YTX.MARKDOWN_OUTPUT_MAX_LINES - 1);
  var end = Math.min(value.length, charBudget);
  var lines = 1;
  for (var i = 0; i < end; i++) {
    if (value.charCodeAt(i) === 10 && ++lines > lineBudget) {
      end = i;
      break;
    }
  }
  return value.slice(0, end) + notice;
};

YTX.streamCompletionWarning = function (message) {
  if (!message || typeof message !== 'object' || (!message.truncated && !message.warning)) return '';
  var detail = typeof message.warning === 'string'
    ? message.warning.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 300)
    : '';
  return '生成结果不完整，已停止且不会写入缓存' + (detail ? '：' + detail : '');
};

YTX.prependOutputWarning = function (container, message) {
  if (!container || !message) return;
  var warning = document.createElement('div');
  warning.className = 'ytx-warning';
  warning.style.cssText = 'padding:8px 12px;margin-bottom:8px;font-size:12px;color:#b45309;background:#fef3c7;border-radius:6px';
  warning.textContent = message;
  container.prepend(warning);
};

// 面板位于页面 DOM 中时，页面脚本可派发合成事件。所有用户交互入口只接受
// 浏览器产生的可信事件；模块内部直接调用 start()/send() 等不受影响。
YTX.isTrustedEvent = function (event) {
  return !!event && event.isTrusted === true;
};

// MAIN-world/后台返回的 segments 仍按不可信输入处理。扫描、条数、单项和总文本
// 都有界；返回的 segments 与 full 使用同一份规范化内容，避免 full 已截断但 DOM
// 仍渲染海量原始 segments。
YTX.normalizeTranscriptSegments = function (input) {
  if (!Array.isArray(input)) throw new Error('字幕格式无效');

  var notice = '\n\n[... 字幕过长或分段过多，内容已截断 ...]';
  var contentBudget = Math.max(0, YTX.TRANSCRIPT_MAX_CHARS - notice.length);
  var scanCount = Math.min(input.length, YTX.TRANSCRIPT_MAX_SEGMENTS);
  var segments = [];
  var lines = [];
  var usedChars = 0;
  var truncated = input.length > scanCount;

  for (var i = 0; i < scanCount; i++) {
    var item = input[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.start !== 'number' || !Number.isFinite(item.start) || item.start < 0) continue;
    var start = Math.floor(item.start);
    if (!Number.isSafeInteger(start)) continue;
    if (typeof item.text !== 'string') continue;

    var text = item.text;
    if (text.length > YTX.TRANSCRIPT_SEGMENT_MAX_CHARS) {
      text = text.slice(0, YTX.TRANSCRIPT_SEGMENT_MAX_CHARS);
      truncated = true;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    var prefix = '[' + YTX.fmtTime(start) + '] ';
    var separatorChars = lines.length ? 1 : 0;
    var available = contentBudget - usedChars - separatorChars - prefix.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    var stopAfterItem = false;
    if (text.length > available) {
      text = text.slice(0, available).trim();
      truncated = true;
      stopAfterItem = true;
    }
    if (!text) break;

    var line = prefix + text;
    segments.push({ start: start, text: text });
    lines.push(line);
    usedChars += separatorChars + line.length;
    if (stopAfterItem) break;
  }

  if (!segments.length) throw new Error('字幕内容为空或格式无效');
  return {
    segments: segments,
    full: lines.join('\n') + (truncated ? notice : ''),
    truncated: truncated,
  };
};

// ── Settings ──────────────────────────────────────────

// 为每次 AI 请求生成唯一 ID，用于过滤切视频/重发后到达的过期 chunk
YTX.makeRequestId = function () {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

// Chat iframe capability：只接受浏览器 CSPRNG 生成的固定格式 token。
// 这里不能退回 Math.random；安全随机数不可用时由调用方 fail closed。
YTX.makeCapabilityToken = function () {
  if (typeof crypto === 'undefined' || !crypto) return null;
  if (typeof crypto.randomUUID === 'function') {
    try {
      var uuid = String(crypto.randomUUID()).replace(/-/g, '').toLowerCase();
      if (/^[a-f0-9]{32}$/.test(uuid)) return uuid;
    } catch (_) {}
  }
  try {
    if (typeof crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      var token = '';
      for (var i = 0; i < bytes.length; i++) token += bytes[i].toString(16).padStart(2, '0');
      return /^[a-f0-9]{64}$/.test(token) ? token : null;
    }
  } catch (_) {}
  return null;
};

// Deferred 工具：feature.start() 返回它的 promise，由 onDone/onError/reset 来 resolve/reject
YTX.createDeferred = function () {
  var d = {};
  d.promise = new Promise(function (resolve, reject) { d.resolve = resolve; d.reject = reject; });
  return d;
};

// 仅读非敏感字段；API key 由 background loadProviderConfig() 自读，content script 不接触
YTX.getSettings = function () {
  return new Promise(function (resolve, reject) {
    try {
      chrome.storage.sync.get(
        ['provider', 'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel', 'chatgptModel', 'model',
         'prompt', 'promptHtml', 'promptMindmap'],
        function (data) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '读取扩展设置失败'));
            return;
          }
          try {
            data = data || {};
            var MODEL_MAP = { claude: 'claudeModel', openai: 'openaiModel', gemini: 'geminiModel', minimax: 'minimaxModel', deepseek: 'deepseekModel', kimi: 'kimiModel', sub2api: 'sub2apiModel', chatgpt: 'chatgptModel' };
            var provider = Object.prototype.hasOwnProperty.call(MODEL_MAP, data.provider) ? data.provider : 'claude';
            resolve({
              provider: provider,
              model: data[MODEL_MAP[provider]] || '',
              prompt: data.prompt,
              promptHtml: data.promptHtml,
              promptMindmap: data.promptMindmap,
            });
          } catch (err) {
            reject(err);
          }
        }
      );
    } catch (err) {
      reject(err);
    }
  });
};

// ── 与 background.js 通信 ─────────────────────────────

YTX.sendToBg = function (message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (resp) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
};

// 流式生成请求必须拿到 background 的同步 started ack。后台校验立即失败时，
// 不应只依赖可能丢失的 tabs.sendMessage(ERROR) 来结束 feature/deferred。
YTX.startStreamRequest = async function (message) {
  var response = await YTX.sendToBg(message);
  if (!response || response.started !== true) {
    throw new Error(response && typeof response.error === 'string' && response.error
      ? response.error
      : '后台未能启动生成请求');
  }
  YTX.armStreamWatchdog(message && message.requestId);
  return response;
};

YTX.clearStreamWatchdog = function (requestId) {
  if (!requestId) return;
  var timer = YTX._streamWatchdogs[requestId];
  if (timer) clearTimeout(timer);
  delete YTX._streamWatchdogs[requestId];
};

YTX.armStreamWatchdog = function (requestId) {
  if (typeof requestId !== 'string' || !requestId) return;
  YTX.clearStreamWatchdog(requestId);
  var timer = setTimeout(function () {
    delete YTX._streamWatchdogs[requestId];
    var feature = null;
    for (var i = 0; i < YTX.featureOrder.length; i++) {
      var candidate = YTX.features[YTX.featureOrder[i]];
      if (candidate && candidate.requestId === requestId) { feature = candidate; break; }
    }
    if (!feature) return;
    YTX.cancelRequest(requestId);
    if (typeof feature.onError === 'function') {
      feature.onError('生成请求等待超时，请重试');
    }
  }, YTX.STREAM_WATCHDOG_MS);
  // Node-based protocol tests should not be kept alive by a browser watchdog.
  if (timer && typeof timer.unref === 'function') timer.unref();
  YTX._streamWatchdogs[requestId] = timer;
};

// 主动取消 background 中仍在进行的 fetch/流读取。取消消息本身失败不阻断 UI 重置。
YTX.cancelRequest = function (requestId) {
  if (!requestId) return Promise.resolve(false);
  YTX.clearStreamWatchdog(requestId);
  return YTX.sendToBg({ type: 'CANCEL_REQUEST', requestId: requestId })
    .then(function () { return true; })
    .catch(function () { return false; });
};

// ── 字幕获取 ──────────────────────────────────────────

YTX.fetchTranscript = async function () {
  var timer = null;
  var result;
  try {
    result = await Promise.race([
      YTX.sendToBg({ type: 'FETCH_TRANSCRIPT', videoId: YTX.currentVideoId }),
      new Promise(function (_resolve, reject) {
        timer = setTimeout(function () {
          reject(new Error('字幕获取等待超时，将尝试视频转录模式'));
        }, YTX.FETCH_TRANSCRIPT_WATCHDOG_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!result || result.error) throw new Error((result && result.error) || '字幕获取失败');
  return YTX.normalizeTranscriptSegments(result.segments);
};

// ── JSON 解析容错（剥离 markdown 围栏）──────────────

YTX.extractJSON = function (text, type) {
  // 先剥离 ```json ... ``` 或 ``` ... ``` 围栏
  var fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1];

  // 根据类型匹配 [] 或 {}
  var pattern = type === 'object' ? /\{[\s\S]*\}/ : /\[[\s\S]*\]/;
  var match = text.match(pattern);
  if (!match) return null;

  var raw = match[0];

  // 尝试多种修复策略
  var attempts = [
    // 1. 原文直接解析
    raw,
    // 2. 去除尾逗号
    raw.replace(/,\s*([}\]])/g, '$1'),
    // 3. 转义字符串值内的换行符（逐字符扫描）
    YTX._fixJsonStringEscapes(raw),
    // 4. 对修复后的再去尾逗号
    YTX._fixJsonStringEscapes(raw).replace(/,\s*([}\]])/g, '$1'),
  ];

  for (var i = 0; i < attempts.length; i++) {
    try { return JSON.parse(attempts[i]); } catch (e) {}
  }

  // 5. 最后尝试：截断到最后一个完整对象
  var lastBrace = raw.lastIndexOf('}');
  if (lastBrace > 0) {
    var truncated = raw.substring(0, lastBrace + 1);
    if (type !== 'object') truncated += ']';
    try { return JSON.parse(truncated); } catch (e) {}
    // 截断后也试修复
    truncated = YTX._fixJsonStringEscapes(truncated).replace(/,\s*([}\]])/g, '$1');
    if (type !== 'object' && truncated.charAt(truncated.length - 1) !== ']') truncated += ']';
    try { return JSON.parse(truncated); } catch (e) {}
  }

  // 全部失败，抛出错误
  JSON.parse(raw);
};

// 修复 JSON 字符串值内未转义的控制字符
YTX._fixJsonStringEscapes = function (str) {
  var result = '';
  var inString = false;
  var i = 0;
  while (i < str.length) {
    var ch = str[i];
    if (inString) {
      if (ch === '\\') {
        result += ch + (str[i + 1] || '');
        i += 2;
        continue;
      }
      if (ch === '"') {
        // 检查这个引号是否真的结束字符串：后面应该是 , } ] : 或空白
        // 不要为每个引号创建剩余字符串副本；畸形模型输出可以包含数万个
        // 引号，substring()+trimStart() 会把一次有界解析放大成 O(n²)。
        var nextIndex = i + 1;
        while (nextIndex < str.length && /\s/.test(str[nextIndex])) nextIndex++;
        var nextCh = str[nextIndex];
        if (!nextCh || nextCh === ',' || nextCh === '}' || nextCh === ']' || nextCh === ':') {
          inString = false;
          result += ch;
        } else {
          // 字符串值内的未转义引号
          result += '\\"';
        }
        i++;
        continue;
      }
      if (ch === '\n') { result += '\\n'; i++; continue; }
      if (ch === '\r') { result += '\\r'; i++; continue; }
      if (ch === '\t') { result += '\\t'; i++; continue; }
      result += ch;
    } else {
      if (ch === '"') inString = true;
      result += ch;
    }
    i++;
  }
  return result;
};

// ── 字幕截断保护（防止超出 API token 限制）────────────

YTX.truncateTranscript = function (full) {
  if (full.length <= YTX.TRANSCRIPT_MAX_CHARS) return full;
  var notice = '\n\n[... 字幕过长，已截断。以上为前 ' + Math.round(YTX.TRANSCRIPT_MAX_CHARS / 1000) + 'k 字符 ...]';
  var truncated = full.substring(0, Math.max(0, YTX.TRANSCRIPT_MAX_CHARS - notice.length));
  // 截到最后一个完整行
  var lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > 0) truncated = truncated.substring(0, lastNewline);
  return truncated + notice;
};

YTX.normalizeCachedTranscript = function (record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('缓存字幕格式无效');
  }
  if (record.segments != null) {
    var normalized = YTX.normalizeTranscriptSegments(record.segments);
    normalized.truncated = normalized.truncated || record.truncated === true;
    return normalized;
  }
  if (typeof record.full !== 'string' || !record.full.trim()) {
    throw new Error('缓存字幕内容无效');
  }
  var oversized = record.full.length > YTX.TRANSCRIPT_MAX_CHARS;
  return {
    segments: null,
    full: oversized ? YTX.truncateTranscript(record.full) : record.full,
    truncated: oversized || record.truncated === true,
  };
};

// ── 视频模式相关 ────────────────────────────────────

YTX.getVideoUrl = function () {
  return 'https://www.youtube.com/watch?v=' + YTX.currentVideoId;
};

YTX.getVideoElement = function () {
  var activeShort = document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-shorts ytd-reel-video-renderer[is-active] video');
  if (activeShort) return activeShort;
  var videos = Array.from(document.querySelectorAll('video'));
  for (var i = 0; i < videos.length; i++) {
    if (!videos[i].paused && !videos[i].ended) return videos[i];
  }
  return videos[0] || null;
};

// 获取内容参数（统一返回 transcript）
YTX.getContentPayload = function () {
  return { transcript: YTX.transcriptData.full };
};

// ── 视频模式提示条 ──────────────────────────────────

YTX.syncTranscriptUi = function () {
  if (!YTX.panel) return;
  var banner = YTX.panel.querySelector('#ytx-video-mode-banner');
  if (banner) banner.style.display = YTX.videoMode ? 'flex' : 'none';
  var btn = YTX.panel.querySelector('#ytx-use-video-mode');
  if (btn) {
    btn.style.display = YTX.videoMode ? 'none' : '';
    btn.disabled = !YTX.videoMode && YTX.isFetchingTranscript;
    btn.textContent = YTX.isFetchingTranscript ? '字幕获取中...' : '使用视频模式';
  }
};

YTX.setVideoMode = function (enabled) {
  YTX.videoMode = enabled === true;
  YTX.syncTranscriptUi();
};

YTX.setTranscriptBusy = function (busy) {
  YTX.isFetchingTranscript = busy === true;
  YTX.syncTranscriptUi();
};

YTX.showVideoModeBanner = function () {
  YTX.setVideoMode(true);
};

// ── 通过 Gemini 分析视频（内部复用）───────────────────

YTX._analyzeVideoWithGemini = async function (expectedGeneration) {
  // 早绑定：整个回退流程（抓 URL、发请求、写结果）都用这个 ID 校验
  var startVideoId = YTX.currentVideoId;
  if (expectedGeneration === undefined) expectedGeneration = YTX._transcriptGeneration;
  // 立即抓 videoUrl，避免后续 await 期间页面切走后取到错的 URL
  var videoUrl = YTX.getVideoUrl();

  // 不在 content script 读 Gemini key —— 缺 key时由 background 在 TRANSCRIBE 响应里回错。
  // videoMode 只在最终成功后提交，失败不会污染普通字幕状态。

  if (YTX.panel) {
    var body = YTX.panel.querySelector('#ytx-transcript-body');
    if (body) body.innerHTML = '<div class="ytx-warning" style="padding:8px 12px;font-size:12px;color:#7c3aed;background:#ede9fe;border-radius:6px">正在通过 Gemini 视频模式转录字幕，长视频会自动分段处理，请耐心等待...</div>';
  }

  // 获取视频时长（秒），用于判断是否需要分段转录
  var videoDuration = 0;
  try {
    var videoEl = YTX.getVideoElement();
    if (videoEl && videoEl.duration && isFinite(videoEl.duration)) {
      videoDuration = Math.round(videoEl.duration);
    }
  } catch (e) { /* ignore */ }

  // 转录消息流用 startVideoId + requestId 双重隔离：
  // - videoId 防 SPA 切视频污染
  // - requestId 防同视频下旧请求未取消时新请求 chunk 混入（如手动取消未完成的转录后再启动）
  var transcribeRequestId = YTX.makeRequestId();
  if (YTX._transcribeRequestId) YTX.cancelRequest(YTX._transcribeRequestId);
  YTX._transcribeVideoId = startVideoId;
  YTX._transcribeRequestId = transcribeRequestId;
  YTX._transcribeRejectedRequestId = null;
  YTX._transcribeStreamChars = 0;
  YTX._transcribeRenderedSegments = 0;
  YTX._transcribeBuffer = '';
  YTX._transcribeChunkBatch = null;
  YTX._transcribeMarkerPositions = [];
  YTX._transcribeScanOffset = 0;
  if (YTX._transcribeFlushTimer) { clearTimeout(YTX._transcribeFlushTimer); YTX._transcribeFlushTimer = null; }

  var terminalResult;
  try {
    terminalResult = await new Promise(function (resolve, reject) {
      var watchdog = setTimeout(function () {
        if (!YTX._transcribeDeferred || YTX._transcribeDeferred.requestId !== transcribeRequestId) return;
        YTX.cancelRequest(transcribeRequestId);
        YTX.settleTranscribeDeferred(transcribeRequestId, new Error('视频转录等待超时，请重试'));
      }, YTX.TRANSCRIBE_WATCHDOG_MS);
      YTX._transcribeDeferred = {
        requestId: transcribeRequestId,
        videoId: startVideoId,
        resolve: resolve,
        reject: reject,
        timer: watchdog,
      };
      try {
        chrome.runtime.sendMessage({
          type: 'TRANSCRIBE_VIDEO',
          videoUrl: videoUrl,
          videoDuration: videoDuration,
          videoId: startVideoId,
          requestId: transcribeRequestId,
        }, function (resp) {
          if (chrome.runtime.lastError) {
            var channelError = new Error(chrome.runtime.lastError.message || '视频分析请求失败');
            channelError.cancelBackgroundRequest = true;
            YTX.settleTranscribeDeferred(transcribeRequestId, channelError);
            return;
          }
          if (resp && resp.started === true && resp.requestId === transcribeRequestId) return;
          var startError = new Error((resp && resp.error) || '视频分析任务未启动');
          startError.cancelBackgroundRequest = true;
          YTX.settleTranscribeDeferred(transcribeRequestId, startError);
        });
      } catch (e) {
        var channelError = new Error('无法连接到扩展后台: ' + e.message);
        channelError.cancelBackgroundRequest = true;
        YTX.settleTranscribeDeferred(transcribeRequestId, channelError);
      }
    });
  } catch (err) {
    // 消息通道异常时后台可能已经启动，请求取消可避免孤儿 fetch。
    if (err.cancelBackgroundRequest) YTX.cancelRequest(transcribeRequestId);
    if (YTX.currentVideoId === startVideoId && YTX._transcriptGeneration === expectedGeneration && YTX.panel) {
      var errorBody = YTX.panel.querySelector('#ytx-transcript-body');
      if (errorBody) YTX.renderError(errorBody, '视频转录失败：' + (err.message || err));
    }
    throw err;
  } finally {
    if (YTX._transcribeDeferred && YTX._transcribeDeferred.requestId === transcribeRequestId) {
      if (YTX._transcribeDeferred.timer) clearTimeout(YTX._transcribeDeferred.timer);
      YTX._transcribeDeferred = null;
    }
    // TRANSCRIBE_SEGMENT 会先清理正常终态；这里覆盖没有 SEGMENT 的失败路径。
    if (YTX._transcribeRequestId === transcribeRequestId) {
      YTX._transcribeRequestId = null;
      YTX._transcribeVideoId = null;
      YTX._transcribeReceiving = false;
      YTX._transcribeBuffer = '';
      YTX._transcribeStreamChars = 0;
      YTX._transcribeRenderedSegments = 0;
      YTX._transcribeChunkBatch = null;
      YTX._transcribeMarkerPositions = [];
      YTX._transcribeScanOffset = 0;
      if (YTX._transcribeFlushTimer) { clearTimeout(YTX._transcribeFlushTimer); YTX._transcribeFlushTimer = null; }
      if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
    }
  }

  if (YTX._transcribeRejectedRequestId === transcribeRequestId) {
    YTX._transcribeRejectedRequestId = null;
    throw new Error('视频转录输出超过安全上限，结果已丢弃');
  }

  var result = terminalResult && terminalResult.text;
  var completion = terminalResult && terminalResult.completion || {};
  if (typeof result !== 'string' || !result.trim()) throw new Error('视频转录未返回有效文本');

  // 转录完成后切视频检查：把结果丢弃，避免污染新视频
  if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== expectedGeneration) {
    throw new Error('字幕请求已失效，转录结果已丢弃');
  }

  YTX.setVideoMode(true);

  // 最终以规范化后的完整结果重绘，避免终态消息与 sendResponse 到达顺序不同
  // 导致最后一个流式片段未 flush，也确保截断提示立即可见。
  if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
  var providerIncomplete = completion.incomplete === true || completion.truncated === true;
  var wasTruncated = result.length > YTX.TRANSCRIPT_MAX_CHARS || providerIncomplete;
  YTX.transcriptData = {
    full: YTX.truncateTranscript(result),
    truncated: wasTruncated,
  };
  if (typeof YTX.renderTranscript === 'function') YTX.renderTranscript();
  if (YTX.panel) {
    var status = YTX.panel.querySelector('#ytx-seg-status');
    if (status) {
      status.textContent = providerIncomplete
        ? '转录提前结束（已保留部分内容，不写作完整结果）'
        : (wasTruncated ? '转录完成（分析内容已截断）' : '转录完成');
      status.style.color = wasTruncated ? '#b45309' : '#15803d';
    }
  }
};

// ── 手动切换到视频模式 ──────────────────────────────

YTX.switchToVideoMode = function () {
  // busy 时直接 throw，让调用方的 catch 能恢复按钮，不会被当成"切换成功"
  if (YTX.isFetchingTranscript) return Promise.reject(new Error('字幕正在获取中，请稍候'));

  // 早绑定：异步期间用户可能切到别的视频/重建面板
  var startVideoId = YTX.currentVideoId;
  var panelAtStart = YTX.panel;
  var previousTranscriptData = YTX.transcriptData;
  var previousVideoMode = YTX.videoMode;
  var transcriptGeneration = (YTX._transcriptGeneration || 0) + 1;
  YTX._transcriptGeneration = transcriptGeneration;
  YTX.setTranscriptBusy(true);

  // 禁用所有生成按钮
  var BTN_IDS = ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-mindmap'];
  BTN_IDS.forEach(function (id) {
    var b = panelAtStart && panelAtStart.querySelector(id);
    if (b) b.disabled = true;
  });

  // 清空字幕数据（保留各模块已生成的内容）
  YTX.transcriptData = null;

  // 与 ensureTranscript 共用 _transcriptPromise 去重：手动视频模式期间，
  // 普通功能调用 ensureTranscript 会复用同一个 promise，不会再触发一路转录
  YTX._transcriptVideoId = startVideoId;
  var transcriptPromise = (async function () {
    try {
      await YTX._analyzeVideoWithGemini(transcriptGeneration);
      // 缓存视频模式字幕（按 startVideoId 而非 currentVideoId）
      if (YTX.transcriptData && YTX.currentVideoId === startVideoId && YTX._transcriptGeneration === transcriptGeneration) {
        YTX.cache.save(startVideoId, 'transcript', {
          segments: null,
          full: YTX.transcriptData.full,
          truncated: YTX.transcriptData.truncated || false,
          videoMode: true,
        });
      }
    } catch (err) {
      // 手动切换失败时恢复进入前的可用字幕/模式；不能让一次 Gemini
      // 配置或网络错误清空用户原本已经拿到的字幕。
      if (YTX.currentVideoId === startVideoId && YTX._transcriptGeneration === transcriptGeneration) {
        YTX.transcriptData = previousTranscriptData;
        YTX.setVideoMode(previousVideoMode);
        if (previousTranscriptData && typeof YTX.renderTranscript === 'function') YTX.renderTranscript();
      }
      throw err;
    } finally {
      if (YTX._transcriptGeneration === transcriptGeneration) YTX.setTranscriptBusy(false);
      // 仅在仍是同一视频和同一面板时恢复按钮，避免污染新视频
      if (YTX.currentVideoId === startVideoId && YTX.panel === panelAtStart && YTX._transcriptGeneration === transcriptGeneration) {
        BTN_IDS.forEach(function (id) {
          var b = panelAtStart.querySelector(id);
          if (b) b.disabled = false;
        });
      }
      // 清理 in-flight 标记（仅在仍是同一视频时清理）
      if (YTX._transcriptPromise === transcriptPromise) {
        YTX._transcriptPromise = null;
        YTX._transcriptVideoId = null;
      }
    }
  })();
  YTX._transcriptPromise = transcriptPromise;

  return transcriptPromise;
};

// ── 确保字幕已加载（各模块共用）───────────────────────

YTX.ensureTranscript = function () {
  if (YTX.transcriptData) return Promise.resolve();

  // in-flight 去重：同一视频并发调用复用同一个 promise，避免多次触发 Gemini 转录
  var startVideoId = YTX.currentVideoId;
  if (YTX._transcriptPromise && YTX._transcriptVideoId === startVideoId) {
    return YTX._transcriptPromise;
  }

  var transcriptGeneration = (YTX._transcriptGeneration || 0) + 1;
  YTX._transcriptGeneration = transcriptGeneration;
  YTX._transcriptVideoId = startVideoId;
  YTX.setTranscriptBusy(true);
  var transcriptPromise = (async function () {
    try {
      try {
        var data = await YTX.fetchTranscript();
        if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== transcriptGeneration) return;
        YTX.transcriptData = data;
        YTX.setVideoMode(false);
        // 只滚动仍然有效的字幕请求所属页面，旧视频响应不得影响新页面。
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (typeof YTX.renderTranscript === 'function') YTX.renderTranscript(); // defined in panel.js
      } catch (err) {
        if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== transcriptGeneration) return;
        await YTX._analyzeVideoWithGemini(transcriptGeneration);
        if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== transcriptGeneration) return;
      }

      // 缓存字幕数据：写入前再次校验，并按 startVideoId 而非 currentVideoId 写
      if (YTX.transcriptData && YTX.currentVideoId === startVideoId && YTX._transcriptGeneration === transcriptGeneration) {
        YTX.cache.save(startVideoId, 'transcript', {
          segments: YTX.transcriptData.segments || null,
          full: YTX.transcriptData.full,
          truncated: YTX.transcriptData.truncated || false,
          videoMode: YTX.videoMode,
        });
      }
    } finally {
      if (YTX._transcriptGeneration === transcriptGeneration) YTX.setTranscriptBusy(false);
      // 清理 in-flight 标记（仅在仍是同一视频时清理，避免 race）
      if (YTX._transcriptPromise === transcriptPromise) {
        YTX._transcriptPromise = null;
        YTX._transcriptVideoId = null;
      }
    }
  })();
  YTX._transcriptPromise = transcriptPromise;

  return transcriptPromise;
};

// ── 历史记录持久化（由 background 代理）──────────────

YTX.cache = {
  // 旧版 youtube.com-origin 数据不再自动读取/迁移：Web IDB 无法在
  // structured-clone value 前获知大小。启动时只对扩展专用旧库执行整库删除，
  // 不 open store、不 materialize value；日常缓存只走 background。
  DB_NAME: 'AAtoolsCache',
  STORE: 'results',
  _legacyCleanupPromise: null,
  _epoch: null,
  _epochPromise: null,

  _request: function (message) {
    return YTX.sendToBg(message).then(function (response) {
      if (!response || response.ok !== true) {
        throw new Error(response && response.error ? response.error : '缓存操作失败');
      }
      return response;
    });
  },

  cleanupLegacy: function () {
    if (this._legacyCleanupPromise) return this._legacyCleanupPromise;
    var self = this;
    this._legacyCleanupPromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined' || !indexedDB ||
          typeof indexedDB.deleteDatabase !== 'function') {
        resolve(false);
        return;
      }
      var settled = false;
      var timer = setTimeout(function () { finish(false); }, 1000);
      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok === true);
      }
      try {
        var request = indexedDB.deleteDatabase(self.DB_NAME);
        request.onsuccess = function () { finish(true); };
        request.onerror = function () { finish(false); };
        // blocked 后请求仍可能在旧连接关闭时完成删除；先释放缓存调用，
        // 不让页面持有的连接把新 background 缓存永久卡住。
        request.onblocked = function () { finish(false); };
      } catch (_) {
        finish(false);
      }
    });
    return this._legacyCleanupPromise;
  },

  _isValidEpoch: function (value) {
    return Number.isSafeInteger(value) && value >= 1;
  },

  // 每个 content-script 生命周期只采纳一次持久化缓存代际。设置页清空后，
  // 已打开标签仍持有旧 epoch，所有旧在途结果都会被 background 拒绝；不会
  // 因后续一次 load/save 偷换到新 epoch 而把清空前生成的内容写回来。
  _adoptEpochOnce: function (value) {
    if (!this._isValidEpoch(this._epoch) && this._isValidEpoch(value)) this._epoch = value;
    return this._epoch;
  },

  captureEpoch: function () {
    if (this._isValidEpoch(this._epoch)) return Promise.resolve(this._epoch);
    if (this._epochPromise) return this._epochPromise;
    var self = this;
    this._epochPromise = this.cleanupLegacy().then(function () {
      return self._request({ type: 'CACHE_EPOCH' });
    }).then(function (response) {
      return self._adoptEpochOnce(response.epoch);
    }).catch(function () {
      return null;
    });
    return this._epochPromise;
  },

  // 保存某个 feature 的结果
  save: function (videoId, featureKey, data) {
    var self = this;
    return this.captureEpoch().then(function (epoch) {
      if (!self._isValidEpoch(epoch)) return false;
      return self._request({
        type: 'CACHE_SAVE',
        videoId: videoId,
        featureKey: featureKey,
        data: data,
        epoch: epoch,
      });
    }).then(function (result) { return result === false ? false : true; }).catch(function () { return false; });
  },

  // 删除某个视频的缓存
  remove: function (videoId) {
    var self = this;
    return this.captureEpoch().then(function (epoch) {
      if (!self._isValidEpoch(epoch)) return false;
      return self._request({ type: 'CACHE_REMOVE', videoId: videoId, epoch: epoch });
    }).then(function (result) { return result === false ? false : true; }).catch(function () { return false; });
  },

  // 清空全部缓存。background 同时接受 youtube.com 顶层页面和精确 options 页；
  // 本生命周期故意不采纳清空后的新 epoch，旧在途生成结果因而仍会被拒绝。
  clear: function () {
    var self = this;
    return this.cleanupLegacy().then(function () {
      return self._request({ type: 'CACHE_CLEAR' });
    }).then(function () { return true; }).catch(function () { return false; });
  },

  // 加载某个视频的全部缓存
  load: function (videoId) {
    var self = this;
    return this.captureEpoch().then(function () {
      return self._request({ type: 'CACHE_LOAD', videoId: videoId });
    }).then(function (response) {
      self._adoptEpochOnce(response.epoch);
      return response.record || null;
    }).catch(function () { return null; });
  },
};

// 尽早清除旧版页面源数据并捕获持久化 cache epoch；即使该视频尚未 load，
// 随后启动的生成任务也会在保存前复用这里取得的代际，而不是清空后的新值。
YTX.cache.captureEpoch();

// ── 全部生成（并行，跳过 chat）───────────────────────

YTX.generateAll = async function () {
  function showError(msg) {
    if (!YTX.panel) return;
    var errBar = YTX.panel.querySelector('#ytx-generate-all-error');
    if (!errBar) {
      errBar = document.createElement('div');
      errBar.id = 'ytx-generate-all-error';
      errBar.className = 'ytx-error';
      errBar.style.cssText = 'margin:8px 12px;';
      var firstChild = YTX.panel.firstChild;
      if (firstChild) YTX.panel.insertBefore(errBar, firstChild);
      else YTX.panel.appendChild(errBar);
    }
    errBar.textContent = msg;
    setTimeout(function () { if (errBar && errBar.parentNode) errBar.parentNode.removeChild(errBar); }, 6000);
  }

  if (YTX.isFetchingTranscript) {
    showError('一键生成失败：字幕正在获取中，请稍候');
    return;
  }

  var runToken = YTX.makeRequestId();
  YTX._generateAllToken = runToken;
  var startVideoId = YTX.currentVideoId;
  var panelAtStart = YTX.panel;

  var settings;
  try {
    settings = await new Promise(function (resolve, reject) {
      try {
        chrome.storage.sync.get(['generateAllSummary', 'generateAllMindmap', 'generateAllHtml'], function (data) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '读取扩展设置失败'));
            return;
          }
          resolve(data || {});
        });
      } catch (err) {
        reject(err);
      }
    });
  } catch (err) {
    if (YTX._generateAllToken === runToken && YTX.currentVideoId === startVideoId && YTX.panel === panelAtStart) {
      YTX._generateAllToken = null;
      showError('一键生成失败：' + (err && err.message ? err.message : err));
    }
    return;
  }
  if (YTX._generateAllToken !== runToken || YTX.currentVideoId !== startVideoId || YTX.panel !== panelAtStart) return;

  var keys = [];
  if (settings.generateAllSummary !== false) keys.push('summary');
  if (settings.generateAllMindmap !== false) keys.push('mindmap');
  if (settings.generateAllHtml !== false) keys.push('html');
  var allBtn = panelAtStart && panelAtStart.querySelector('#ytx-generate-all');
  if (allBtn) { allBtn.blur(); allBtn.disabled = true; allBtn.innerHTML = YTX.icons.spinner; }

  try {
    // 先统一拿字幕，避免各模块重复获取
    await YTX.ensureTranscript();
    if (YTX._generateAllToken !== runToken || YTX.currentVideoId !== startVideoId || YTX.panel !== panelAtStart) return;

    // 各 feature 的 start() 返回 Promise（来自内部 deferred），直接用 Promise.all 跟踪
    // 单个失败不影响其他；不再 patch onDone/onError，避免 hook 残留与永不 resolve
    var promises = keys.map(function (key) {
      var f = YTX.features[key];
      if (!f || !f.start || f.isGenerating) return Promise.resolve();
      var p = f.start();
      // 兼容老 feature 没返回 promise 的情况
      return (p && typeof p.then === 'function')
        ? p.catch(function (err) { console.warn('[AAtools] generateAll', key, err); })
        : Promise.resolve();
    });

    await Promise.all(promises);
  } catch (err) {
    if (YTX._generateAllToken === runToken && YTX.currentVideoId === startVideoId && YTX.panel === panelAtStart) {
      showError('一键生成失败：' + (err && err.message ? err.message : err));
    }
  } finally {
    if (YTX._generateAllToken === runToken) {
      YTX._generateAllToken = null;
      if (YTX.panel === panelAtStart && allBtn) { allBtn.disabled = false; allBtn.innerHTML = YTX.icons.zap; }
    }
  }
};
