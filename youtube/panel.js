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

  var collapsePanelIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 9 3 3-3 3"/></svg>';
  var expandPanelIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m13 15-3-3 3-3"/></svg>';

  // ── 入口 ──────────────────────────────────────────────

  function init() {
    document.addEventListener('yt-navigate-finish', onNavigate);
    onNavigate();
  }

  // 重置全部字幕/转写在途状态，导航离开视频页或切视频时调用
  function resetTranscriptState() {
    // 先取消后清 ID：YTX.cancelRequest 不阻塞导航，旧流的后续消息
    // 仍会被下方的 requestId/videoId 过滤丢弃。
    var transcribeRequestId = YTX._transcribeRequestId;
    if (transcribeRequestId && typeof YTX.cancelRequest === 'function') {
      YTX.cancelRequest(transcribeRequestId);
    }
    YTX._transcriptGeneration = (YTX._transcriptGeneration || 0) + 1;
    YTX._cacheRestoreToken = (YTX._cacheRestoreToken || 0) + 1;
    YTX._generateAllToken = null;
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
    var restoreToken = YTX._cacheRestoreToken || 0;
    var transcriptGeneration = YTX._transcriptGeneration || 0;
    var panelAtStart = YTX.panel;
    var activityVersions = {};
    YTX.featureOrder.forEach(function (key) {
      var feature = YTX.features[key];
      activityVersions[key] = feature ? (feature._activityVersion || 0) : 0;
    });
    YTX.cache.load(videoId).then(function (record) {
      // 异步竞态防护：缓存读取期间用户可能已切到别的视频
      if (videoId !== YTX.currentVideoId || restoreToken !== (YTX._cacheRestoreToken || 0)) return;
      if (!record || !YTX.panel || YTX.panel !== panelAtStart) return;

      // 字幕
      if (record.transcript && record.transcript.full &&
          (YTX._transcriptGeneration || 0) === transcriptGeneration &&
          !YTX.transcriptData && !YTX._transcriptPromise && !YTX.isFetchingTranscript) {
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
        if ((s._activityVersion || 0) === activityVersions.summary && !s.isGenerating && !s.requestId && !s.text) {
          s.text = record.summary.text;
          s.renderFinal();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-summarize'));
        }
      }

      // 笔记
      if (record.html && record.html.text) {
        var h = YTX.features.html;
        if ((h._activityVersion || 0) === activityVersions.html && !h.isGenerating && !h.requestId && !h.text) {
          h.text = record.html.text;
          h.renderContent();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-html'));
        }
      }

      // 卡片
      if (record.cards && record.cards.data && record.cards.data.length > 0) {
        var c = YTX.features.cards;
        if ((c._activityVersion || 0) === activityVersions.cards && !c.isGenerating && !c.requestId && (!c.data || c.data.length === 0)) {
          c.data = record.cards.data;
          c.render();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-cards'));
        }
      }

      // 导图
      if (record.mindmap && record.mindmap.data) {
        var m = YTX.features.mindmap;
        if ((m._activityVersion || 0) === activityVersions.mindmap && !m.isGenerating && !m.requestId && !m.data && !m.rawText) {
          m.data = record.mindmap.data;
          m.render();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-mindmap'));
        }
      }

      // 词汇
      if (record.vocab && record.vocab.data && record.vocab.data.length > 0) {
        var v = YTX.features.vocab;
        if ((v._activityVersion || 0) === activityVersions.vocab && !v.isGenerating && !v.requestId && (!v.data || v.data.length === 0)) {
          v.data = record.vocab.data;
          v.render();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-vocab'));
        }
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
    panel.classList.toggle('ytx-panel-collapsed', YTX.panelCollapsed);
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
      '<button id="ytx-panel-launcher" type="button" title="显示 AAtools 面板" aria-label="显示 AAtools 面板" aria-expanded="false">' + expandPanelIcon + '</button>' +
      '<div id="ytx-tabs">' +
        '<div id="ytx-tab-list">' + tabsHtml + '</div>' +
        '<div id="ytx-actions">' + actionsHtml + '</div>' +
        '<button id="ytx-panel-hide" type="button" title="隐藏 AAtools 面板" aria-label="隐藏 AAtools 面板" aria-expanded="true">' + collapsePanelIcon + '</button>' +
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

    // 面板收起后保留原 DOM，确保生成中的流式消息仍能正常更新。
    panel.querySelector('#ytx-panel-hide').addEventListener('click', function () {
      setPanelCollapsed(true);
    });
    panel.querySelector('#ytx-panel-launcher').addEventListener('click', function () {
      setPanelCollapsed(false);
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
      var videoIdAtStart = YTX.currentVideoId;
      var modePromise = YTX.switchToVideoMode();
      var modeGeneration = YTX._transcriptGeneration || 0;
      modePromise.then(function () {
        if (YTX.currentVideoId !== videoIdAtStart || YTX.panel !== panel || (YTX._transcriptGeneration || 0) !== modeGeneration) return;
        // 切换成功后隐藏按钮
        if (btn) btn.style.display = 'none';
      }).catch(function (err) {
        if (YTX.currentVideoId !== videoIdAtStart || YTX.panel !== panel || (YTX._transcriptGeneration || 0) !== modeGeneration) return;
        if (btn) { btn.disabled = false; btn.textContent = '使用视频模式'; }
        var body = panel.querySelector('#ytx-transcript-body');
        if (body) YTX.renderError(body, err.message || '视频模式切换失败');
      });
    });

    // 绑定「清除缓存」按钮
    panel.querySelector('#ytx-clear-cache').addEventListener('click', function () {
      if (!YTX.currentVideoId) return;
      var videoId = YTX.currentVideoId;
      var panelAtStart = panel;
      var btn = panel.querySelector('#ytx-clear-cache');
      if (btn) { btn.disabled = true; btn.textContent = '清除中...'; }

      // 同时取消仍会写回该视频缓存的生成任务，并只重建这些在途模块的视图。
      YTX.featureOrder.forEach(function (key) {
        var feature = YTX.features[key];
        if (!feature || !(feature.requestId || feature.isGenerating || feature.isChatting)) return;
        if (feature.reset) feature.reset();
        var actions = feature.actionsId && panel.querySelector('#' + feature.actionsId);
        var content = feature.contentId && panel.querySelector('#' + feature.contentId);
        if (actions && feature.actionsHtml) actions.innerHTML = feature.actionsHtml();
        if (content && feature.contentHtml) content.innerHTML = feature.contentHtml();
        if (feature.bindEvents) feature.bindEvents(panel);
      });

      // 立即失效字幕/转录与延迟缓存恢复，避免清除完成后旧结果再次写回。
      resetTranscriptState();
      var clearGeneration = YTX._transcriptGeneration || 0;
      ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-cards', '#ytx-generate-mindmap', '#ytx-generate-vocab'].forEach(function (id) {
        var generationBtn = panel.querySelector(id);
        if (generationBtn) generationBtn.disabled = false;
      });
      var allBtn = panel.querySelector('#ytx-generate-all');
      if (allBtn) allBtn.innerHTML = YTX.icons.zap;
      var banner = panel.querySelector('#ytx-video-mode-banner');
      if (banner) banner.style.display = 'none';
      var videoBtn = panel.querySelector('#ytx-use-video-mode');
      if (videoBtn) { videoBtn.style.display = ''; videoBtn.disabled = false; videoBtn.textContent = '使用视频模式'; }
      YTX.cache.remove(videoId).then(function (removed) {
        if (YTX.currentVideoId !== videoId || YTX.panel !== panelAtStart) return;
        var canUpdateTranscriptBody = (YTX._transcriptGeneration || 0) === clearGeneration &&
          !YTX.transcriptData && !YTX._transcriptPromise && !YTX.isFetchingTranscript;
        if (!removed) {
          var errorBody = panel.querySelector('#ytx-transcript-body');
          if (errorBody && canUpdateTranscriptBody) YTX.renderError(errorBody, '缓存清除失败，请重试');
          if (btn) { btn.disabled = false; btn.textContent = '清除缓存'; }
          return;
        }
        var body = panel.querySelector('#ytx-transcript-body');
        if (body && canUpdateTranscriptBody) body.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#15803d;background:#f0fdf4;border-radius:6px">缓存已清除，下次操作将重新获取字幕</div>';
        if (btn) {
          btn.disabled = false;
          btn.textContent = '已清除';
          setTimeout(function () {
            if (YTX.panel === panelAtStart && btn.textContent === '已清除') btn.textContent = '清除缓存';
          }, 1500);
        }
      });
    });

    // 阻止面板内滚轮事件冒泡到页面
    panel.addEventListener('wheel', function (e) {
      e.stopPropagation();
    });

    // 面板级时间戳点击委托
    setupTimestampClickHandler(panel);

    // 收起状态使用 YouTube 原生布局，展开时才注入分栏条。
    if (!YTX.panelCollapsed) injectResizer();
  }

  function removePanel() {
    if (YTX.panel) { YTX.panel.remove(); YTX.panel = null; }
  }

  function setPanelCollapsed(collapsed) {
    if (!YTX.panel || YTX.panelCollapsed === collapsed) return;
    YTX.panelCollapsed = collapsed;
    YTX.panel.classList.toggle('ytx-panel-collapsed', collapsed);

    if (collapsed) {
      removeResizer();
      var launcher = YTX.panel.querySelector('#ytx-panel-launcher');
      if (launcher) launcher.focus({ preventScroll: true });
      return;
    }

    injectResizer();
    switchTab(YTX.activeTab);
    var activeTab = YTX.panel.querySelector('.ytx-tab.active');
    if (activeTab) activeTab.focus({ preventScroll: true });
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
    columns.classList.add('ytx-columns-layout');

    // 默认分栏：视频占 3/5，AAtools 占 2/5；收起再展开时保留拖拽比例。
    var splitRatio = YTX.resizerSplitRatio;

    function resetColumnWidths() {
      primary.style.width = '';
      primary.style.maxWidth = '';
      primary.style.minWidth = '';
      primary.style.flex = '';

      secondary.style.width = '';
      secondary.style.maxWidth = '';
      secondary.style.minWidth = '';
      secondary.style.flex = '';
    }

    function applyWatchModeGutter(watchFlexy) {
      var leftGutter = 'clamp(24px, 2.5vw, 40px)';
      var rightGutter = 'clamp(12px, 1.5vw, 24px)';
      columns.style.boxSizing = 'border-box';
      if (isTheaterMode(watchFlexy)) {
        columns.style.boxSizing = '';
        columns.style.width = '';
        columns.style.marginLeft = '';
        columns.style.marginRight = '';
        columns.style.paddingLeft = '';
        columns.style.paddingRight = '';
        return;
      }
      columns.style.width = 'calc(100% - ' + leftGutter + ' - ' + rightGutter + ')';
      columns.style.marginLeft = leftGutter;
      columns.style.marginRight = rightGutter;
      columns.style.paddingLeft = '';
      columns.style.paddingRight = '';
    }

    function getColumnsMetrics() {
      var rect = columns.getBoundingClientRect();
      var styles = window.getComputedStyle(columns);
      var paddingLeft = parseFloat(styles.paddingLeft) || 0;
      var paddingRight = parseFloat(styles.paddingRight) || 0;
      return {
        rect: rect,
        paddingLeft: paddingLeft,
        contentWidth: Math.max(0, rect.width - paddingLeft - paddingRight),
      };
    }

    function getResizerWidth() {
      return resizer.getBoundingClientRect().width || 32;
    }

    function getLayoutLimits(totalWidth, resizerWidth) {
      var minSecondary = Math.min(440, Math.max(320, totalWidth * 0.34));
      var maxPrimary = totalWidth - minSecondary - resizerWidth;
      var minPrimary = Math.min(320, Math.max(240, totalWidth * 0.16));
      if (maxPrimary < minPrimary) minPrimary = Math.max(0, maxPrimary);
      return {
        minPrimary: minPrimary,
        maxPrimary: Math.max(0, maxPrimary),
      };
    }

    function clampPrimaryWidth(primaryWidth, totalWidth, resizerWidth) {
      var limits = getLayoutLimits(totalWidth, resizerWidth);
      return Math.max(limits.minPrimary, Math.min(primaryWidth, limits.maxPrimary));
    }

    function applyColumns() {
      var watchFlexy = document.querySelector('ytd-watch-flexy');
      if (isTheaterMode(watchFlexy)) {
        resizer.style.display = 'none';
        columns.style.display = '';
        columns.style.flexWrap = '';
        applyWatchModeGutter(watchFlexy);
        resetColumnWidths();
        return;
      }

      resizer.style.display = '';
      columns.style.display = 'flex';
      columns.style.flexWrap = 'nowrap';
      applyWatchModeGutter(watchFlexy);
      var metrics = getColumnsMetrics();
      var totalWidth = metrics.contentWidth;
      if (!totalWidth) return;
      var resizerWidth = getResizerWidth();
      var primaryWidth = Math.round((totalWidth - resizerWidth) * splitRatio);
      primaryWidth = clampPrimaryWidth(primaryWidth, totalWidth, resizerWidth);
      var secondaryWidth = totalWidth - primaryWidth - resizerWidth;

      primary.style.width = primaryWidth + 'px';
      primary.style.maxWidth = 'none';
      primary.style.minWidth = '0';
      primary.style.flex = 'none';

      secondary.style.width = secondaryWidth + 'px';
      secondary.style.maxWidth = 'none';
      secondary.style.minWidth = '0';
      secondary.style.flex = 'none';

      scheduleVideoFit(primary);
    }

    applyColumns();
    forceVideoResize(primary);

    // window resize 只重算列宽，不调 forceVideoResize，避免循环触发
    YTX._resizerOnWindowResize = function () {
      applyColumns();
    };
    window.addEventListener('resize', YTX._resizerOnWindowResize);

    var watchFlexyForObserver = document.querySelector('ytd-watch-flexy');
    if (watchFlexyForObserver) {
      YTX._resizerWatchFlexyObserver = new MutationObserver(function () {
        applyColumns();
        forceVideoResize(primary);
      });
      YTX._resizerWatchFlexyObserver.observe(watchFlexyForObserver, {
        attributes: true,
        attributeFilter: ['theater', 'fullscreen'],
      });
    }

    if (window.ResizeObserver) {
      YTX._resizerResizeObserver = new ResizeObserver(function () {
        if (!isTheaterMode(document.querySelector('ytd-watch-flexy'))) scheduleVideoFit(primary);
      });
      YTX._resizerResizeObserver.observe(primary);
    }

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
      var metrics = getColumnsMetrics();
      var totalWidth = metrics.contentWidth;
      if (!totalWidth) return;
      var resizerWidth = getResizerWidth();
      var primaryWidth = e.clientX - metrics.rect.left - metrics.paddingLeft;
      primaryWidth = clampPrimaryWidth(primaryWidth, totalWidth, resizerWidth);
      splitRatio = primaryWidth / (totalWidth - resizerWidth);
      YTX.resizerSplitRatio = splitRatio;

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

    if (!primary) return;
    if (isTheaterMode(watchFlexy)) {
      resetForcedPlayerSize(primary);
      window.dispatchEvent(new Event('resize'));
      return;
    }

    var playerContainer = primary.querySelector('#player-container-inner');
    if (playerContainer) {
      playerContainer.style.maxWidth = '100%';
    }
    var moviePlayer = document.querySelector('#movie_player');
    if (moviePlayer) {
      moviePlayer.style.width = '';
      moviePlayer.style.height = '';
    }
    window.dispatchEvent(new Event('resize'));
    scheduleVideoFit(primary);
  }

  function isTheaterMode(watchFlexy) {
    return !!watchFlexy && (watchFlexy.hasAttribute('theater') || watchFlexy.hasAttribute('fullscreen'));
  }

  function resetForcedPlayerSize(primary) {
    var playerContainer = primary && primary.querySelector('#player-container-inner');
    if (playerContainer) playerContainer.style.maxWidth = '';

    var moviePlayer = document.querySelector('#movie_player');
    if (moviePlayer) {
      moviePlayer.style.width = '';
      moviePlayer.style.height = '';
      var videoContainer = moviePlayer.querySelector('.html5-video-container');
      if (videoContainer) videoContainer.classList.remove('ytx-video-fit-container');
      var video = moviePlayer.querySelector('video.html5-main-video');
      if (video) {
        video.classList.remove('ytx-video-fit');
        video.style.width = '';
        video.style.height = '';
        video.style.left = '';
        video.style.top = '';
        video.style.right = '';
        video.style.bottom = '';
        video.style.transform = '';
        video.style.removeProperty('--ytx-video-fit-width');
        video.style.removeProperty('--ytx-video-fit-height');
        video.style.removeProperty('--ytx-video-fit-left');
        video.style.removeProperty('--ytx-video-fit-top');
      }
    }
  }

  function scheduleVideoFit(primary) {
    fitMainVideo(primary);
    requestAnimationFrame(function () {
      fitMainVideo(primary);
      requestAnimationFrame(function () { fitMainVideo(primary); });
    });
  }

  function fitMainVideo(primary) {
    var watchFlexy = document.querySelector('ytd-watch-flexy');
    if (!primary || isTheaterMode(watchFlexy)) return;

    var moviePlayer = document.querySelector('#movie_player');
    var video = moviePlayer && moviePlayer.querySelector('video.html5-main-video');
    var videoContainer = moviePlayer && moviePlayer.querySelector('.html5-video-container');
    if (!moviePlayer || !video) return;
    if (!video.videoWidth || !video.videoHeight) {
      if (!video.dataset.ytxFitMetadataBound) {
        video.dataset.ytxFitMetadataBound = '1';
        video.addEventListener('loadedmetadata', function () { scheduleVideoFit(primary); }, { once: true });
      }
      return;
    }

    var playerRect = moviePlayer.getBoundingClientRect();
    var playerWidth = Math.round(playerRect.width);
    var playerHeight = Math.round(playerRect.height);
    if (!playerWidth || !playerHeight) return;

    var videoRatio = video.videoWidth / video.videoHeight;
    var playerRatio = playerWidth / playerHeight;
    var fitWidth;
    var fitHeight;
    var left;
    var top;

    if (playerRatio > videoRatio) {
      fitHeight = playerHeight;
      fitWidth = Math.round(fitHeight * videoRatio);
      left = Math.round((playerWidth - fitWidth) / 2);
      top = 0;
    } else {
      fitWidth = playerWidth;
      fitHeight = Math.round(fitWidth / videoRatio);
      left = 0;
      top = Math.round((playerHeight - fitHeight) / 2);
    }

    if (videoContainer) videoContainer.classList.add('ytx-video-fit-container');
    video.classList.add('ytx-video-fit');
    video.style.setProperty('--ytx-video-fit-width', fitWidth + 'px');
    video.style.setProperty('--ytx-video-fit-height', fitHeight + 'px');
    video.style.setProperty('--ytx-video-fit-left', left + 'px');
    video.style.setProperty('--ytx-video-fit-top', top + 'px');
  }

  function removeResizer() {
    // 清理 document 级事件监听器
    if (YTX._resizerOnMove) { document.removeEventListener('mousemove', YTX._resizerOnMove); YTX._resizerOnMove = null; }
    if (YTX._resizerOnUp) { document.removeEventListener('mouseup', YTX._resizerOnUp); YTX._resizerOnUp = null; }
    if (YTX._resizerOnWindowResize) { window.removeEventListener('resize', YTX._resizerOnWindowResize); YTX._resizerOnWindowResize = null; }
    if (YTX._resizerWatchFlexyObserver) { YTX._resizerWatchFlexyObserver.disconnect(); YTX._resizerWatchFlexyObserver = null; }
    if (YTX._resizerResizeObserver) { YTX._resizerResizeObserver.disconnect(); YTX._resizerResizeObserver = null; }

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
    if (columns) {
      columns.style.display = '';
      columns.style.flexWrap = '';
      columns.style.boxSizing = '';
      columns.style.width = '';
      columns.style.marginLeft = '';
      columns.style.marginRight = '';
      columns.style.paddingLeft = '';
      columns.style.paddingRight = '';
      columns.classList.remove('ytx-columns-layout');
    }
    if (primary) { primary.style.width = ''; primary.style.maxWidth = ''; primary.style.minWidth = ''; primary.style.flex = ''; }
    if (secondary) { secondary.style.width = ''; secondary.style.maxWidth = ''; secondary.style.minWidth = ''; secondary.style.flex = ''; }

    resetForcedPlayerSize(primary);
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
      // SEGMENT 是转录的终态消息（text 或 error）。先清理已匹配的 ID，
      // 即使面板 DOM 已被移除，也不会在后续 reset 时误取消已完成任务。
      var terminalRequestId = message.requestId || YTX._transcribeRequestId;
      if (!terminalRequestId || terminalRequestId === YTX._transcribeRequestId) {
        YTX._transcribeRequestId = null;
        YTX._transcribeVideoId = null;
      }
      YTX._transcribeReceiving = false;
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
  chrome.storage.sync.get(['youtubePanelDefaultCollapsed'], function (data) {
    if (!chrome.runtime.lastError && data) {
      YTX.panelCollapsed = data.youtubePanelDefaultCollapsed !== false;
    }
    init();
  });
})();
