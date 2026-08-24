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

  var navigationToken = 0;
  var containerWaitTimer = null;
  var PANEL_HOST_ID = 'ytx-panel-host';

  function cleanupPanelHostProtection() {
    var mount = YTX._panelMount;
    if (!mount) return;
    if (mount.healTimer) clearTimeout(mount.healTimer);
    if (mount.attributeObserver) mount.attributeObserver.disconnect();
    if (mount.treeObserver) mount.treeObserver.disconnect();
    if (mount.themeObserver) mount.themeObserver.disconnect();
    YTX._panelMount = null;
  }

  function hardenPanelHost(mount) {
    var host = mount && mount.host;
    if (!host) return;
    if (host.id !== PANEL_HOST_ID) host.id = PANEL_HOST_ID;
    if (host.className) host.className = '';
    ['hidden', 'inert', 'aria-hidden'].forEach(function (name) {
      if (host.hasAttribute(name)) host.removeAttribute(name);
    });
    if (!mount.safeStyle || host.getAttribute('style') !== mount.safeStyle) {
      host.removeAttribute('style');
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('display', 'contents', 'important');
      mount.safeStyle = host.getAttribute('style');
    }
  }

  function protectPanelHost(host, scope, videoId, token, initialContainer) {
    cleanupPanelHostProtection();
    var mount = {
      host: host,
      scope: scope,
      videoId: videoId,
      token: token,
      container: initialContainer,
      safeStyle: '',
      healTimer: null,
    };
    YTX._panelMount = mount;

    function isCurrent() {
      return YTX._panelMount === mount && featureEnabled &&
        mount.token === navigationToken && YTX.currentVideoId === mount.videoId &&
        getVideoId() === mount.videoId;
    }

    function syncTheme() {
      var dark = document.documentElement.hasAttribute('dark');
      if (scope) scope.toggleAttribute('dark', dark);
      var chat = YTX.features.chat;
      if (chat && chat.postInputState) chat.postInputState({ dark: dark });
    }

    function heal() {
      mount.healTimer = null;
      if (!isCurrent()) {
        if (YTX._panelMount === mount) cleanupPanelHostProtection();
        return;
      }
      hardenPanelHost(mount);
      syncTheme();
      var container = getPanelContainer();
      if (!container) return;
      mount.container = container;
      if (host.parentNode !== container) {
        if (isShortsPage()) container.appendChild(host);
        else container.prepend(host);
      }
    }

    function queueHeal() {
      if (mount.healTimer || !isCurrent()) return;
      mount.healTimer = setTimeout(heal, 0);
    }

    hardenPanelHost(mount);
    syncTheme();
    mount.attributeObserver = new MutationObserver(queueHeal);
    mount.attributeObserver.observe(host, {
      attributes: true,
      attributeFilter: ['id', 'class', 'style', 'hidden', 'inert', 'aria-hidden'],
    });
    mount.treeObserver = new MutationObserver(function () {
      if (!host.isConnected || !mount.container || !mount.container.isConnected || host.parentNode !== mount.container) {
        queueHeal();
      }
    });
    mount.treeObserver.observe(document.documentElement, { childList: true, subtree: true });
    mount.themeObserver = new MutationObserver(syncTheme);
    mount.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
  }

  // ── 入口 ──────────────────────────────────────────────

  function init() {
    document.addEventListener('yt-navigate-finish', onNavigate);
    // Chrome may freeze this document in the back/forward cache before an
    // asynchronous provider request reaches its terminal message. The frozen
    // content script cannot receive that message, so proactively invalidate
    // every request on pagehide and rebuild from current page state when the
    // same document is restored.
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    onNavigate();
  }

  // 重置全部字幕/转写在途状态，导航离开视频页或切视频时调用
  function resetTranscriptState(reason) {
    // 先取消后清 ID：YTX.cancelRequest 不阻塞导航，旧流的后续消息
    // 仍会被下方的 requestId/videoId 过滤丢弃。
    var transcribeRequestId = YTX._transcribeRequestId;
    if (transcribeRequestId && typeof YTX.cancelRequest === 'function') {
      YTX.cancelRequest(transcribeRequestId);
    }
    if (transcribeRequestId && typeof YTX.settleTranscribeDeferred === 'function') {
      YTX.settleTranscribeDeferred(transcribeRequestId, new Error(reason || '视频已切换'));
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
    YTX._transcribeRejectedRequestId = null;
    resetTranscribeStreamBuffers();
    YTX._transcribeReceiving = false;
    if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
    YTX.isFetchingTranscript = false;
    if (typeof YTX.syncTranscriptUi === 'function') YTX.syncTranscriptUi();
  }

  function resetFeatureRequests(reason) {
    resetTranscriptState(reason);
    YTX.featureOrder.forEach(function (key) {
      var feature = YTX.features[key];
      if (feature && feature.reset) feature.reset();
    });
  }

  function onPageHide() {
    navigationToken++;
    cancelContainerWait();
    resetFeatureRequests('页面已离开');
  }

  function onPageShow(event) {
    if (!event || event.persisted !== true) return;
    // Do not take the same-video fast path: its DOM and disabled controls are
    // a snapshot from before pagehide, while all matching requests were
    // deliberately cancelled above.
    navigationToken++;
    cancelContainerWait();
    YTX.currentVideoId = null;
    removePanel();
    removeResizer();
    onNavigate();
  }

  // 功能开关（设置页「功能开关」卡片）；关闭时走 !videoId 清理路径拆面板
  // 设置读取失败时 fail-closed，避免用户明确关闭功能后因存储异常重新注入。
  var featureEnabled = false;

  function onNavigate() {
    navigationToken++;
    cancelContainerWait();
    var token = navigationToken;
    var videoId = featureEnabled ? getVideoId() : null;
    if (!videoId) {
      // 离开视频页（首页/搜索/频道页等）：清状态 + 重置功能模块，
      // 否则旧 in-flight 转写会让下一个视频被错误拦截
      resetFeatureRequests('已离开视频页面');
      YTX.currentVideoId = null;
      removePanel();
      removeResizer();
      return;
    }
    if (videoId === YTX.currentVideoId && YTX.panel && YTX.panel.isConnected) {
      if (YTX._panelMount) YTX._panelMount.token = token;
      return;
    }
    removePanel();
    removeResizer();
    YTX.currentVideoId = videoId;
    resetTranscriptState('视频已切换');
    YTX.activeTab = 'summary';

    // 重置所有功能模块状态
    YTX.featureOrder.forEach(function (key) {
      var f = YTX.features[key];
      if (f && f.reset) f.reset();
    });

    waitForContainer(videoId, token, function () {
      injectPanel(videoId, token);
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
      if (record.transcript != null) {
        var canRestoreTranscript = (YTX._transcriptGeneration || 0) === transcriptGeneration &&
          !YTX.transcriptData && !YTX._transcriptPromise && !YTX.isFetchingTranscript;
        try {
          var cachedTranscript = YTX.normalizeCachedTranscript(record.transcript);
          var cachedVideoMode = record.transcript && record.transcript.videoMode === true || cachedTranscript.segments == null;
          var transcriptNeedsRewrite = !record.transcript ||
            record.transcript.full !== cachedTranscript.full ||
            (Array.isArray(record.transcript.segments) && record.transcript.segments.length !== cachedTranscript.segments.length);
          if (transcriptNeedsRewrite) {
            YTX.cache.save(videoId, 'transcript', {
              segments: cachedTranscript.segments,
              full: cachedTranscript.full,
              truncated: cachedTranscript.truncated,
              videoMode: cachedVideoMode,
            });
          }
          if (canRestoreTranscript) {
            YTX.transcriptData = cachedTranscript;
            YTX.setVideoMode(cachedVideoMode);
            YTX.renderTranscript();
          }
        } catch (err) {
          YTX.cache.save(videoId, 'transcript', null);
          if (canRestoreTranscript) {
            YTX.renderError(YTX.panel.querySelector('#ytx-transcript-body'), '缓存字幕无效，已清除：' + err.message);
          }
        }
      }

      // 总结
      if (record.summary != null) {
        var s = YTX.features.summary;
        var canRestoreSummary = (s._activityVersion || 0) === activityVersions.summary && !s.isGenerating && !s.requestId && !s.text;
        var cachedSummaryText = record.summary && typeof record.summary === 'object' && typeof record.summary.text === 'string'
          ? record.summary.text
          : '';
        var cachedSummaryMetrics = cachedSummaryText.trim() ? YTX.markdownMetrics(cachedSummaryText) : null;
        if (!cachedSummaryMetrics) {
          YTX.cache.save(videoId, 'summary', null);
          if (canRestoreSummary) {
            YTX.parseError(YTX.panel.querySelector('#ytx-content'), '缓存总结', new Error('缓存内容类型无效或过长'));
            YTX.btnPrimary(YTX.panel.querySelector('#ytx-summarize'));
          }
        } else if (canRestoreSummary) {
          s.text = cachedSummaryText;
          s._newlineCount = cachedSummaryMetrics.newlines;
          s.renderFinal();
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-summarize'));
        }
      }

      // 笔记
      if (record.html != null) {
        var h = YTX.features.html;
        var canRestoreHtml = (h._activityVersion || 0) === activityVersions.html && !h.isGenerating && !h.requestId && !h.text;
        var cachedHtmlText = record.html && typeof record.html === 'object' && typeof record.html.text === 'string'
          ? record.html.text
          : '';
        var cachedSafeHtml = cachedHtmlText.length <= YTX.AI_OUTPUT_MAX_CHARS
          ? YTX.HtmlNotes.sanitizeOutput(cachedHtmlText)
          : '';
        if (!cachedSafeHtml) {
          // 无论用户是否已开始新请求，都先驱逐毒缓存；仅在仍空闲时显示缓存错误。
          YTX.cache.save(videoId, 'html', null);
          if (canRestoreHtml) {
            YTX.parseError(YTX.panel.querySelector('#ytx-content-html'), '缓存笔记', new Error('缓存中的笔记格式无效'));
            YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-html'));
          }
        } else if (canRestoreHtml) {
          h.text = cachedHtmlText;
          h.renderContent(cachedSafeHtml);
          YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-html'));
        }
      }

      // 导图
      if (record.mindmap != null) {
        var m = YTX.features.mindmap;
        var canRestoreMindmap = (m._activityVersion || 0) === activityVersions.mindmap && !m.isGenerating && !m.requestId && !m.data && !m.rawText;
        try {
          if (!record.mindmap || typeof record.mindmap !== 'object' || !record.mindmap.data) {
            throw new Error('缓存缺少导图数据');
          }
          var normalizedMindmap = YTX.normalizeMindmapData(record.mindmap.data);
          if (canRestoreMindmap) {
            m._completionWarning = '';
            m.data = normalizedMindmap;
            m.render();
            YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-mindmap'));
          }
        } catch (err) {
          YTX.cache.save(videoId, 'mindmap', null);
          if (canRestoreMindmap) {
            m.data = null;
            if (m.cleanupZoomPan) m.cleanupZoomPan();
            YTX.parseError(YTX.panel.querySelector('#ytx-content-mindmap'), '缓存导图', err);
            YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-mindmap'));
          }
        }
      }
    });
  }

  function getVideoId() {
    var url = new URL(location.href);
    var shortsMatch = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    if (shortsMatch) return shortsMatch[1];
    if (url.pathname !== '/watch') return null;
    var watchId = url.searchParams.get('v');
    return watchId && /^[A-Za-z0-9_-]{11}$/.test(watchId) ? watchId : null;
  }

  function isShortsPage() {
    return /^\/shorts\//.test(location.pathname);
  }

  function getPanelContainer() {
    if (isShortsPage()) {
      return document.querySelector('ytd-shorts, ytd-reel-video-renderer[is-active]') ? document.body : null;
    }
    return document.querySelector('#secondary, #secondary-inner');
  }

  // ── 等待右侧栏加载 ────────────────────────────────────

  function cancelContainerWait() {
    if (containerWaitTimer) {
      clearTimeout(containerWaitTimer);
      containerWaitTimer = null;
    }
  }

  function waitForContainer(expectedVideoId, token, callback, retries) {
    if (token !== navigationToken || !featureEnabled || expectedVideoId !== YTX.currentVideoId) return;
    retries = retries !== undefined ? retries : 30;
    var container = getPanelContainer();
    if (container) {
      containerWaitTimer = null;
      callback();
    } else if (retries > 0) {
      containerWaitTimer = setTimeout(function () {
        containerWaitTimer = null;
        waitForContainer(expectedVideoId, token, callback, retries - 1);
      }, 500);
    }
  }

  // ── 面板注入 ─────────────────────────────────────────

  function injectPanel(videoId, token) {
    removePanel();
    var container = getPanelContainer();
    if (!container) return;

    var host = document.createElement('div');
    host.id = PANEL_HOST_ID;
    var shadow = host.attachShadow({ mode: 'closed' });
    // 阻止面板操作继续冒泡给宿主页的普通监听器。capture 阶段早于此边界，
    // 因此敏感 Chat 输入另放在 extension-origin iframe 中，不能只依赖这里。
    [
      'click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'mousemove',
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
      'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change',
      'compositionstart', 'compositionupdate', 'compositionend',
      'paste', 'copy', 'cut', 'wheel', 'contextmenu',
      'focusin', 'focusout', 'dragstart', 'drag', 'dragend',
      'dragenter', 'dragleave', 'dragover', 'drop',
      'touchstart', 'touchmove', 'touchend', 'touchcancel'
    ].forEach(function (type) {
      shadow.addEventListener(type, function (event) { event.stopPropagation(); });
    });
    var scope = document.createElement('div');
    scope.style.setProperty('display', 'contents', 'important');
    var fallbackStyle = document.createElement('style');
    fallbackStyle.textContent =
      '#ytx-panel{display:none!important}' +
      '#ytx-style-error{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'margin:12px;padding:12px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:8px}' +
      '#ytx-style-error[hidden]{display:none!important}' +
      '#ytx-style-retry{margin-left:8px;padding:4px 8px;border:1px solid #fca5a5;border-radius:6px;background:#fff;cursor:pointer}';
    var stylesheet = document.createElement('style');
    var styleError = document.createElement('div');
    styleError.id = 'ytx-style-error';
    styleError.hidden = true;
    styleError.appendChild(document.createTextNode('AAtools 面板样式加载失败，内容已安全隐藏。'));
    var styleRetry = document.createElement('button');
    styleRetry.id = 'ytx-style-retry';
    styleRetry.type = 'button';
    styleRetry.textContent = '重试';
    styleError.appendChild(styleRetry);
    var panel = document.createElement('div');
    panel.id = 'ytx-panel';
    panel.classList.toggle('ytx-panel-collapsed', YTX.panelCollapsed);
    scope.appendChild(fallbackStyle);
    scope.appendChild(stylesheet);
    scope.appendChild(styleError);
    scope.appendChild(panel);
    shadow.appendChild(scope);
    // 由 content-script fetch 扩展内 CSS，再以内联 style 注入 ShadowRoot，
    // 避免宿主页 CSP/外部 link 加载时序让面板永久卡在未样式化状态。
    function loadShadowStyles() {
      styleError.hidden = true;
      fetch(chrome.runtime.getURL('youtube/content.css'), {
        credentials: 'omit',
        cache: 'force-cache',
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      }).then(function (css) {
        if (typeof css !== 'string' || !css || css.length > 500000) throw new Error('样式内容无效');
        if (YTX.panel !== panel || YTX.panelHost !== host) return;
        stylesheet.textContent = css;
        fallbackStyle.remove();
        styleError.hidden = true;
      }).catch(function () {
        if (YTX.panel === panel && YTX.panelHost === host) styleError.hidden = false;
      });
    }
    styleRetry.addEventListener('click', function (event) {
      if (!YTX.isTrustedEvent(event)) return;
      loadShadowStyles();
    });
    // 失败时保留 fallback：敏感文本绝不以无样式状态短暂暴露。
    YTX.panel = panel;
    YTX.panelHost = host;
    loadShadowStyles();

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

    if (isShortsPage()) {
      panel.classList.add('ytx-panel-shorts');
      container.appendChild(host);
    } else {
      container.prepend(host);
    }
    protectPanelHost(host, scope, videoId, token, container);

    // 绑定各模块事件
    YTX.featureOrder.forEach(function (key) {
      var f = YTX.features[key];
      if (f && f.bindEvents) f.bindEvents(panel);
    });

    // 绑定 tab 切换
    panel.querySelectorAll('.ytx-tab').forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        if (!YTX.isTrustedEvent(e)) return;
        switchTab(tab.dataset.tab);
      });
    });

    // 面板收起后保留原 DOM，确保生成中的流式消息仍能正常更新。
    panel.querySelector('#ytx-panel-hide').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      setPanelCollapsed(true);
    });
    panel.querySelector('#ytx-panel-launcher').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      setPanelCollapsed(false);
    });

    // 绑定字幕折叠
    panel.querySelector('#ytx-transcript-toggle').addEventListener('click', toggleTranscript);

    // 绑定视频模式提示条关闭
    panel.querySelector('#ytx-video-mode-close').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      var banner = panel.querySelector('#ytx-video-mode-banner');
      if (banner) banner.style.display = 'none';
    });

    // 绑定「使用视频模式」按钮
    panel.querySelector('#ytx-use-video-mode').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      var videoIdAtStart = YTX.currentVideoId;
      var modePromise = YTX.switchToVideoMode();
      var modeGeneration = YTX._transcriptGeneration || 0;
      modePromise.then(function () {
        if (YTX.currentVideoId !== videoIdAtStart || YTX.panel !== panel || (YTX._transcriptGeneration || 0) !== modeGeneration) return;
        YTX.syncTranscriptUi();
      }).catch(function (err) {
        if (YTX.currentVideoId !== videoIdAtStart || YTX.panel !== panel || (YTX._transcriptGeneration || 0) !== modeGeneration) return;
        YTX.syncTranscriptUi();
        var body = panel.querySelector('#ytx-transcript-body');
        if (body && YTX.transcriptData) {
          // switchToVideoMode 已恢复旧字幕；保留它，并在顶部给出非破坏性错误提示。
          YTX.renderTranscript();
          var notice = document.createElement('div');
          notice.className = 'ytx-error';
          notice.textContent = '视频模式切换失败：' + (err.message || '未知错误');
          body.prepend(notice);
        } else if (body) {
          YTX.renderError(body, err.message || '视频模式切换失败');
        }
      });
    });

    // 绑定「清除缓存」按钮
    panel.querySelector('#ytx-clear-cache').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
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
      ['#ytx-generate-all', '#ytx-summarize', '#ytx-generate-html', '#ytx-generate-mindmap'].forEach(function (id) {
        var generationBtn = panel.querySelector(id);
        if (generationBtn) generationBtn.disabled = false;
      });
      var allBtn = panel.querySelector('#ytx-generate-all');
      if (allBtn) allBtn.innerHTML = YTX.icons.zap;
      var banner = panel.querySelector('#ytx-video-mode-banner');
      if (banner) banner.style.display = 'none';
      YTX.syncTranscriptUi();
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
      if (!YTX.isTrustedEvent(e)) return;
      e.stopPropagation();
    });

    // 面板级时间戳点击委托
    setupTimestampClickHandler(panel);

    YTX.syncTranscriptUi();

    // 收起状态使用 YouTube 原生布局，展开时才注入分栏条。
    if (!YTX.panelCollapsed && !isShortsPage()) injectResizer();
  }

  function removePanel() {
    cleanupPanelHostProtection();
    if (YTX.panelHost) { YTX.panelHost.remove(); YTX.panelHost = null; }
    else if (YTX.panel) YTX.panel.remove();
    YTX.panel = null;
    var strayHost = document.getElementById(PANEL_HOST_ID);
    if (strayHost) strayHost.remove();
    // 兼容清理旧版仍直接挂在 light DOM 的面板。
    var stray = document.getElementById('ytx-panel');
    if (stray) stray.remove();
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

    if (!isShortsPage()) injectResizer();
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
      var chat = YTX.features.chat;
      setTimeout(function () {
        if (chat && chat.postInputState) chat.postInputState({ focus: true });
      }, 100);
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
      var rawParts = raw.split(/(?=\[\d+:\d+(?::\d+)?\])/, YTX.TRANSCRIPT_MAX_SEGMENTS + 1);
      var renderSegmentTruncated = rawParts.length > YTX.TRANSCRIPT_MAX_SEGMENTS;
      var parts = rawParts.slice(0, YTX.TRANSCRIPT_MAX_SEGMENTS).filter(function (s) { return s.trim(); });
      var videoModeWarn = '<div class="ytx-warning" style="padding:6px 12px;font-size:11px;color:#7c3aed;background:#ede9fe;border-radius:6px;margin-bottom:6px">以下为 Gemini 视频模式获取的内容</div>';
      if (YTX.transcriptData.truncated) {
        videoModeWarn += '<div class="ytx-warning" style="padding:6px 12px;font-size:11px;color:#b45309;background:#fef3c7;border-radius:6px;margin-bottom:6px">转录较长，送交 AI 的内容已截断至前 ' + Math.round(YTX.TRANSCRIPT_MAX_CHARS / 1000) + 'k 字符</div>';
      }
      if (renderSegmentTruncated) {
        videoModeWarn += '<div class="ytx-warning" style="padding:6px 12px;font-size:11px;color:#b45309;background:#fef3c7;border-radius:6px;margin-bottom:6px">转录分段过多，仅显示前 ' + YTX.TRANSCRIPT_MAX_SEGMENTS + ' 段</div>';
      }
      body.innerHTML =
        videoModeWarn +
        parts.map(function (part) {
          var seg = part.trim();
          var m = seg.match(/^\[(\d+:\d+(?::\d+)?)\]\s*(.*)/);
          if (m && m[2].trim()) {
            var seconds = YTX.timeToSeconds(m[1]);
            if (!isFinite(seconds)) {
              return '<div class="ytx-transcript-line"><span>' + YTX.escapeHtml(seg) + '</span></div>';
            }
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

  function toggleTranscript(e) {
    if (!YTX.isTrustedEvent(e)) return;
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
      if (!YTX.isTrustedEvent(e)) return;
      var ts = e.target.closest('.ytx-timestamp, .ytx-ts');
      if (!ts) return;
      e.preventDefault();
      e.stopPropagation();
      var time = parseInt(ts.dataset.time, 10);
      if (isNaN(time)) return;
      var video = YTX.getVideoElement();
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
      if (!YTX.isTrustedEvent(e)) return;
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
      if (!YTX.isTrustedEvent(e)) return;
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

    YTX._resizerOnUp = function (e) {
      if (!YTX.isTrustedEvent(e)) return;
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
    clearVideoFitMetadataListener();
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

  function cancelScheduledVideoFit() {
    if (!YTX._videoFitRafs) return;
    YTX._videoFitRafs.forEach(function (id) { cancelAnimationFrame(id); });
    YTX._videoFitRafs = [];
  }

  function clearVideoFitMetadataListener() {
    var video = YTX._videoFitMetadataVideo;
    var handler = YTX._videoFitMetadataHandler;
    if (video && handler) video.removeEventListener('loadedmetadata', handler);
    if (video) delete video.dataset.ytxFitMetadataBound;
    YTX._videoFitMetadataVideo = null;
    YTX._videoFitMetadataHandler = null;
  }

  function scheduleVideoFit(primary) {
    if (!YTX.resizerInjected) return;
    cancelScheduledVideoFit();
    fitMainVideo(primary);
    var first = requestAnimationFrame(function () {
      if (!YTX.resizerInjected) return;
      fitMainVideo(primary);
      var second = requestAnimationFrame(function () {
        if (YTX.resizerInjected) fitMainVideo(primary);
        YTX._videoFitRafs = [];
      });
      YTX._videoFitRafs = [second];
    });
    YTX._videoFitRafs = [first];
  }

  function fitMainVideo(primary) {
    var watchFlexy = document.querySelector('ytd-watch-flexy');
    if (!primary || isTheaterMode(watchFlexy)) return;

    var moviePlayer = document.querySelector('#movie_player');
    var video = moviePlayer && moviePlayer.querySelector('video.html5-main-video');
    var videoContainer = moviePlayer && moviePlayer.querySelector('.html5-video-container');
    if (!moviePlayer || !video) {
      clearVideoFitMetadataListener();
      return;
    }
    if (YTX._videoFitMetadataVideo && YTX._videoFitMetadataVideo !== video) {
      clearVideoFitMetadataListener();
    }
    if (!video.videoWidth || !video.videoHeight) {
      if (YTX._videoFitMetadataVideo !== video) {
        var onLoadedMetadata = function () {
          clearVideoFitMetadataListener();
          if (YTX.resizerInjected) scheduleVideoFit(primary);
        };
        YTX._videoFitMetadataVideo = video;
        YTX._videoFitMetadataHandler = onLoadedMetadata;
        video.dataset.ytxFitMetadataBound = '1';
        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      }
      return;
    }
    if (YTX._videoFitMetadataVideo === video) clearVideoFitMetadataListener();

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
    cancelScheduledVideoFit();
    clearVideoFitMetadataListener();
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
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
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

  function resetTranscribeStreamBuffers() {
    if (YTX._transcribeFlushTimer) {
      clearTimeout(YTX._transcribeFlushTimer);
      YTX._transcribeFlushTimer = null;
    }
    YTX._transcribeBuffer = '';
    YTX._transcribeChunkBatch = null;
    YTX._transcribeMarkerPositions = [];
    YTX._transcribeScanOffset = 0;
    YTX._transcribeStreamChars = 0;
    YTX._transcribeRenderedSegments = 0;
  }

  function queueTranscribeChunk(text, requestId) {
    if (!YTX._transcribeChunkBatch) {
      YTX._transcribeChunkBatch = YTX.createChunkBatch(YTX.TRANSCRIPT_MAX_CHARS, 256);
    }
    if (!YTX._transcribeChunkBatch.push(text)) {
      failTranscribeStream(requestId, '视频转录输出过长，已取消以保护页面');
      return;
    }
    if (YTX._transcribeFlushTimer) return;
    YTX._transcribeFlushTimer = setTimeout(function () {
      YTX._transcribeFlushTimer = null;
      if (requestId === YTX._transcribeRequestId) flushTranscribeBuffer(requestId, false);
    }, 50);
  }

  function mergePendingTranscribeChunks(requestId) {
    if (!YTX._transcribeChunkBatch) return true;
    var incoming = YTX._transcribeChunkBatch.drain();
    YTX._transcribeChunkBatch = null;
    if (!incoming) return true;
    var nextBuffer = YTX.appendCappedText(YTX._transcribeBuffer || '', incoming, YTX.TRANSCRIPT_MAX_CHARS);
    if (nextBuffer === null) {
      failTranscribeStream(requestId, '视频转录输出过长，已取消以保护页面');
      return false;
    }
    YTX._transcribeBuffer = nextBuffer;
    return true;
  }

  function renderTranscribePiece(container, piece) {
    var seg = piece.replace(/\s+/g, ' ').trim();
    if (!seg) return true;
    if ((YTX._transcribeRenderedSegments || 0) >= YTX.TRANSCRIPT_MAX_SEGMENTS) return false;
    YTX._transcribeRenderedSegments = (YTX._transcribeRenderedSegments || 0) + 1;
    var match = seg.match(/^\[(\d{1,15}:\d{2}(?::\d{2})?)\]\s*(.*)/);
    if (match && match[2].trim()) {
      var seconds = YTX.timeToSeconds(match[1]);
      if (isFinite(seconds)) {
        container.insertAdjacentHTML('beforeend',
          '<div class="ytx-transcript-line">' +
          '<span class="ytx-ts" data-time="' + seconds + '">[' + match[1] + ']</span>' +
          '<span>' + YTX.escapeHtml(match[2].trim()) + '</span></div>');
        return true;
      }
    }
    container.insertAdjacentHTML('beforeend',
      '<div class="ytx-transcript-line"><span>' + YTX.escapeHtml(seg) + '</span></div>');
    return true;
  }

  function flushTranscribeBuffer(requestId, finalFlush) {
    if (!mergePendingTranscribeChunks(requestId)) return false;
    var buffer = YTX._transcribeBuffer || '';
    if (!buffer) return true;
    var body = YTX.panel && YTX.panel.querySelector('#ytx-transcript-body');
    var container = body && body.querySelector('#ytx-seg-container');
    if (!container) {
      if (finalFlush) resetTranscribeStreamBuffers();
      return true;
    }

    // 时间戳最长固定为 22 字符；仅重扫旧尾部 32 字符即可捕获跨 chunk 标记。
    var scanOffset = Math.min(YTX._transcribeScanOffset || 0, buffer.length);
    var scanStart = Math.max(0, scanOffset - 32);
    var positions = Array.isArray(YTX._transcribeMarkerPositions)
      ? YTX._transcribeMarkerPositions.filter(function (position) { return position < scanStart; })
      : [];
    var markerPattern = /\[\d{1,15}:\d{2}(?::\d{2})?\]/g;
    markerPattern.lastIndex = scanStart;
    var marker;
    while ((marker = markerPattern.exec(buffer))) {
      if (!positions.length || positions[positions.length - 1] !== marker.index) positions.push(marker.index);
    }
    YTX._transcribeScanOffset = buffer.length;
    YTX._transcribeMarkerPositions = positions;

    if (!finalFlush && positions.length < 2) return true;
    var lastCompleteEnd = finalFlush ? buffer.length : positions[positions.length - 1];
    var ranges = [];
    if (!positions.length) {
      ranges.push([0, lastCompleteEnd]);
    } else {
      if (positions[0] > 0) ranges.push([0, positions[0]]);
      var markerLimit = finalFlush ? positions.length : positions.length - 1;
      for (var i = 0; i < markerLimit; i++) {
        ranges.push([positions[i], i + 1 < positions.length ? positions[i + 1] : buffer.length]);
      }
    }
    for (var ri = 0; ri < ranges.length; ri++) {
      if (!renderTranscribePiece(container, buffer.slice(ranges[ri][0], ranges[ri][1]))) {
        failTranscribeStream(requestId, '视频转录分段过多，已取消以保护页面');
        return false;
      }
    }

    if (finalFlush) {
      resetTranscribeStreamBuffers();
    } else {
      YTX._transcribeBuffer = buffer.slice(lastCompleteEnd);
      YTX._transcribeMarkerPositions = [0];
      YTX._transcribeScanOffset = YTX._transcribeBuffer.length;
    }
    container.scrollTop = container.scrollHeight;
    return true;
  }

  function failTranscribeStream(requestId, message) {
    if (requestId) YTX.cancelRequest(requestId);
    YTX._transcribeRejectedRequestId = requestId || null;
    if (YTX._transcribeRequestId === requestId) {
      YTX._transcribeRequestId = null;
      YTX._transcribeVideoId = null;
    }
    resetTranscribeStreamBuffers();
    YTX._transcribeReceiving = false;
    YTX.transcriptData = null;
    if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
    var status = YTX.panel && YTX.panel.querySelector('#ytx-seg-status');
    if (status) {
      status.textContent = '转录已取消';
      status.style.color = '#b91c1c';
    }
    var body = YTX.panel && YTX.panel.querySelector('#ytx-transcript-body');
    if (body) YTX.renderError(body, message);
    if (typeof YTX.settleTranscribeDeferred === 'function') {
      YTX.settleTranscribeDeferred(requestId, new Error(message || '视频转录失败'));
    }
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'YTX_CHAT_SUBMIT') {
      var chat = YTX.features.chat;
      var accepted = !!(chat && chat.acceptFrameQuestion &&
        chat.acceptFrameQuestion(message.text, message.token, message.videoId));
      if (sendResponse) sendResponse({ accepted: accepted });
      return false;
    }
    if (message && message.type === 'TRANSCRIBE_ERROR') {
      if (message.videoId !== YTX.currentVideoId || message.requestId !== YTX._transcribeRequestId) return false;
      failTranscribeStream(message.requestId, typeof message.error === 'string' ? message.error : '视频转录失败');
      return false;
    }
    if (!YTX.panel) return;

    // 模型信息（调试用，显示在面板底部）
    if (message.type && message.type.endsWith('_MODEL')) {
      // 与 _CHUNK/_DONE/_ERROR 同样的 requestId 过滤：避免旧请求的模型名更新当前 badge
      var modelPrefix = message.type.slice(0, -('_MODEL'.length));
      var modelFeature = prefixMap[modelPrefix];
      if (!modelFeature || !message.requestId || message.requestId !== modelFeature.requestId) return;

      var badge = YTX.panel.querySelector('#ytx-model-badge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'ytx-model-badge';
        badge.style.cssText = 'padding:4px 12px;font-size:11px;color:#9ca3af;text-align:right;';
        YTX.panel.appendChild(badge);
      }
      badge.textContent = message.provider + ' / ' + message.model;
      return;
    }

    // ── 视频转录流式 chunk ──
    if (message.type === 'TRANSCRIBE_CHUNK') {
      // videoId + requestId 双重过滤：切视频后旧转录、同视频下被取消的旧请求都丢弃
      if (message.videoId !== YTX.currentVideoId || message.requestId !== YTX._transcribeRequestId) return;
      if (typeof message.text !== 'string' ||
          (YTX._transcribeStreamChars || 0) + message.text.length > YTX.TRANSCRIPT_MAX_CHARS) {
        failTranscribeStream(message.requestId, '视频转录输出过长或格式无效，已取消以保护页面');
        return;
      }
      YTX._transcribeStreamChars = (YTX._transcribeStreamChars || 0) + message.text.length;
      // 首个 chunk 到达，切换计时器文案
      if (YTX._transcribeTimer && !YTX._transcribeReceiving) {
        YTX._transcribeReceiving = true;
      }
      queueTranscribeChunk(message.text, message.requestId);
      return;
    }

    // ── 视频转录开始 ──
    if (message.type === 'TRANSCRIBE_PROGRESS') {
      if (message.videoId !== YTX.currentVideoId || message.requestId !== YTX._transcribeRequestId) return;
      var body = YTX.panel.querySelector('#ytx-transcript-body');
      if (!body) return;
      resetTranscribeStreamBuffers();
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
      if (message.videoId !== YTX.currentVideoId || message.requestId !== YTX._transcribeRequestId) return;
      var terminalRequestId = message.requestId;
      // 先把50ms批次与最后一个未闭合时间戳段一次性落地；失败会取消请求并
      // 标记 rejected，使稍后到达的 sendResponse 不能缓存毒结果。
      if (!flushTranscribeBuffer(terminalRequestId, true)) return;
      // SEGMENT 是终态消息；flush 后再清 ID，避免最后一批被误判成旧请求。
      YTX._transcribeRequestId = null;
      YTX._transcribeVideoId = null;
      YTX._transcribeReceiving = false;
      if (YTX._transcribeTimer) { clearInterval(YTX._transcribeTimer); YTX._transcribeTimer = null; }
      var body = YTX.panel.querySelector('#ytx-transcript-body');
      var container = body && body.querySelector('#ytx-seg-container');

      if (typeof message.text === 'string' && message.text) {
        // SEGMENT 与 sendResponse 是同一完整结果的双通道通知；这里只保存一份
        // 有界临时状态，最终由 _analyzeVideoWithGemini 规范化覆盖，绝不追加重复文本。
        var terminalWasTruncated = message.text.length > YTX.TRANSCRIPT_MAX_CHARS;
        YTX.transcriptData = {
          segments: null,
          full: terminalWasTruncated ? YTX.truncateTranscript(message.text) : message.text,
          truncated: terminalWasTruncated,
        };
      } else if (message.error && container) {
        container.insertAdjacentHTML('beforeend',
          '<div style="padding:4px 8px;font-size:11px;color:#b45309;background:#fef3c7;border-radius:4px;margin-bottom:8px">' +
          '转录失败: ' + YTX.escapeHtml(message.error) + '</div>');
      }
      if (typeof message.text === 'string' && message.text && typeof YTX.settleTranscribeDeferred === 'function') {
        YTX.settleTranscribeDeferred(terminalRequestId, null, message.text, message);
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

    // requestId 必须存在且严格匹配；缺 ID 的广播也不能污染当前流。
    if (!message.requestId || message.requestId !== feature.requestId) return;

    if (action === 'CHUNK' && feature.onChunk) {
      feature.onChunk(message.text);
    } else if (action === 'DONE' && feature.onDone) {
      if (typeof YTX.clearStreamWatchdog === 'function') YTX.clearStreamWatchdog(message.requestId);
      // DONE carries the bounded authoritative full output. Replace the local
      // streaming accumulator before final parsing/rendering so a service-
      // worker restart cannot turn a lost final CHUNK into a green truncated
      // success state.
      if (!YTX.applyAuthoritativeStreamText(feature, prefix, message.text)) {
        if (feature.onError) feature.onError('AI 最终输出无效，请重试');
        return;
      }
      feature.onDone(message);
    } else if (action === 'ERROR' && feature.onError) {
      if (typeof YTX.clearStreamWatchdog === 'function') YTX.clearStreamWatchdog(message.requestId);
      feature.onError(message.error);
    }
  });

  // ── 启动 ─────────────────────────────────────────────
  chrome.storage.sync.get(['youtubePanelDefaultCollapsed', 'enableYoutube'], function (data) {
    if (!chrome.runtime.lastError && data) {
      YTX.panelCollapsed = data.youtubePanelDefaultCollapsed !== false;
      featureEnabled = data.enableYoutube !== false;
    }
    init();
  });

  // 开关变化即时生效：开启 → 立即注入当前视频面板；关闭 → onNavigate 走清理路径
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync' || !changes.enableYoutube) return;
    featureEnabled = changes.enableYoutube.newValue !== false;
    onNavigate();
  });
})();
