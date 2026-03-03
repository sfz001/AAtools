// src/core.js — YTX 命名空间、共享状态、工具函数、字幕获取、settings

var YTX = {
  // 共享状态
  panel: null,
  currentVideoId: null,
  transcriptData: null,
  videoMode: false, // true = 无字幕，使用 Gemini 视频模式
  activeTab: 'summary',
  isFetchingTranscript: false, // true = 正在获取字幕，禁止生成操作
  resizerInjected: false,

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

YTX.parseError = function (contentEl, label, err) {
  contentEl.innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + label + '解析失败: ' + err.message + '<br>可尝试重新生成</div>';
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

// ── Settings ──────────────────────────────────────────

YTX.getSettings = function () {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(
      ['provider', 'claudeKey', 'openaiKey', 'geminiKey', 'claudeModel', 'openaiModel', 'geminiModel', 'model',
       'prompt', 'promptHtml', 'promptCards', 'promptMindmap', 'promptVocab'],
      function (data) {
        var provider = data.provider || 'claude';
        var KEY_MAP = { claude: 'claudeKey', openai: 'openaiKey', gemini: 'geminiKey' };
        var MODEL_MAP = { claude: 'claudeModel', openai: 'openaiModel', gemini: 'geminiModel' };
        resolve({
          provider: provider,
          activeKey: data[KEY_MAP[provider]] || '',
          model: data[MODEL_MAP[provider]] || '',
          prompt: data.prompt,
          promptHtml: data.promptHtml,
          promptCards: data.promptCards,
          promptMindmap: data.promptMindmap,
          promptVocab: data.promptVocab,
        });
      }
    );
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

// ── 字幕获取 ──────────────────────────────────────────

YTX.fetchTranscript = async function () {
  var result = await YTX.sendToBg({ type: 'FETCH_TRANSCRIPT', videoId: YTX.currentVideoId });
  if (result.error) throw new Error(result.error);
  if (!result.segments || result.segments.length === 0) throw new Error('字幕内容为空');

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

YTX.getGeminiKey = function () {
  return new Promise(function (resolve) {
    chrome.storage.sync.get(['geminiKey'], function (data) {
      resolve(data.geminiKey || '');
    });
  });
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

YTX._analyzeVideoWithGemini = async function () {
  var geminiKey = await YTX.getGeminiKey();
  if (!geminiKey) {
    throw new Error('该视频无字幕。配置 Gemini API Key 后可直接分析视频内容');
  }

  YTX.videoMode = true;
  YTX.showVideoModeBanner();

  if (YTX.panel) {
    var body = YTX.panel.querySelector('#ytx-transcript-body');
    if (body) body.innerHTML = '<div class="ytx-warning" style="padding:8px 12px;font-size:12px;color:#7c3aed;background:#ede9fe;border-radius:6px">正在通过 Gemini 视频模式转录字幕，长视频会自动分段处理，请耐心等待...</div>';
  }

  var videoUrl = YTX.getVideoUrl();
  // 获取视频时长（秒），用于判断是否需要分段转录
  var videoDuration = 0;
  try {
    var videoEl = document.querySelector('video');
    if (videoEl && videoEl.duration && isFinite(videoEl.duration)) {
      videoDuration = Math.round(videoEl.duration);
    }
  } catch (e) { /* ignore */ }

  var result = await new Promise(function (resolve, reject) {
    try {
      chrome.runtime.sendMessage({
        type: 'TRANSCRIBE_VIDEO',
        videoUrl: videoUrl,
        activeKey: geminiKey,
        videoDuration: videoDuration,
      }, function (resp) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || '视频分析请求失败'));
          return;
        }
        if (resp && resp.text) resolve(resp.text);
        else reject(new Error((resp && resp.error) || '视频分析失败'));
      });
    } catch (e) {
      reject(new Error('无法连接到扩展后台: ' + e.message));
    }
  });

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

YTX.switchToVideoMode = async function () {
  if (YTX.isFetchingTranscript) return;
  YTX.isFetchingTranscript = true;

  // 禁用所有生成按钮
  ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-cards', '#ytx-generate-mindmap', '#ytx-generate-vocab'].forEach(function (id) {
    var b = YTX.panel && YTX.panel.querySelector(id);
    if (b) b.disabled = true;
  });

  // 清空字幕数据（保留各模块已生成的内容）
  YTX.transcriptData = null;

  try {
    await YTX._analyzeVideoWithGemini();
    // 缓存视频模式字幕
    if (YTX.transcriptData && YTX.currentVideoId) {
      YTX.cache.save(YTX.currentVideoId, 'transcript', {
        segments: null,
        full: YTX.transcriptData.full,
        truncated: false,
        videoMode: true,
      });
    }
  } finally {
    YTX.isFetchingTranscript = false;
    // 恢复所有生成按钮
    ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-cards', '#ytx-generate-mindmap', '#ytx-generate-vocab'].forEach(function (id) {
      var b = YTX.panel && YTX.panel.querySelector(id);
      if (b) b.disabled = false;
    });
  }
};

