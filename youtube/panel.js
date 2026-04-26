// src/panel.js — 面板注入、tab 切换、resizer、消息路由、init

(function () {
  'use strict';

  // ── 消息前缀到功能模块的映射 ─────────────────────────
  // SUMMARY_CHUNK → features.summary, HTML_CHUNK → features.html, etc.
  var prefixMap = {};
  YTX.featureOrder.forEach(function (key) {
    var f = YTX.features[key];
    if (f && f.prefix) {
      prefixMap[f.prefix] = f;
    }
  });

  // ── 入口 ──────────────────────────────────────────────

  function init() {
    document.addEventListener('yt-navigate-finish', onNavigate);
    onNavigate();
  }

  // 重置全部字幕/转写在途状态，导航离开视频页或切视频时调用
  function resetTranscriptState() {
    YTX.transcriptData = null;
    YTX.videoMode = false;
    YTX._transcriptPromise = null;
    YTX._transcriptVideoId = null;
    YTX._transcribeVideoId = null;
    YTX._transcribeRequestId = null;
    YTX._transcribeBuffer = '';
    YTX._transcribeReceiving = false;
    if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
    YTX.isFetchingTranscript = false;
  }

  function onNavigate() {
    var videoId = getVideoId();
    if (!videoId) {
      // 离开视频页（首页/搜索/频道页等）：清状态 + 重置功能模块，
      // 否则旧 in-flight 转写会让下一个视频被错误拦截
      resetTranscriptState();
      YTX.currentVideoId = null;
      YTX.featureOrder.forEach(function (key) {
        var f = YTX.features[key];
        if (f && f.reset) f.reset();
      });
      removePanel();
      removeResizer();
      return;
    }
    if (videoId === YTX.currentVideoId && YTX.panel) return;
    YTX.currentVideoId = videoId;
    resetTranscriptState();
    YTX.activeTab = 'summary';

    // 重置所有功能模块状态
    YTX.featureOrder.forEach(function (key) {
      var f = YTX.features[key];
      if (f && f.reset) f.reset();
    });

    waitForContainer(function () {
      injectPanel();
      restoreFromCache(videoId);
    });
  }

  function restoreFromCache(videoId) {
    YTX.cache.load(videoId).then(function (record) {
      // 异步竞态防护：缓存读取期间用户可能已切到别的视频
      if (videoId !== YTX.currentVideoId) return;
      if (!record || !YTX.panel) return;

      // 字幕
      if (record.transcript && record.transcript.full) {
        YTX.transcriptData = {
          segments: record.transcript.segments || null,
          full: record.transcript.full,
          truncated: record.transcript.truncated || false,
        };
        if (record.transcript.videoMode) {
          YTX.videoMode = true;
          YTX.showVideoModeBanner();
        }
        YTX.renderTranscript();
      }

      // 总结
      if (record.summary && record.summary.text) {
        var s = YTX.features.summary;
        s.text = record.summary.text;
        s.renderFinal();
        YTX.btnRefresh(YTX.panel.querySelector('#ytx-summarize'));
      }

      // 笔记
      if (record.html && record.html.text) {
        var h = YTX.features.html;
        h.text = record.html.text;
        h.renderContent();
        YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-html'));
      }

      // 卡片
      if (record.cards && record.cards.data && record.cards.data.length > 0) {
        var c = YTX.features.cards;
        c.data = record.cards.data;
        c.render();
        YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-cards'));
      }

      // 导图
      if (record.mindmap && record.mindmap.data) {
        var m = YTX.features.mindmap;
        m.data = record.mindmap.data;
        m.render();
        YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-mindmap'));
      }

      // 词汇
      if (record.vocab && record.vocab.data && record.vocab.data.length > 0) {
        var v = YTX.features.vocab;
        v.data = record.vocab.data;
        v.render();
        YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-vocab'));
      }
    });
  }

  function getVideoId() {
    var url = new URL(location.href);
    return url.searchParams.get('v');
  }

  // ── 等待右侧栏加载 ────────────────────────────────────

  function waitForContainer(callback, retries) {
    retries = retries !== undefined ? retries : 30;
    var container = document.querySelector('#secondary, #secondary-inner');
    if (container) { callback(); }
    else if (retries > 0) { setTimeout(function () { waitForContainer(callback, retries - 1); }, 500); }
  }

  // ── 面板注入 ─────────────────────────────────────────

  function injectPanel() {
    removePanel();
    var panel = document.createElement('div');
    panel.id = 'ytx-panel';
    YTX.panel = panel;

    // 动态拼接 tabs（图标 + tooltip）
    var tabsHtml = YTX.featureOrder.map(function (key) {
      var f = YTX.features[key];
      var active = key === 'summary' ? ' active' : '';
      return '<button class="ytx-tab' + active + '" data-tab="' + key + '" title="' + f.tab.label + '">' + (f.tab.icon || f.tab.label) + '</button>';
    }).join('');

    // 动态拼接 actions（嵌入 tabs 行右侧）
    var actionsHtml = YTX.featureOrder.map(function (key) {
      var f = YTX.features[key];
      var display = key === 'summary' ? 'flex' : 'none';
      return '<div id="' + f.actionsId + '" style="display:' + display + '">' + f.actionsHtml() + '</div>';
    }).join('');

    // 动态拼接 content
    var contentHtml = YTX.featureOrder.map(function (key) {
      var f = YTX.features[key];
      var display = key === 'summary' ? f.displayMode : 'none';
      return '<div id="' + f.contentId + '" style="display:' + display + '">' + f.contentHtml() + '</div>';
    }).join('');

    panel.innerHTML =
      '<div id="ytx-tabs">' +
        tabsHtml +
        '<div id="ytx-actions">' + actionsHtml + '</div>' +
      '</div>' +
      '<div id="ytx-video-mode-banner" style="display:none">' +
        '<span>已通过 Gemini 视频模式获取内容</span>' +
        '<button id="ytx-video-mode-close" title="关闭提示">\u00D7</button>' +
      '</div>' +
      contentHtml +
      '<div id="ytx-transcript-section">' +
        '<div id="ytx-transcript-header">' +
          '<button id="ytx-transcript-toggle">' +
            '<span>查看字幕</span>' +
            '<span class="arrow">\u25BC</span>' +
          '</button>' +
          '<span id="ytx-seg-status" style="flex:1;font-size:11px;color:#7c3aed;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>' +
          '<button id="ytx-clear-cache" class="ytx-btn ytx-btn-clear-cache" title="清除本视频缓存">清除缓存</button>' +
          '<button id="ytx-use-video-mode" class="ytx-btn ytx-btn-video-mode">使用视频模式</button>' +
        '</div>' +
        '<div id="ytx-transcript-body"></div>' +
      '</div>';

    var secondary = document.querySelector('#secondary, #secondary-inner');
    if (secondary) secondary.prepend(panel);

    // 绑定各模块事件
    YTX.featureOrder.forEach(function (key) {
      var f = YTX.features[key];
      if (f && f.bindEvents) f.bindEvents(panel);
    });

    // 绑定 tab 切换
    panel.querySelectorAll('.ytx-tab').forEach(function (tab) {
      tab.addEventListener('click', function () { switchTab(tab.dataset.tab); });
    });

    // 绑定字幕折叠
    panel.querySelector('#ytx-transcript-toggle').addEventListener('click', toggleTranscript);

    // 绑定视频模式提示条关闭
    panel.querySelector('#ytx-video-mode-close').addEventListener('click', function () {
      var banner = panel.querySelector('#ytx-video-mode-banner');
      if (banner) banner.style.display = 'none';
    });

    // 绑定「使用视频模式」按钮
    panel.querySelector('#ytx-use-video-mode').addEventListener('click', function () {
      var btn = panel.querySelector('#ytx-use-video-mode');
      if (btn) { btn.disabled = true; btn.textContent = 'Gemini视频模式中...'; }
      YTX.switchToVideoMode().then(function () {
        // 切换成功后隐藏按钮
        if (btn) btn.style.display = 'none';
      }).catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '使用视频模式'; }
        var body = panel.querySelector('#ytx-transcript-body');
        if (body) body.innerHTML = '<div class="ytx-error">' + (err.message || '视频模式切换失败') + '</div>';
      });
    });

    // 绑定「清除缓存」按钮
    panel.querySelector('#ytx-clear-cache').addEventListener('click', function () {
      if (!YTX.currentVideoId) return;
      var btn = panel.querySelector('#ytx-clear-cache');
      YTX.cache.remove(YTX.currentVideoId).then(function () {
        YTX.transcriptData = null;
        YTX.videoMode = false;
        YTX._transcriptPromise = null;
        YTX._transcriptVideoId = null;
        var body = panel.querySelector('#ytx-transcript-body');
        if (body) body.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#15803d;background:#f0fdf4;border-radius:6px">缓存已清除，下次操作将重新获取字幕</div>';
        var banner = panel.querySelector('#ytx-video-mode-banner');
        if (banner) banner.style.display = 'none';
        var videoBtn = panel.querySelector('#ytx-use-video-mode');
        if (videoBtn) { videoBtn.style.display = ''; videoBtn.disabled = false; videoBtn.textContent = '使用视频模式'; }
        if (btn) { btn.textContent = '已清除'; setTimeout(function () { btn.textContent = '清除缓存'; }, 1500); }
      });
    });

    // 阻止面板内滚轮事件冒泡到页面
    panel.addEventListener('wheel', function (e) {
      e.stopPropagation();
    });

    // 面板级时间戳点击委托
    setupTimestampClickHandler(panel);

    // 注入分栏条
    injectResizer();
  }

  function removePanel() {
    if (YTX.panel) { YTX.panel.remove(); YTX.panel = null; }
  }

  // ── 标签切换 ─────────────────────────────────────────

  function switchTab(tab) {
    if (!YTX.panel) return;
    YTX.activeTab = tab;
    YTX.panel.querySelectorAll('.ytx-tab').forEach(function (t) {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    YTX.featureOrder.forEach(function (key) {
      var f = YTX.features[key];
      var isActive = key === tab;
      YTX.panel.querySelector('#' + f.contentId).style.display = isActive ? f.displayMode : 'none';
      YTX.panel.querySelector('#' + f.actionsId).style.display = isActive ? 'flex' : 'none';
    });

    // 字幕区在所有标签下都显示


    if (tab === 'chat') {
      var input = YTX.panel.querySelector('#ytx-chat-input');
      setTimeout(function () { input.focus(); }, 100);
    }

    // 导图首次可见时重新 auto-fit
    if (tab === 'mindmap') {
      var m = YTX.features.mindmap;
      if (m.data && !m._fitted) {
        m.transform = { x: 0, y: 0, scale: 1 };
        m.render();
        m._fitted = true;
      }
    }
  }

  // ── 字幕面板 ─────────────────────────────────────────

  YTX.renderTranscript = function () {
    if (!YTX.transcriptData || !YTX.panel) return;
    var body = YTX.panel.querySelector('#ytx-transcript-body');

    // 视频模式：只有 full 文本，没有 segments
    if (!YTX.transcriptData.segments) {
      // 按时间戳边界拆分（支持内联时间戳如 [00:38] 文字 [00:43] 文字）
      var raw = YTX.transcriptData.full.replace(/\n/g, ' ');
      var parts = raw.split(/(?=\[\d+:\d+(?::\d+)?\])/).filter(function (s) { return s.trim(); });
      body.innerHTML =
        '<div class="ytx-warning" style="padding:6px 12px;font-size:11px;color:#7c3aed;background:#ede9fe;border-radius:6px;margin-bottom:6px">以下为 Gemini 视频模式获取的内容</div>' +
        parts.map(function (part) {
          var seg = part.trim();
          var m = seg.match(/^\[(\d+:\d+(?::\d+)?)\]\s*(.*)/);
          if (m && m[2].trim()) {
            var seconds = YTX.timeToSeconds(m[1]);
            return '<div class="ytx-transcript-line">' +
              '<span class="ytx-ts" data-time="' + seconds + '">[' + m[1] + ']</span>' +
              '<span>' + YTX.escapeHtml(m[2].trim()) + '</span>' +
            '</div>';
          }
          return '<div class="ytx-transcript-line"><span>' + YTX.escapeHtml(seg) + '</span></div>';
        }).join('');
      return;
    }

    var warn = YTX.transcriptData.truncated
      ? '<div class="ytx-warning" style="padding:6px 12px;font-size:11px;color:#b45309;background:#fef3c7;border-radius:6px;margin-bottom:6px">字幕较长，已截断至前 ' + Math.round(YTX.TRANSCRIPT_MAX_CHARS / 1000) + 'k 字符，后半部分内容可能不会被 AI 分析到</div>'
      : '';
    body.innerHTML = warn + YTX.transcriptData.segments.map(function (s) {
      return '<div class="ytx-transcript-line">' +
        '<span class="ytx-ts" data-time="' + s.start + '">' + YTX.fmtTime(s.start) + '</span>' +
        '<span>' + YTX.escapeHtml(s.text) + '</span>' +
      '</div>';
    }).join('');
  };

  function toggleTranscript() {
    var section = YTX.panel.querySelector('#ytx-transcript-section');
    var body = YTX.panel.querySelector('#ytx-transcript-body');
    var arrow = YTX.panel.querySelector('#ytx-transcript-toggle .arrow');
    body.classList.toggle('open');
    arrow.classList.toggle('open');
    section.classList.toggle('expanded');
  }

  // ── 时间戳跳转（面板级事件委托）───────────────────────

  function setupTimestampClickHandler(panelEl) {
    panelEl.addEventListener('click', function (e) {
      var ts = e.target.closest('.ytx-timestamp, .ytx-ts');
      if (!ts) return;
      e.preventDefault();
      e.stopPropagation();
      var time = parseInt(ts.dataset.time, 10);
      if (isNaN(time)) return;
      var video = document.querySelector('video');
      if (video) { video.currentTime = time; video.play(); }
    });
  }

  // ── 可拖拽分栏条 ─────────────────────────────────────

  function injectResizer() {
    if (YTX.resizerInjected) return;
    var columns = document.querySelector('ytd-watch-flexy #columns');
    var primary = columns && columns.querySelector('#primary');
    var secondary = columns && columns.querySelector('#secondary');
    if (!columns || !primary || !secondary) return;

    var resizer = document.createElement('div');
    resizer.id = 'ytx-resizer';
    resizer.innerHTML = '<div class="ytx-resizer-handle"><div class="ytx-resizer-dot"></div><div class="ytx-resizer-dot"></div><div class="ytx-resizer-dot"></div></div>';
    columns.insertBefore(resizer, secondary);
    YTX.resizerInjected = true;

    columns.style.display = 'flex';
    columns.style.flexWrap = 'nowrap';

    // 默认分栏：视频占 3/5，AAtools 占 2/5
    var resizerWidth = 24;
    var splitRatio = 3 / 5; // 当前 primary 占比，拖动时更新

    function applyColumns() {
      var totalWidth = columns.getBoundingClientRect().width;
      var minPrimary = totalWidth * 0.3;
      var minSecondary = 440;
      var primaryWidth = Math.round((totalWidth - resizerWidth) * splitRatio);
      primaryWidth = Math.max(minPrimary, Math.min(primaryWidth, totalWidth - minSecondary - resizerWidth));
      var secondaryWidth = totalWidth - primaryWidth - resizerWidth;

      primary.style.width = primaryWidth + 'px';
      primary.style.maxWidth = 'none';
      primary.style.minWidth = '0';
      primary.style.flex = 'none';

      secondary.style.width = secondaryWidth + 'px';
      secondary.style.maxWidth = 'none';
      secondary.style.minWidth = '0';
      secondary.style.flex = 'none';
    }

    applyColumns();
    forceVideoResize(primary);

    // window resize 只重算列宽，不调 forceVideoResize，避免循环触发
    YTX._resizerOnWindowResize = function () {
      applyColumns();
    };
    window.addEventListener('resize', YTX._resizerOnWindowResize);

    var isDragging = false;

    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      isDragging = true;
      resizer.classList.add('ytx-resizer-active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      var overlay = document.getElementById('ytx-drag-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ytx-drag-overlay';
        document.body.appendChild(overlay);
      }
      overlay.style.display = 'block';
    });

    // 保存引用以便清理
    YTX._resizerOnMove = function (e) {
      if (!isDragging) return;
      var columnsRect = columns.getBoundingClientRect();
      var totalWidth = columnsRect.width;
      var primaryWidth = e.clientX - columnsRect.left;
      var minPrimary = totalWidth * 0.3;
      var minSecondary = 440;
      primaryWidth = Math.max(minPrimary, Math.min(primaryWidth, totalWidth - minSecondary - resizerWidth));
      splitRatio = primaryWidth / (totalWidth - resizerWidth);

      primary.style.width = primaryWidth + 'px';
      primary.style.maxWidth = 'none';
      primary.style.minWidth = '0';
      primary.style.flex = 'none';

      secondary.style.width = (totalWidth - primaryWidth - resizerWidth) + 'px';
      secondary.style.maxWidth = 'none';
      secondary.style.minWidth = '0';
      secondary.style.flex = 'none';

      forceVideoResize(primary);
    };

    YTX._resizerOnUp = function () {
      if (!isDragging) return;
      isDragging = false;
      resizer.classList.remove('ytx-resizer-active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      var overlay = document.getElementById('ytx-drag-overlay');
      if (overlay) overlay.style.display = 'none';
      forceVideoResize(primary);
    };

    document.addEventListener('mousemove', YTX._resizerOnMove);
    document.addEventListener('mouseup', YTX._resizerOnUp);
  }

  function forceVideoResize(primary) {
    var watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy) watchFlexy.classList.add('ytx-resized');

    var playerContainer = primary.querySelector('#player-container-inner');
    if (playerContainer) {
      playerContainer.style.maxWidth = '100%';
    }
    var moviePlayer = primary.querySelector('#movie_player');
    if (moviePlayer) {
      var outer = primary.querySelector('#player-container-outer');
      var w = (outer && outer.clientWidth) || primary.clientWidth;
      var h = Math.round(w * 9 / 16);
      moviePlayer.style.width = w + 'px';
      moviePlayer.style.height = h + 'px';
    }
    window.dispatchEvent(new Event('resize'));
  }

  function removeResizer() {
    // 清理 document 级事件监听器
    if (YTX._resizerOnMove) { document.removeEventListener('mousemove', YTX._resizerOnMove); YTX._resizerOnMove = null; }
    if (YTX._resizerOnUp) { document.removeEventListener('mouseup', YTX._resizerOnUp); YTX._resizerOnUp = null; }
    if (YTX._resizerOnWindowResize) { window.removeEventListener('resize', YTX._resizerOnWindowResize); YTX._resizerOnWindowResize = null; }

    var resizer = document.getElementById('ytx-resizer');
    if (resizer) resizer.remove();
    var overlay = document.getElementById('ytx-drag-overlay');
    if (overlay) overlay.remove();
    YTX.resizerInjected = false;

    var watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy) watchFlexy.classList.remove('ytx-resized');
    var columns = document.querySelector('ytd-watch-flexy #columns');
    var primary = columns && columns.querySelector('#primary');
    var secondary = columns && columns.querySelector('#secondary');
    if (primary) { primary.style.width = ''; primary.style.maxWidth = ''; primary.style.minWidth = ''; primary.style.flex = ''; }
    if (secondary) { secondary.style.width = ''; secondary.style.maxWidth = ''; secondary.style.minWidth = ''; secondary.style.flex = ''; }

    var playerContainer = primary && primary.querySelector('#player-container-inner');
    if (playerContainer) playerContainer.style.maxWidth = '';
    var moviePlayer = primary && primary.querySelector('#movie_player');
    if (moviePlayer) { moviePlayer.style.width = ''; moviePlayer.style.height = ''; }
    window.dispatchEvent(new Event('resize'));
  }

  // ── 消息路由 ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (message) {
    if (!YTX.panel) return;

    // 模型信息（调试用，显示在面板底部）
    if (message.type && message.type.endsWith('_MODEL')) {
      // 与 _CHUNK/_DONE/_ERROR 同样的 requestId 过滤：避免旧请求的模型名更新当前 badge
      var modelPrefix = message.type.slice(0, -('_MODEL'.length));
      var modelFeature = prefixMap[modelPrefix];
      if (modelFeature && message.requestId && message.requestId !== modelFeature.requestId) return;

      var badge = YTX.panel.querySelector('#ytx-model-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'ytx-model-badge';
        badge.style.cssText = 'padding:4px 12px;font-size:11px;color:#9ca3af;text-align:right;';
        YTX.panel.appendChild(badge);
      }
      badge.textContent = message.provider + ' / ' + message.model;
    }

    // ── 视频转录流式 chunk ──
    if (message.type === 'TRANSCRIBE_CHUNK') {
      // videoId + requestId 双重过滤：切视频后旧转录、同视频下被取消的旧请求都丢弃
      if (message.videoId && message.videoId !== YTX.currentVideoId) return;
      if (message.requestId && message.requestId !== YTX._transcribeRequestId) return;
      // 首个 chunk 到达，切换计时器文案
      if (YTX._transcribeTimer && !YTX._transcribeReceiving) {
        YTX._transcribeReceiving = true;
      }
      var body = YTX.panel.querySelector('#ytx-transcript-body');
      if (!body) return;
      var container = body.querySelector('#ytx-seg-container');
      if (!container) return;
      // 追加到流式缓冲区，按时间戳边界拆分渲染
      if (!YTX._transcribeBuffer) YTX._transcribeBuffer = '';
      YTX._transcribeBuffer += message.text;
      // 按 [MM:SS] 或 [H:MM:SS] 边界拆分，保留时间戳在片段开头
      var segments = YTX._transcribeBuffer.split(/(?=\[\d+:\d+(?::\d+)?\])/);
      // 最后一段可能不完整（没遇到下一个时间戳），留在缓冲区
      YTX._transcribeBuffer = segments.pop() || '';
      for (var si = 0; si < segments.length; si++) {
        // 每段可能含换行，合并为一条
        var seg = segments[si].replace(/\n/g, ' ').trim();
        if (!seg) continue;
        var m = seg.match(/^\[(\d+:\d+(?::\d+)?)\]\s*(.*)/);
        if (m) {
          var seconds = YTX.timeToSeconds(m[1]);
          var text = m[2].trim();
          if (!text) continue;
          container.insertAdjacentHTML('beforeend',
            '<div class="ytx-transcript-line">' +
            '<span class="ytx-ts" data-time="' + seconds + '">[' + m[1] + ']</span>' +
            '<span>' + YTX.escapeHtml(text) + '</span></div>');
        } else {
          container.insertAdjacentHTML('beforeend',
            '<div class="ytx-transcript-line"><span>' + YTX.escapeHtml(seg) + '</span></div>');
        }
      }
      container.scrollTop = container.scrollHeight;
      return;
    }

    // ── 视频转录开始 ──
    if (message.type === 'TRANSCRIBE_PROGRESS') {
      if (message.videoId && message.videoId !== YTX.currentVideoId) return;
      if (message.requestId && message.requestId !== YTX._transcribeRequestId) return;
      var body = YTX.panel.querySelector('#ytx-transcript-body');
      if (!body) return;
      YTX._transcribeBuffer = '';
      body.innerHTML = '<div id="ytx-seg-container"></div>';
      YTX._transcribeReceiving = false;
      var status = YTX.panel.querySelector('#ytx-seg-status');
      if (status) {
        status.style.color = '#7c3aed';
        if (YTX._transcribeTimer) clearInterval(YTX._transcribeTimer);
        var startTime = Date.now();
        function updateTimer() {
          var elapsed = Math.floor((Date.now() - startTime) / 1000);
          var mm = Math.floor(elapsed / 60);
          var ss = elapsed % 60;
          var timeStr = mm > 0 ? mm + '分' + ss + '秒' : ss + '秒';
          if (YTX._transcribeReceiving) {
            status.textContent = '正在转录（' + timeStr + '）...';
          } else {
            status.textContent = 'Gemini 正在处理音频（' + timeStr + '）...';
          }
        }
        updateTimer();
        YTX._transcribeTimer = setInterval(updateTimer, 1000);
      }
      return;
    }

    // ── 视频转录完成 ──
    if (message.type === 'TRANSCRIBE_SEGMENT') {
      if (message.videoId && message.videoId !== YTX.currentVideoId) return;
      if (message.requestId && message.requestId !== YTX._transcribeRequestId) return;
      if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
      var body = YTX.panel.querySelector('#ytx-transcript-body');
      if (!body) return;
      var container = body.querySelector('#ytx-seg-container');

      // flush 缓冲区剩余内容
      if (YTX._transcribeBuffer && container) {
        var remaining = YTX._transcribeBuffer.replace(/\n/g, ' ').trim();
        if (remaining) {
          var segs = remaining.split(/(?=\[\d+:\d+(?::\d+)?\])/);
          for (var fi = 0; fi < segs.length; fi++) {
            var seg = segs[fi].trim();
            if (!seg) continue;
            var m = seg.match(/^\[(\d+:\d+(?::\d+)?)\]\s*(.*)/);
            if (m && m[2].trim()) {
              var seconds = YTX.timeToSeconds(m[1]);
              container.insertAdjacentHTML('beforeend',
                '<div class="ytx-transcript-line">' +
                '<span class="ytx-ts" data-time="' + seconds + '">[' + m[1] + ']</span>' +
                '<span>' + YTX.escapeHtml(m[2].trim()) + '</span></div>');
            } else if (seg) {
              container.insertAdjacentHTML('beforeend',
                '<div class="ytx-transcript-line"><span>' + YTX.escapeHtml(seg) + '</span></div>');
            }
          }
        }
        YTX._transcribeBuffer = '';
      }

      if (message.text) {
        if (!YTX.transcriptData) YTX.transcriptData = { full: '' };
        YTX.transcriptData.full += (YTX.transcriptData.full ? '\n' : '') + message.text;
      } else if (message.error && container) {
        container.insertAdjacentHTML('beforeend',
          '<div style="padding:4px 8px;font-size:11px;color:#b45309;background:#fef3c7;border-radius:4px;margin-bottom:8px">' +
          '转录失败: ' + YTX.escapeHtml(message.error) + '</div>');
      }
      return;
    }

    // 按前缀分发到对应功能模块
    if (!message.type) return;
    var parts = message.type.match(/^(.+?)_(CHUNK|DONE|ERROR)$/);
    if (!parts) return;

    var prefix = parts[1];
    var action = parts[2];
    var feature = prefixMap[prefix];
    if (!feature) return;

    // 过滤过期请求：message 带 requestId 但与 feature 当前请求不匹配（含 feature.requestId 为 null 的情况）则丢弃
    if (message.requestId && message.requestId !== feature.requestId) return;

    if (action === 'CHUNK' && feature.onChunk) {
      feature.onChunk(message.text);
    } else if (action === 'DONE' && feature.onDone) {
      feature.onDone();
    } else if (action === 'ERROR' && feature.onError) {
      feature.onError(message.error);
    }
  });

  // ── 启动 ─────────────────────────────────────────────
  init();
})();
