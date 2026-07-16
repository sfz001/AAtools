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
  featureOrder: ['summary', 'mindmap', 'html', 'cards', 'vocab', 'chat'],
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
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
};

YTX.timeToSeconds = function (str) {
  var parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
};

// AI 返回的 time 字段：仅允许 H:MM:SS / MM:SS / M:SS 格式，否则返回 null
// 用途：cards/vocab/mindmap 渲染时拼到 innerHTML，必须先校验防 DOM 注入
YTX.safeTime = function (str) {
  if (typeof str !== 'string') return null;
  var t = str.trim();
  return /^\d{1,2}(:\d{2}){1,2}$/.test(t) ? t : null;
};

// ── Settings ──────────────────────────────────────────

// 为每次 AI 请求生成唯一 ID，用于过滤切视频/重发后到达的过期 chunk
YTX.makeRequestId = function () {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
        ['provider', 'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'sub2apiModel', 'sub2api2Model', 'sub2api3Model', 'model',
         'prompt', 'promptHtml', 'promptCards', 'promptMindmap', 'promptVocab'],
        function (data) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || '读取扩展设置失败'));
            return;
          }
          try {
            data = data || {};
            var MODEL_MAP = { claude: 'claudeModel', openai: 'openaiModel', gemini: 'geminiModel', minimax: 'minimaxModel', sub2api: 'sub2apiModel', sub2api2: 'sub2api2Model', sub2api3: 'sub2api3Model' };
            var provider = Object.prototype.hasOwnProperty.call(MODEL_MAP, data.provider) ? data.provider : 'claude';
            resolve({
              provider: provider,
              model: data[MODEL_MAP[provider]] || '',
              prompt: data.prompt,
              promptHtml: data.promptHtml,
              promptCards: data.promptCards,
              promptMindmap: data.promptMindmap,
              promptVocab: data.promptVocab,
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

// 主动取消 background 中仍在进行的 fetch/流读取。取消消息本身失败不阻断 UI 重置。
YTX.cancelRequest = function (requestId) {
  if (!requestId) return Promise.resolve(false);
  return YTX.sendToBg({ type: 'CANCEL_REQUEST', requestId: requestId })
    .then(function () { return true; })
    .catch(function () { return false; });
};

// ── 字幕获取 ──────────────────────────────────────────

YTX.fetchTranscript = async function () {
  var result = await YTX.sendToBg({ type: 'FETCH_TRANSCRIPT', videoId: YTX.currentVideoId });
  if (result.error) throw new Error(result.error);
  if (!result.segments || result.segments.length === 0) throw new Error('字幕内容为空');

  // 获取字幕后滚动到页面顶部
  window.scrollTo({ top: 0, behavior: 'smooth' });

  var segments = result.segments;
  var full = segments.map(function (s) { return '[' + YTX.fmtTime(s.start) + '] ' + s.text; }).join('\n');
  var wasTruncated = full.length > YTX.TRANSCRIPT_MAX_CHARS;
  full = YTX.truncateTranscript(full);
  return { segments: segments, full: full, truncated: wasTruncated };
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
        var after = str.substring(i + 1).trimStart();
        var nextCh = after[0];
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

YTX.TRANSCRIPT_MAX_CHARS = 200000; // ~50k tokens，当前支持的模型最小上下文为 128k tokens

YTX.truncateTranscript = function (full) {
  if (full.length <= YTX.TRANSCRIPT_MAX_CHARS) return full;
  var truncated = full.substring(0, YTX.TRANSCRIPT_MAX_CHARS);
  // 截到最后一个完整行
  var lastNewline = truncated.lastIndexOf('\n');
  if (lastNewline > 0) truncated = truncated.substring(0, lastNewline);
  truncated += '\n\n[... 字幕过长，已截断。以上为前 ' + Math.round(YTX.TRANSCRIPT_MAX_CHARS / 1000) + 'k 字符 ...]';
  return truncated;
};

// ── 视频模式相关 ────────────────────────────────────

YTX.getVideoUrl = function () {
  return 'https://www.youtube.com/watch?v=' + YTX.currentVideoId;
};

// 获取内容参数（统一返回 transcript）
YTX.getContentPayload = function () {
  return { transcript: YTX.transcriptData.full };
};

// ── 视频模式提示条 ──────────────────────────────────

YTX.showVideoModeBanner = function () {
  if (!YTX.panel) return;
  var banner = YTX.panel.querySelector('#ytx-video-mode-banner');
  if (banner) banner.style.display = 'flex';
};

// ── 通过 Gemini 分析视频（内部复用）───────────────────

YTX._analyzeVideoWithGemini = async function (expectedGeneration) {
  // 早绑定：整个回退流程（抓 URL、发请求、写结果）都用这个 ID 校验
  var startVideoId = YTX.currentVideoId;
  if (expectedGeneration === undefined) expectedGeneration = YTX._transcriptGeneration;
  // 立即抓 videoUrl，避免后续 await 期间页面切走后取到错的 URL
  var videoUrl = YTX.getVideoUrl();

  // 不在 content script 读 Gemini key —— 缺 key 时由 background 在 TRANSCRIBE 响应里回错
  YTX.videoMode = true;
  YTX.showVideoModeBanner();

  if (YTX.panel) {
    var body = YTX.panel.querySelector('#ytx-transcript-body');
    if (body) body.innerHTML = '<div class="ytx-warning" style="padding:8px 12px;font-size:12px;color:#7c3aed;background:#ede9fe;border-radius:6px">正在通过 Gemini 视频模式转录字幕，长视频会自动分段处理，请耐心等待...</div>';
  }

  // 获取视频时长（秒），用于判断是否需要分段转录
  var videoDuration = 0;
  try {
    var videoEl = document.querySelector('video');
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

  var result;
  try {
    result = await new Promise(function (resolve, reject) {
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
            reject(channelError);
            return;
          }
          if (resp && resp.text) resolve(resp.text);
          else reject(new Error((resp && resp.error) || '视频分析失败'));
        });
      } catch (e) {
        var channelError = new Error('无法连接到扩展后台: ' + e.message);
        channelError.cancelBackgroundRequest = true;
        reject(channelError);
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
    // TRANSCRIBE_SEGMENT 会先清理正常终态；这里覆盖没有 SEGMENT 的失败路径。
    if (YTX._transcribeRequestId === transcribeRequestId) {
      YTX._transcribeRequestId = null;
      YTX._transcribeVideoId = null;
      YTX._transcribeReceiving = false;
      YTX._transcribeBuffer = '';
      if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
    }
  }

  // 转录完成后切视频检查：把结果丢弃，避免污染新视频
  if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== expectedGeneration) {
    throw new Error('字幕请求已失效，转录结果已丢弃');
  }

  // 如果续写过程中已经通过 TRANSCRIBE_SEGMENT 消息渲染了内容，
  // 只更新 transcriptData（供总结等功能使用），不重新渲染
  if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
  var alreadyRendered = YTX.panel && YTX.panel.querySelector('#ytx-seg-container');
  YTX.transcriptData = { full: result };
  if (alreadyRendered) {
    // 更新状态栏为完成
    var status = YTX.panel.querySelector('#ytx-seg-status');
    if (status) {
      status.textContent = '转录完成';
      status.style.color = '#15803d';
    }
  } else {
    YTX.renderTranscript();
  }
};

// ── 手动切换到视频模式 ──────────────────────────────

YTX.switchToVideoMode = function () {
  // busy 时直接 throw，让调用方的 catch 能恢复按钮，不会被当成"切换成功"
  if (YTX.isFetchingTranscript) return Promise.reject(new Error('字幕正在获取中，请稍候'));

  // 早绑定：异步期间用户可能切到别的视频/重建面板
  var startVideoId = YTX.currentVideoId;
  var panelAtStart = YTX.panel;
  var transcriptGeneration = (YTX._transcriptGeneration || 0) + 1;
  YTX._transcriptGeneration = transcriptGeneration;
  YTX.isFetchingTranscript = true;

  // 禁用所有生成按钮
  var BTN_IDS = ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-cards', '#ytx-generate-mindmap', '#ytx-generate-vocab'];
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
          truncated: false,
          videoMode: true,
        });
      }
    } finally {
      if (YTX._transcriptGeneration === transcriptGeneration) YTX.isFetchingTranscript = false;
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
  var transcriptPromise = (async function () {
    try {
      try {
        var data = await YTX.fetchTranscript();
        if (YTX.currentVideoId !== startVideoId || YTX._transcriptGeneration !== transcriptGeneration) return;
        YTX.transcriptData = data;
        YTX.renderTranscript(); // defined in panel.js
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
  // 仅用于将旧版位于 youtube.com origin 下的数据迁移到 background。
  // 日常缓存读写不再打开 IndexedDB。
  DB_NAME: 'AAtoolsCache',
  STORE: 'results',
  _migrationPromise: null,

  _request: function (message) {
    return YTX.sendToBg(message).then(function (response) {
      if (!response || response.ok !== true) {
        throw new Error(response && response.error ? response.error : '缓存操作失败');
      }
      return response;
    });
  },

  _legacyDatabaseExists: function () {
    var self = this;
    if (typeof indexedDB === 'undefined') return Promise.resolve(false);

    // Chromium 支持 databases()；先查名称可避免 open() 在新用户上凭空创建旧库。
    if (typeof indexedDB.databases === 'function') {
      return indexedDB.databases().then(function (databases) {
        return databases.some(function (database) { return database.name === self.DB_NAME; });
      }).catch(function () {
        // 无法确认旧库存在时跳过迁移，避免 open() 创建空库。
        return false;
      });
    }
    return Promise.resolve(false);
  },

  _readLegacyRecords: function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var created = false;
      var request = indexedDB.open(self.DB_NAME);

      request.onupgradeneeded = function () {
        // databases() 查询后若库被其他页面删除，中止升级以免重建空库。
        created = true;
        if (request.transaction) request.transaction.abort();
      };
      request.onerror = function () {
        if (created) resolve([]);
        else reject(new Error('旧缓存打开失败'));
      };
      request.onsuccess = function () {
        var db = request.result;
        if (created || !db.objectStoreNames.contains(self.STORE)) {
          db.close();
          resolve([]);
          return;
        }

        var tx;
        try {
          tx = db.transaction(self.STORE, 'readonly');
        } catch (err) {
          db.close();
          reject(err);
          return;
        }

        var recordsRequest = tx.objectStore(self.STORE).getAll();
        recordsRequest.onsuccess = function () {
          var records = recordsRequest.result || [];
          db.close();
          resolve(records);
        };
        recordsRequest.onerror = function () {
          db.close();
          reject(new Error('旧缓存读取失败'));
        };
      };
    });
  },

  _removeMigratedLegacyRecords: function (records) {
    var self = this;
    return new Promise(function (resolve) {
      var created = false;
      var request = indexedDB.open(self.DB_NAME);
      request.onupgradeneeded = function () {
        created = true;
        if (request.transaction) request.transaction.abort();
      };
      request.onerror = function () { resolve(created); };
      request.onsuccess = function () {
        var db = request.result;
        if (created || !db.objectStoreNames.contains(self.STORE)) {
          db.close();
          resolve(true);
          return;
        }
        var settled = false;
        function finish(ok) {
          if (settled) return;
          settled = true;
          db.close();
          resolve(ok);
        }
        try {
          var tx = db.transaction(self.STORE, 'readwrite');
          var store = tx.objectStore(self.STORE);
          records.forEach(function (snapshot) {
            var getRequest = store.get(snapshot.videoId);
            getRequest.onsuccess = function () {
              var current = getRequest.result;
              var unchanged = false;
              try {
                unchanged = JSON.stringify(current) === JSON.stringify(snapshot);
              } catch (_) {}
              // 旧标签可能在迁移期间写入；只删除仍等于已确认快照的记录，
              // 新增或更新过的记录保留，留待下一次页面加载迁移。
              if (unchanged) store.delete(snapshot.videoId);
            };
          });
          tx.oncomplete = function () { finish(true); };
          tx.onerror = function () { finish(false); };
          tx.onabort = function () { finish(false); };
        } catch (_) {
          finish(false);
        }
      };
    });
  },

  _removeLegacyRecord: function (videoId) {
    var self = this;
    return this._legacyDatabaseExists().then(function (exists) {
      if (!exists) return true;
      return new Promise(function (resolve) {
        var created = false;
        var request = indexedDB.open(self.DB_NAME);
        request.onupgradeneeded = function () {
          created = true;
          if (request.transaction) request.transaction.abort();
        };
        request.onerror = function () { resolve(created); };
        request.onsuccess = function () {
          var db = request.result;
          if (created || !db.objectStoreNames.contains(self.STORE)) {
            db.close();
            resolve(true);
            return;
          }
          var settled = false;
          function finish(ok) {
            if (settled) return;
            settled = true;
            db.close();
            resolve(ok);
          }
          try {
            var tx = db.transaction(self.STORE, 'readwrite');
            tx.objectStore(self.STORE).delete(videoId);
            tx.oncomplete = function () { finish(true); };
            tx.onerror = function () { finish(false); };
            tx.onabort = function () { finish(false); };
          } catch (_) {
            finish(false);
          }
        };
      });
    }).catch(function () { return false; });
  },

  _migrateLegacy: function () {
    var self = this;
    if (this._migrationPromise) return this._migrationPromise;

    this._migrationPromise = this._legacyDatabaseExists().then(function (exists) {
      if (!exists) return false;
      return self._readLegacyRecords().then(async function (records) {
        // 逐条等待 background 落盘确认。中途失败时保留整个旧库，
        // 下次页面加载可安全重试（background 合并操作必须是幂等的）。
        for (var i = 0; i < records.length; i++) {
          await self._request({ type: 'CACHE_MIGRATE_RECORD', record: records[i] });
        }
        // 不调用 deleteDatabase：旧版标签页可能长期持有连接，blocked 的删除请求
        // 无法取消并会阻塞后续 open。仅条件删除已迁移且仍未变化的旧记录。
        return self._removeMigratedLegacyRecords(records);
      });
    }).catch(function () {
      // 迁移失败不影响新缓存通道，也绝不删除旧数据。
      return false;
    });

    return this._migrationPromise;
  },

  // 保存某个 feature 的结果
  save: function (videoId, featureKey, data) {
    var self = this;
    return this._migrateLegacy().then(function () {
      return self._request({
        type: 'CACHE_SAVE',
        videoId: videoId,
        featureKey: featureKey,
        data: data,
      });
    }).then(function () { return true; }).catch(function () { return false; });
  },

  // 删除某个视频的缓存
  remove: function (videoId) {
    var self = this;
    return this._migrateLegacy().then(function () {
      return self._request({ type: 'CACHE_REMOVE', videoId: videoId });
    }).then(function () {
      // 若迁移因某条损坏记录失败，旧库仍会保留；同时删除目标视频，避免下次迁移把它复活。
      return self._removeLegacyRecord(videoId);
    }).then(function (legacyRemoved) { return legacyRemoved === true; }).catch(function () { return false; });
  },

  // 清空全部缓存。注意：background 校验 sender 必须是 youtube.com 顶层页面，
  // 只能从 YouTube 页内 UI 调用；设置页等扩展页面发的消息会被拒。
  clear: function () {
    var self = this;
    return this._migrateLegacy().then(function () {
      return self._request({ type: 'CACHE_CLEAR' });
    }).then(function () { return true; }).catch(function () { return false; });
  },

  // 加载某个视频的全部缓存
  load: function (videoId) {
    var self = this;
    return this._migrateLegacy().then(function () {
      return self._request({ type: 'CACHE_LOAD', videoId: videoId });
    }).then(function (response) {
      return response.record || null;
    }).catch(function () { return null; });
  },
};

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
        chrome.storage.sync.get(['generateAllSummary', 'generateAllMindmap', 'generateAllHtml', 'generateAllCards', 'generateAllVocab'], function (data) {
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
  if (settings.generateAllCards) keys.push('cards');
  if (settings.generateAllVocab) keys.push('vocab');
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