// ── 确保字幕已加载（各模块共用）───────────────────────

YTX.ensureTranscript = async function () {
  if (YTX.transcriptData) return;

  try {
    YTX.transcriptData = await YTX.fetchTranscript();
    YTX.renderTranscript(); // defined in panel.js
  } catch (err) {
    await YTX._analyzeVideoWithGemini();
  }

  // 缓存字幕数据
  if (YTX.transcriptData && YTX.currentVideoId) {
    YTX.cache.save(YTX.currentVideoId, 'transcript', {
      segments: YTX.transcriptData.segments || null,
      full: YTX.transcriptData.full,
      truncated: YTX.transcriptData.truncated || false,
      videoMode: YTX.videoMode,
    });
  }
};

// ── 历史记录持久化（IndexedDB）──────────────────────

YTX.cache = {
  DB_NAME: 'AAtoolsCache',
  DB_VERSION: 1,
  STORE: 'results',
  _db: null,

  open: function () {
    var self = this;
    if (this._db) return Promise.resolve(this._db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(self.DB_NAME, self.DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(self.STORE)) {
          db.createObjectStore(self.STORE, { keyPath: 'videoId' });
        }
      };
      req.onsuccess = function (e) { self._db = e.target.result; resolve(self._db); };
      req.onerror = function () { reject(new Error('IndexedDB 打开失败')); };
    });
  },

  // 保存某个 feature 的结果
  save: function (videoId, featureKey, data) {
    return this.open().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('results', 'readwrite');
        var store = tx.objectStore('results');
        var getReq = store.get(videoId);
        getReq.onsuccess = function () {
          var record = getReq.result || { videoId: videoId };
          record[featureKey] = data;
          record.updatedAt = Date.now();
          store.put(record);
          resolve();
        };
        getReq.onerror = function () { resolve(); };
      });
    }).catch(function () {});
  },

  // 加载某个视频的全部缓存
  load: function (videoId) {
    return this.open().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction('results', 'readonly');
        var store = tx.objectStore('results');
        var req = store.get(videoId);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  },
};

// ── 全部生成（并行，跳过 chat）───────────────────────

YTX.generateAll = async function () {
  if (YTX.isFetchingTranscript) return;
  var keys = ['summary', 'html', 'cards', 'mindmap', 'vocab'];
  var allBtn = YTX.panel && YTX.panel.querySelector('#ytx-generate-all');
  if (allBtn) { allBtn.blur(); allBtn.disabled = true; allBtn.innerHTML = YTX.icons.spinner; }

  // 先统一拿字幕，避免各模块重复获取
  await YTX.ensureTranscript();

  // 同时启动所有模块，各模块自己管理按钮状态
  var promises = keys.map(function (key) {
    var f = YTX.features[key];
    if (!f || !f.start || f.isGenerating) return Promise.resolve();
    return new Promise(function (resolve) {
      var origDone = f.onDone;
      var origError = f.onError;
      f.onDone = function () {
        f.onDone = origDone;
        f.onError = origError;
        origDone.call(f);
        resolve();
      };
      f.onError = function (err) {
        f.onDone = origDone;
        f.onError = origError;
        origError.call(f, err);
        resolve();
      };
      f.start();
    });
  });

  await Promise.all(promises);
  if (allBtn) { allBtn.disabled = false; allBtn.innerHTML = YTX.icons.zap; }
};
