// src/translate.js — 划词翻译功能（独立于 YTX，在所有页面生效）

(function () {
  var MAX_TEXT_LENGTH = 5000;
  var MAX_CONTEXT_LENGTH = 5000;
  var MAX_RESULT_LENGTH = 100000;
  var REQUEST_WATCHDOG_MS = 16 * 60 * 1000;
  var lifecycle = new AbortController();
  var uiLifecycle = null;
  var icon, popup, uiHost, uiRoot, uiContainer, uiObserver, fallbackStyle, currentText, isTranslating;
  var stylesReady = false;
  var styleLoadPromise = null;
  var resultText = '';
  var selectionRect = null;
  var currentModel = '';
  var isPinned = false;
  var userPinPreference = false;
  // 当前请求 ID：每次 doTranslate 生成新 ID，CHUNK/DONE/ERROR/MODEL 必须匹配才处理
  // 防止用户关弹窗后立刻发起下一次翻译时旧 chunk 污染新结果
  var currentRequestId = null;
  var requestWatchdogTimer = null;
  var selectionTimer = null;
  var selectionGeneration = 0;
  var featureEnabled = false;
  var disposed = false;
  function makeReqId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ── 拖拽状态 ──────────────────────────────────────────
  var isDragging = false;
  var dragOffsetX = 0, dragOffsetY = 0;

  // 功能开关在 storage 成功返回前 fail closed。公开 DOM takeover 事件已移除，
  // 避免宿主页面伪造或阻断扩展内部生命周期信号。

  // ── 目标语言选项 ──────────────────────────────────────
  var TARGET_LANGS = [
    { value: 'auto', label: '自动检测' },
    { value: 'zh', label: '简体中文' },
    { value: 'en', label: 'English' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' },
    { value: 'ru', label: 'Русский' },
  ];

  // ── SVG ────────────────────────────────────────────────
  var ICON_SPINNER = '<svg class="ytx-translate-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>';
  var SVG_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  var SVG_TRANSLATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l6 0"/><path d="M4 6l4 0"/><path d="M6 6v2a6 6 0 0 0 3.2 5.3"/><path d="M10 6v2a6 6 0 0 1-3.2 5.3"/><path d="M14 15l3-6 3 6"/><path d="M15 13h4"/></svg>';
  var SVG_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>';
  var SVG_PIN_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>';

  // manifest 以 all_frames 注入；每个 frame 只处理自己的选区和 UI，
  // 不再从 top frame 扫描/访问 iframe DOM。

  function hardenUiHost() {
    if (!uiHost) return;
    if (uiHost.hasAttribute('hidden')) uiHost.removeAttribute('hidden');
    if (uiHost.hasAttribute('inert')) uiHost.removeAttribute('inert');
    var extraStyle = Array.prototype.some.call(uiHost.style, function (name) {
      return name !== 'all' && name !== 'display';
    });
    if (extraStyle || uiHost.style.getPropertyValue('all') !== 'initial' ||
        uiHost.style.getPropertyPriority('all') !== 'important' ||
        uiHost.style.getPropertyValue('display') !== 'contents' ||
        uiHost.style.getPropertyPriority('display') !== 'important') {
      uiHost.style.cssText = 'all: initial !important; display: contents !important;';
    }
  }

  function syncUiTheme() {
    if (!uiContainer || !document.documentElement) return;
    uiContainer.toggleAttribute('dark', document.documentElement.hasAttribute('dark'));
  }

  function containUiEvent(e) {
    if (e.type === 'keydown' && e.isTrusted && e.key === 'Escape') hideAll();
    // 目标控件先收到事件，随后在 shadow 边界截断普通冒泡。宿主页面的 capture
    // 监听仍会更早运行，所以此 UI 不提供 textarea/contenteditable 等秘密输入入口。
    e.stopPropagation();
  }

  function loadUiStyles() {
    if (stylesReady) return Promise.resolve(true);
    if (styleLoadPromise) return styleLoadPromise;
    try {
      styleLoadPromise = fetch(chrome.runtime.getURL('translate/translate.css'), { credentials: 'omit' })
        .then(function (response) {
          if (!response.ok) throw new Error('translate stylesheet unavailable');
          return response.text();
        })
        .then(function (cssText) {
          if (disposed || !featureEnabled || !uiRoot) {
            styleLoadPromise = null;
            return false;
          }
          var style = document.createElement('style');
          style.setAttribute('data-aatools-translate-style', '');
          style.textContent = cssText;
          uiRoot.insertBefore(style, fallbackStyle ? fallbackStyle.nextSibling : uiRoot.firstChild);
          stylesReady = true;
          if (fallbackStyle && fallbackStyle.parentNode) fallbackStyle.parentNode.removeChild(fallbackStyle);
          fallbackStyle = null;
          return true;
        })
        .catch(function () {
          // 保持最小样式将 UI 隐藏；后续重新启用时可再次尝试加载。
          styleLoadPromise = null;
          return false;
        });
    } catch (_) {
      styleLoadPromise = null;
      return Promise.resolve(false);
    }
    return styleLoadPromise;
  }

  function ensureUiHost() {
    if (!uiHost) {
      // Use a built-in element. A page can register any hyphenated custom
      // element name before this isolated-world script runs; its constructor
      // could attach the one allowed shadow root first and permanently break
      // our UI on that page.
      uiHost = document.createElement('div');
      uiHost.setAttribute('data-aatools-ui', 'translate');
      uiRoot = uiHost.attachShadow({ mode: 'closed' });
      fallbackStyle = document.createElement('style');
      fallbackStyle.textContent = ':host{all:initial!important;display:contents!important}' +
        '#ytx-translate-icon,#ytx-translate-popup{display:none!important}';
      uiRoot.appendChild(fallbackStyle);
      uiContainer = document.createElement('div');
      uiContainer.setAttribute('data-aatools-translate-container', '');
      uiContainer.style.setProperty('display', 'contents', 'important');
      uiRoot.appendChild(uiContainer);
      ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu', 'wheel',
        'keydown', 'keyup', 'beforeinput', 'input', 'change', 'compositionstart',
        'compositionupdate', 'compositionend', 'paste', 'copy', 'cut',
        'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend']
        .forEach(function (type) {
          uiRoot.addEventListener(type, containUiEvent, { signal: lifecycle.signal });
        });
      uiRoot.addEventListener('mouseup', function (e) {
        handleSelectionMouseup(e, uiRoot.activeElement);
      }, { capture: true, signal: lifecycle.signal });
    }
    hardenUiHost();
    syncUiTheme();
    if (document.documentElement && uiHost.parentNode !== document.documentElement) {
      document.documentElement.appendChild(uiHost);
    }
    loadUiStyles();
    startUiObserver();
    return uiContainer;
  }

  function repairUiConnection() {
    if (disposed || !featureEnabled || !uiHost || !uiRoot) return;
    hardenUiHost();
    syncUiTheme();
    if (document.documentElement && uiHost.parentNode !== document.documentElement) {
      document.documentElement.appendChild(uiHost);
    }
    if (uiContainer && !uiRoot.contains(uiContainer)) uiRoot.appendChild(uiContainer);
    if (icon && uiContainer && !uiContainer.contains(icon)) uiContainer.appendChild(icon);
    if (popup && uiContainer && !uiContainer.contains(popup)) uiContainer.appendChild(popup);
  }

  function startUiObserver() {
    if (disposed || !featureEnabled || !uiHost || uiObserver || !document.documentElement) return;
    uiObserver = new MutationObserver(repairUiConnection);
    uiObserver.observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ['dark'] });
    uiObserver.observe(uiHost, { attributes: true, attributeFilter: ['style', 'hidden', 'inert'] });
    if (uiRoot) uiObserver.observe(uiRoot, { childList: true });
  }

  function stopUiObserver() {
    if (uiObserver) uiObserver.disconnect();
    uiObserver = null;
  }

  function detachUi() {
    stopUiObserver();
    if (uiHost && uiHost.parentNode) uiHost.parentNode.removeChild(uiHost);
  }

  // ── 创建 DOM 元素 ──────────────────────────────────────
  function ensureElements() {
    if (disposed || !featureEnabled) return false;
    var root = ensureUiHost();
    if (!icon) {
      icon = document.createElement('button');
      icon.type = 'button';
      icon.id = 'ytx-translate-icon';
      icon.title = '翻译选中文本';
      icon.textContent = '译';
      icon.addEventListener('mousedown', function (e) {
        if (!e.isTrusted || disposed || !featureEnabled) return;
        e.preventDefault();
        e.stopPropagation();
      }, { signal: lifecycle.signal });
      icon.addEventListener('click', function (e) {
        if (!e.isTrusted || disposed || !featureEnabled) return;
        e.preventDefault();
        e.stopPropagation();
        handleIconClick();
      }, { signal: lifecycle.signal });
    }
    if (!root.contains(icon)) root.appendChild(icon);
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'ytx-translate-popup';
    }
    if (!root.contains(popup)) root.appendChild(popup);
    return true;
  }

  // ── 检测扩展上下文是否有效 ────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime && !!chrome.runtime.id; } catch (_) { return false; }
  }

  function restoreIdleUi() {
    isTranslating = false;
    removeCursor();
    setTranslating(false);
    if (icon) {
      icon.textContent = '译';
      icon.classList.remove('ytx-translate-loading');
    }
  }

  function sendCancelRequest(requestId, reason) {
    if (!requestId || !isContextValid()) return;
    try {
      chrome.runtime.sendMessage({
        type: 'CANCEL_REQUEST',
        requestId: requestId,
        reason: reason || '翻译请求已取消',
      }, function () {
        // 取消是 best-effort；读取 lastError 避免扩展更新时产生未处理警告。
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  function clearRequestWatchdog() {
    if (requestWatchdogTimer) clearTimeout(requestWatchdogTimer);
    requestWatchdogTimer = null;
  }

  function armRequestWatchdog(requestId) {
    clearRequestWatchdog();
    requestWatchdogTimer = setTimeout(function () {
      requestWatchdogTimer = null;
      if (disposed || !featureEnabled || currentRequestId !== requestId) return;
      sendCancelRequest(requestId, '翻译请求等待超时');
      currentRequestId = null;
      restoreIdleUi();
      showError('翻译请求等待超时，请重试');
    }, REQUEST_WATCHDOG_MS);
    if (requestWatchdogTimer && typeof requestWatchdogTimer.unref === 'function') requestWatchdogTimer.unref();
  }

  function cancelCurrentRequest(reason) {
    var requestId = currentRequestId;
    // 先清 ID，使取消过程中到达的旧 chunk 立即失效。
    currentRequestId = null;
    clearRequestWatchdog();
    if (requestId) sendCancelRequest(requestId, reason);
    restoreIdleUi();
  }

  function finishCurrentRequest(requestId) {
    if (!requestId || requestId !== currentRequestId) return false;
    currentRequestId = null;
    clearRequestWatchdog();
    restoreIdleUi();
    return true;
  }

  function applyAuthoritativeTranslation(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_RESULT_LENGTH) return false;
    resultText = text;
    return true;
  }

  // ── 读取 API 设置（仅非敏感字段；API key 由 background 自读，content script 不接触）──
  function getSettings(callback) {
    if (!isContextValid()) {
      callback(null, '扩展已更新，请刷新页面后重试');
      return;
    }
    try {
      chrome.storage.sync.get(['provider', 'claudeModel', 'openaiModel', 'geminiModel', 'minimaxModel', 'deepseekModel', 'kimiModel', 'sub2apiModel', 'chatgptModel', 'promptTranslateDict', 'promptTranslateSentence'], function (s) {
        if (chrome.runtime.lastError) {
          callback(null, chrome.runtime.lastError.message || '读取翻译设置失败');
          return;
        }
        s = s || {};
        var provider = s.provider || 'claude';
        var modelMap = { claude: s.claudeModel, openai: s.openaiModel, gemini: s.geminiModel, minimax: s.minimaxModel, deepseek: s.deepseekModel, kimi: s.kimiModel, sub2api: s.sub2apiModel, chatgpt: s.chatgptModel };
        callback({
          provider: provider,
          model: modelMap[provider] || '',
          promptDict: s.promptTranslateDict || '',
          promptSentence: s.promptTranslateSentence || '',
        });
      });
    } catch (err) {
      callback(null, err && err.message ? err.message : '扩展已更新，请刷新页面后重试');
    }
  }

  // ── 获取当前选中的目标语言 ────────────────────────────
  function getTargetLang() {
    var sel = popup && popup.querySelector('.ytx-translate-lang-select');
    return sel ? sel.value : 'auto';
  }

  // ── 判断是否为短词（字典模式）────────────────────────
  function isDictWord(text) {
    var t = text.trim();
    var strippedLen = t.replace(/[\s\p{P}\d]/gu, '').length;
    if (strippedLen > 20) return false;
    var wordCount = t.split(/\s+/).length;
    var hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(t);
    return (hasCJK && strippedLen <= 4) || (!hasCJK && wordCount <= 3);
  }

  function selectedTextFromControl(el) {
    if (!el || typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return '';
    if (el.tagName === 'INPUT') {
      // 密码和非文本输入框不应成为翻译数据源。
      var type = String(el.type || 'text').toLowerCase();
      if (!/^(?:text|search|url|tel|email)$/.test(type)) return '';
    } else if (el.tagName !== 'TEXTAREA') {
      return '';
    }
    return String(el.value || '').substring(el.selectionStart, el.selectionEnd).trim();
  }

  function clearSelectionTimer() {
    selectionGeneration++;
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = null;
  }

  // ── mouseup：检测选中文本 → 显示图标（基于鼠标位置） ────
  // 使用 capture 阶段，确保在 YouTube 等 SPA 框架的事件处理之前捕获选区
  function handleSelectionMouseup(e, activeElementOverride) {
    if (disposed || !featureEnabled) return;
    if (!e.isTrusted) return;
    if (!activeElementOverride && uiHost && e.target === uiHost) return;
    if (icon && icon.contains(e.target)) return;

    // 弹窗内交互元素不触发
    if (popup && popup.contains(e.target)) {
      var tag = e.target.tagName;
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'OPTION' ||
          tag === 'SVG' || tag === 'path' || tag === 'line' || tag === 'rect' || tag === 'polyline' || tag === 'circle') return;
    }

    // 立即捕获选区文本和位置（防止被页面 JS 清除）
    var mouseX = e.clientX, mouseY = e.clientY;
    var immediateText = '';
    var immediateRect = null;
    var activeEl = activeElementOverride || document.activeElement;

    // textarea / 单行文本 input
    immediateText = selectedTextFromControl(activeEl);
    // 常规 selection
    if (!immediateText) {
      try {
        var sel = window.getSelection();
        immediateText = sel ? sel.toString().trim() : '';
        if (sel && sel.rangeCount > 0) {
          var range = sel.getRangeAt(0);
          var rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            immediateRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          }
        }
      } catch (_) {}
    }

    clearSelectionTimer();
    var generation = selectionGeneration;
    selectionTimer = setTimeout(function () {
      selectionTimer = null;
      if (disposed || !featureEnabled || generation !== selectionGeneration) return;
      // 优先用立即捕获的文本，回退到延迟读取
      var text = immediateText;
      if (!text) {
        var curActiveEl = (uiRoot && uiRoot.activeElement) || document.activeElement;
        text = selectedTextFromControl(curActiveEl);
        if (!text) {
          var sel2 = window.getSelection();
          text = sel2 ? sel2.toString().trim() : '';
        }
      }

      if (!text || text.length < 2 || text.length > MAX_TEXT_LENGTH) {
        if (!popup || !popup.contains(e.target)) hideIcon();
        return;
      }

      if (!ensureElements()) return;
      currentText = text;

      // 选区位置：优先用立即捕获的，回退到鼠标位置
      selectionRect = immediateRect || { left: mouseX, right: mouseX, top: mouseY, bottom: mouseY };

      // 在静态原文区内选中短词 → 自动触发字典模式（带上下文）。原文区不是
      // 可编辑控件，避免宿主页面 capture 监听窃取用户新键入或粘贴的文本。
      var sourceDisplay = popup && popup.querySelector('.ytx-translate-source-text');
      var inSourceDisplay = popup && popup.style.display === 'flex' && sourceDisplay &&
        (e.target === sourceDisplay || sourceDisplay.contains(e.target));
      if (inSourceDisplay && isDictWord(text)) {
        var fullContext = String(sourceDisplay.textContent || '').trim();
        if (fullContext.length > MAX_CONTEXT_LENGTH) {
          showError('原文语境不能超过 ' + MAX_CONTEXT_LENGTH + ' 个字符');
          return;
        }
        hideIcon();
        doTranslate(text, fullContext);
        return;
      }

      icon.textContent = '译';
      icon.classList.remove('ytx-translate-loading');
      icon.style.display = 'flex';

      // 图标跟随鼠标位置（右下方）
      var ix = mouseX + 8;
      var iy = mouseY + 8;
      if (ix + 32 > window.innerWidth) ix = mouseX - 36;
      if (iy + 32 > window.innerHeight) iy = mouseY - 36;
      icon.style.left = ix + 'px';
      icon.style.top = iy + 'px';
    }, 10);
  }

  document.addEventListener('mouseup', handleSelectionMouseup, { capture: true, signal: lifecycle.signal });

  // ── 点击图标 ──────────────────────────────────────────
  function handleIconClick() {
    if (disposed || !featureEnabled || isTranslating || !currentText) return;
    if (!ensureElements()) return;

    if (popup && popup.style.display === 'flex') {
      setSourceText(currentText);
      doTranslate(currentText);
    } else {
      startTranslate();
    }
  }

  // ── 首次点击翻译 ──────────────────────────────────────
  function startTranslate() {
    if (disposed || !featureEnabled || isTranslating || !currentText) return;
    buildPopup(currentText);
    positionPopup();
    doTranslate(currentText);
  }

  // ── 实际发送翻译请求（context 可选，用于字典模式提供上下文）──
  function doTranslate(text, context) {
    if (disposed || !featureEnabled) return;
    text = typeof text === 'string' ? text.trim() : '';
    context = typeof context === 'string' ? context.trim() : '';
    if (!text) return;
    if (text.length > MAX_TEXT_LENGTH) {
      showError('翻译文本不能超过 ' + MAX_TEXT_LENGTH + ' 个字符');
      return;
    }
    if (context.length > MAX_CONTEXT_LENGTH) {
      showError('原文语境不能超过 ' + MAX_CONTEXT_LENGTH + ' 个字符');
      return;
    }

    // 设置读取是异步的，两次快速触发可能在 isTranslating 置位前重叠。
    // 新请求拥有新 ID，并主动取消被覆盖的旧请求。
    if (currentRequestId) cancelCurrentRequest('翻译请求已被新请求替换');
    var requestId = makeReqId();
    currentRequestId = requestId;
    isTranslating = true;
    resultText = '';
    hideIcon();
    setTranslating(true);

    var resultEl = popup && popup.querySelector('.ytx-translate-result-text');
    if (resultEl) {
      resultEl.textContent = '';
      resultEl.classList.remove('ytx-translate-error');
    }
    addCursor();
    setStatus('Translating...', 'active');

    getSettings(function (settings, settingsError) {
      // 读设置期间已关闭弹窗或已发起新请求。
      if (disposed || !featureEnabled || requestId !== currentRequestId) return;
      if (!settings) {
        finishCurrentRequest(requestId);
        showError(settingsError || '读取翻译设置失败');
        return;
      }

      // 不再前置校验 key（content script 不接触 key）；
      // 缺 key 时 background 会回 TRANSLATE_ERROR，由消息路由统一显示
      var msg = {
        type: 'TRANSLATE',
        text: text,
        targetLang: getTargetLang(),
        provider: settings.provider,
        model: settings.model,
        promptDict: settings.promptDict,
        promptSentence: settings.promptSentence,
        requestId: requestId,
      };
      // 传递原文区全文作为上下文，让字典模式结合语境解释
      if (context && context !== text) msg.context = context;

      try {
        chrome.runtime.sendMessage(msg, function (response) {
          // lastError 必须在回调内读取，即使该请求已被替换。
          var runtimeError = chrome.runtime.lastError;
          if (disposed || !featureEnabled || requestId !== currentRequestId) return;
          if (runtimeError || !response || response.started !== true) {
            finishCurrentRequest(requestId);
            showError(
              (runtimeError && runtimeError.message) ||
              (response && response.error) ||
              '无法启动翻译请求'
            );
          } else {
            armRequestWatchdog(requestId);
          }
        });
      } catch (err) {
        if (disposed || !featureEnabled || requestId !== currentRequestId) return;
        finishCurrentRequest(requestId);
        showError(err && err.message ? err.message : '扩展已更新，请刷新页面后重试');
      }
    });
  }

  // ── 构建弹窗 HTML ─────────────────────────────────────
  function buildPopup(sourceText) {
    if (!ensureElements()) return;
    if (uiLifecycle) uiLifecycle.abort();
    uiLifecycle = new AbortController();
    var uiSignal = uiLifecycle.signal;

    // 构建语言选项
    var langOptions = '';
    for (var i = 0; i < TARGET_LANGS.length; i++) {
      langOptions += '<option value="' + TARGET_LANGS[i].value + '">' + TARGET_LANGS[i].label + '</option>';
    }

    popup.innerHTML =
      // 头部（可拖拽）
      '<div class="ytx-translate-header">' +
        '<div class="ytx-translate-logo">译</div>' +
        '<span class="ytx-translate-title">AAtools Translate</span>' +
        '<button type="button" class="ytx-translate-pin" title="固定弹窗">' + SVG_PIN + '</button>' +
        '<button type="button" class="ytx-translate-close" title="关闭">' + SVG_CLOSE + '</button>' +
      '</div>' +
      // 内容区
      '<div class="ytx-translate-content">' +
        // 原文
        '<div class="ytx-translate-source">' +
          '<div class="ytx-translate-source-text" aria-label="原文"></div>' +
          '<div class="ytx-translate-source-actions">' +
            '<button type="button" class="ytx-translate-action-btn" data-action="copy-source" title="复制原文">' + SVG_COPY + '</button>' +
            '<select class="ytx-translate-lang-select" title="目标语言">' + langOptions + '</select>' +
            '<button type="button" class="ytx-translate-submit" title="重新翻译当前选区">' + SVG_TRANSLATE + ' 翻译</button>' +
          '</div>' +
        '</div>' +
        // 分隔
        '<div class="ytx-translate-divider">' +
          '<span class="ytx-translate-status"><span class="ytx-translate-status-dot"></span>Translating...</span>' +
        '</div>' +
        // 译文
        '<div class="ytx-translate-result">' +
          '<div class="ytx-translate-result-text"></div>' +
          '<div class="ytx-translate-result-actions">' +
            '<button type="button" class="ytx-translate-action-btn" data-action="copy-result" title="复制译文">' + SVG_COPY + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // 底部
      '<div class="ytx-translate-footer">' +
        '<span class="ytx-translate-footer-text">Powered by AAtools</span>' +
      '</div>';

    popup.style.display = 'flex';
    isPinned = userPinPreference;

    // 原文只显示页面已有选区，不在同文档 UI 接收新的键入或粘贴内容。
    setSourceText(sourceText);

    // 绑定关闭
    popup.querySelector('.ytx-translate-close').addEventListener('click', function (e) {
      if (!e.isTrusted || disposed || !featureEnabled) return;
      e.stopPropagation(); hideAll();
    }, { signal: uiSignal });

    // 绑定固定（如果之前固定过，默认保持固定状态）
    var pinBtn = popup.querySelector('.ytx-translate-pin');
    if (isPinned) {
      pinBtn.innerHTML = SVG_PIN_FILLED;
      pinBtn.classList.add('ytx-translate-pin-active');
      pinBtn.title = '取消固定';
    }
    pinBtn.addEventListener('click', function (e) {
      if (!e.isTrusted || disposed || !featureEnabled) return;
      e.stopPropagation(); togglePin();
    }, { signal: uiSignal });

    // 绑定翻译按钮
    popup.querySelector('.ytx-translate-submit').addEventListener('click', function (e) {
      if (!e.isTrusted) return;
      e.stopPropagation(); handleSubmit();
    }, { signal: uiSignal });

    // 绑定复制
    popup.querySelectorAll('.ytx-translate-action-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (!e.isTrusted || disposed || !featureEnabled) return;
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        if (action === 'copy-source') {
          copyText(getSourceText() || currentText, btn);
        }
        if (action === 'copy-result') copyText(resultText, btn);
      }, { signal: uiSignal });
    });

    // 绑定拖拽（在 header 上）
    initDrag();
  }

  // ── 拖拽实现 ──────────────────────────────────────────
  function initDrag() {
    var header = popup && popup.querySelector('.ytx-translate-header');
    if (!header) return;

    header.addEventListener('mousedown', function (e) {
      if (!e.isTrusted || disposed || !featureEnabled || e.button !== 0) return;
      // 不在按钮上才拖拽
      if (e.target.closest('.ytx-translate-close') || e.target.closest('.ytx-translate-pin')) return;
      e.preventDefault();
      isDragging = true;
      var pr = popup.getBoundingClientRect();
      dragOffsetX = e.clientX - pr.left;
      dragOffsetY = e.clientY - pr.top;
      popup.classList.add('ytx-translate-dragging');
    }, { signal: uiLifecycle.signal });
  }

  window.addEventListener('mousemove', function (e) {
    if (!e.isTrusted || disposed || !featureEnabled || !isDragging || !popup) return;
    if ((e.buttons & 1) === 0) {
      isDragging = false;
      popup.classList.remove('ytx-translate-dragging');
      return;
    }
    var newLeft = e.clientX - dragOffsetX;
    var newTop = e.clientY - dragOffsetY;
    // 限制在视口内
    var pw = popup.offsetWidth, ph = popup.offsetHeight;
    var maxLeft = Math.max(0, window.innerWidth - pw);
    var maxTop = Math.max(0, window.innerHeight - ph);
    if (newLeft < 0) newLeft = 0;
    if (newTop < 0) newTop = 0;
    if (newLeft > maxLeft) newLeft = maxLeft;
    if (newTop > maxTop) newTop = maxTop;
    popup.style.left = newLeft + 'px';
    popup.style.top = newTop + 'px';
  }, { capture: true, signal: lifecycle.signal });

  window.addEventListener('mouseup', function (e) {
    if (!e.isTrusted) return;
    if (isDragging) {
      isDragging = false;
      if (popup) {
        popup.classList.remove('ytx-translate-dragging');
        updateMaxHeight();
      }
    }
  }, { capture: true, signal: lifecycle.signal });

  // ── 固定/取消固定 ─────────────────────────────────────
  function togglePin() {
    if (disposed || !featureEnabled) return;
    isPinned = !isPinned;
    userPinPreference = isPinned;
    var btn = popup && popup.querySelector('.ytx-translate-pin');
    if (!btn) return;
    if (isPinned) {
      btn.innerHTML = SVG_PIN_FILLED;
      btn.classList.add('ytx-translate-pin-active');
      btn.title = '取消固定';
    } else {
      btn.innerHTML = SVG_PIN;
      btn.classList.remove('ytx-translate-pin-active');
      btn.title = '固定弹窗';
    }
  }

  function getSourceText() {
    var source = popup && popup.querySelector('.ytx-translate-source-text');
    return source ? String(source.textContent || '').trim() : '';
  }

  function setSourceText(text) {
    var source = popup && popup.querySelector('.ytx-translate-source-text');
    if (source) source.textContent = String(text || '').slice(0, MAX_TEXT_LENGTH);
  }

  // ── 使用当前页面选区重新翻译 ─────────────────────────
  function handleSubmit() {
    if (disposed || !featureEnabled || isTranslating) return;
    var text = getSourceText();
    if (!text) return;
    if (text.length > MAX_TEXT_LENGTH) {
      showError('翻译文本不能超过 ' + MAX_TEXT_LENGTH + ' 个字符');
      return;
    }
    currentText = text;
    doTranslate(text);
  }

  // ── 设置翻译中/完成状态 ───────────────────────────────
  function setTranslating(loading) {
    var btn = popup && popup.querySelector('.ytx-translate-submit');
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.innerHTML = ICON_SPINNER + ' 翻译中';
    } else {
      btn.innerHTML = SVG_TRANSLATE + ' 翻译';
    }
  }

  // ── 弹窗定位 + 动态 max-height ─────────────────────────
  function positionPopup() {
    if (disposed || !featureEnabled || !popup || !selectionRect) return;

    var margin = 10;
    var availableWidth = Math.max(1, window.innerWidth - margin * 2);
    var pw = Math.min(520, availableWidth);
    popup.style.width = pw + 'px';
    popup.style.minWidth = Math.min(320, pw) + 'px';

    var left = selectionRect.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;

    var top = selectionRect.bottom + 8;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    // 清除之前手动 resize 设定的固定 height，让弹窗自适应内容
    popup.style.height = '';

    updateMaxHeight();

    var rectAtPosition = selectionRect;
    requestAnimationFrame(function () {
      if (disposed || !featureEnabled || !popup || !rectAtPosition) return;
      var pr = popup.getBoundingClientRect();
      if (pr.bottom > window.innerHeight - margin) {
        var newTop = rectAtPosition.top - pr.height - 8;
        if (newTop < margin) newTop = margin;
        popup.style.top = newTop + 'px';
        updateMaxHeight();
      }
    });
  }

  // ── 根据弹窗 top 位置动态设置 max-height，不超过视口底部 ──
  function updateMaxHeight() {
    if (!popup) return;
    var margin = 10;
    var topPx = parseFloat(popup.style.top) || 0;
    var maxH = window.innerHeight - topPx - margin;
    if (maxH < 120) maxH = 120;
    popup.style.maxHeight = maxH + 'px';
  }

  // ── 复制文本 ──────────────────────────────────────────
  function copyText(text, btn) {
    if (disposed || !featureEnabled || !text || !btn || !btn.isConnected) return;
    // HTTP 页面、企业策略或浏览器设置可能不暴露 Clipboard API。不要回退到
    // 旧式的选区复制：它会触发宿主页面可观察的 copy 事件。
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      setStatus('Clipboard unavailable', 'error');
      return;
    }
    var writePromise;
    try {
      writePromise = navigator.clipboard.writeText(text);
    } catch (_) {
      setStatus('Copy failed', 'error');
      return;
    }
    Promise.resolve(writePromise).then(function () {
      if (disposed || !featureEnabled || !btn.isConnected) return;
      var orig = btn.innerHTML;
      btn.innerHTML = SVG_CHECK;
      btn.classList.add('ytx-copied');
      setTimeout(function () {
        if (disposed || !featureEnabled || !btn.isConnected) return;
        btn.innerHTML = orig;
        btn.classList.remove('ytx-copied');
      }, 1500);
    }).catch(function () {
      if (!disposed && featureEnabled) setStatus('Copy failed', 'error');
    });
  }

  // ── 更新状态指示 ──────────────────────────────────────
  function setStatus(text, state) {
    var el = popup && popup.querySelector('.ytx-translate-status');
    if (!el) return;
    el.classList.remove('done', 'incomplete', 'error');
    if (state === true || state === 'done') el.classList.add('done');
    else if (state === 'incomplete') el.classList.add('incomplete');
    else if (state === 'error') el.classList.add('error');
    el.innerHTML = '<span class="ytx-translate-status-dot"></span>' + escapeHtml(text);
  }

  function translationCompletionWarning(message) {
    if (!message || (message.truncated !== true && message.incomplete !== true &&
        !(typeof message.warning === 'string' && message.warning.trim()))) return '';
    if (typeof message.warning === 'string' && message.warning.trim()) {
      return message.warning.trim().slice(0, 500);
    }
    return '模型提前结束，当前仅为不完整翻译，请勿当作完整结果使用';
  }

  function updateFooter(provider, model) {
    var el = popup && popup.querySelector('.ytx-translate-footer-text');
    if (!el) return;
    var name = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', minimax: 'MiniMax', deepseek: 'DeepSeek', kimi: 'Kimi', sub2api: 'Sub2API', chatgpt: 'ChatGPT' }[provider] || provider;
    el.textContent = 'Powered by ' + name + (model ? ' ' + model : '');
  }

  function showError(msg) {
    if (disposed || !featureEnabled || !ensureElements()) return;
    if (!popup.querySelector('.ytx-translate-result-text')) {
      buildPopup(currentText || '');
      positionPopup();
    }
    var body = popup.querySelector('.ytx-translate-result-text');
    if (body) {
      removeCursor();
      body.textContent = msg;
      body.classList.add('ytx-translate-error');
    }
    setStatus('Error', 'error');
    setTranslating(false);
  }

  function addCursor() {
    var body = popup && popup.querySelector('.ytx-translate-result-text');
    if (body) {
      var existing = body.querySelector('.ytx-translate-cursor');
      if (existing) existing.remove();
      body.insertAdjacentHTML('beforeend', '<span class="ytx-translate-cursor"></span>');
    }
  }

  function removeCursor() {
    if (!popup) return;
    var cursor = popup.querySelector('.ytx-translate-cursor');
    if (cursor) cursor.remove();
  }

  function hideIcon() {
    if (icon) icon.style.display = 'none';
  }

  function hideAll() {
    clearSelectionTimer();
    isDragging = false;
    cancelCurrentRequest('翻译弹窗已关闭');
    hideIcon();
    if (popup) popup.style.display = 'none';
    resultText = '';
    currentText = '';
    selectionRect = null;
    isPinned = false;
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── 简易 Markdown → HTML（用于字典模式）──────────────
  function renderMarkdown(text) {
    var html = escapeHtml(text);
    // 移除分隔线 ---
    html = html.replace(/^-{2,}\s*$/gm, '');
    // 加粗 **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 斜体 *text*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // 行内代码 `text`
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');
    // 标题 ### / ## / # → 简单加粗
    html = html.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');
    // 词典首行：单词 /音标/
    html = html.replace(/^(.+?) (\/[^/]+\/)$/gm, '<div class="ytx-dict-head"><strong>$1</strong> <span class="ytx-dict-phonetic">$2</span></div>');
    // 词性行：n. v. adj. 等开头
    html = html.replace(/^((?:n|v|vt|vi|adj|adv|prep|conj|pron|det|abbr|pl)\.) (.+)$/gm, '<div class="ytx-dict-def"><span class="ytx-dict-pos">$1</span> $2</div>');
    // 📌 语境行
    html = html.replace(/^(📌) (.+)$/gm, '<div class="ytx-dict-ctx">$1 $2</div>');
    // 例句行
    html = html.replace(/^(例[:：]) (.+)$/gm, '<div class="ytx-dict-ex"><span class="ytx-dict-label">$1</span> $2</div>');
    // 搭配行
    html = html.replace(/^(搭配[:：]) (.+)$/gm, '<div class="ytx-dict-ex"><span class="ytx-dict-label">$1</span> $2</div>');
    // 无序列表 - item
    html = html.replace(/^- (.+)$/gm, '<div style="padding-left:10px">· $1</div>');
    // 有序列表 1. item
    html = html.replace(/^(\d+)\. (.+)$/gm, '<div style="padding-left:10px">$1. $2</div>');
    // 合并连续空行
    html = html.replace(/\n{2,}/g, '\n');
    // 换行
    html = html.replace(/\n/g, '<br>');
    // 清理连续 <br>
    html = html.replace(/(<br\s*\/?>){2,}/g, '<br>');
    // 清理 div 前后多余的 <br>
    html = html.replace(/<br\s*\/?>\s*(<div)/g, '$1');
    html = html.replace(/(<\/div>)\s*<br\s*\/?>/g, '$1');
    return html;
  }

  function ensureResultBody() {
    if (!ensureElements()) return null;
    var body = popup.querySelector('.ytx-translate-result-text');
    if (!body) {
      buildPopup(currentText || '');
      positionPopup();
      setTranslating(!!currentRequestId);
      body = popup.querySelector('.ytx-translate-result-text');
    }
    return body;
  }

  // ── 消息监听 ──────────────────────────────────────────
  function handleRuntimeMessage(msg) {
    if (disposed || !featureEnabled || !msg || typeof msg !== 'object') return;
    // requestId 过滤：旧请求的响应（含 _MODEL/_CHUNK/_DONE/_ERROR）必须匹配当前 requestId
    // 用户关弹窗后立刻发起下一次翻译时，旧 chunk 不会污染新弹窗
    if (msg.type === 'TRANSLATE_MODEL' || msg.type === 'TRANSLATE_CHUNK' ||
        msg.type === 'TRANSLATE_DONE' || msg.type === 'TRANSLATE_ERROR') {
      if (!currentRequestId || msg.requestId !== currentRequestId) return;
    }

    if (msg.type === 'TRANSLATE_MODEL') {
      currentModel = msg.model || '';
      updateFooter(msg.provider, msg.model);
    }

    if (msg.type === 'TRANSLATE_CHUNK') {
      if (typeof msg.text !== 'string') return;
      if (resultText.length + msg.text.length > MAX_RESULT_LENGTH) {
        cancelCurrentRequest('翻译结果过长，请求已取消');
        showError('翻译结果过长，已停止接收');
        return;
      }
      resultText += msg.text;
      var body = ensureResultBody();
      if (body) {
        removeCursor();
        body.innerHTML = renderMarkdown(resultText);
        addCursor();
        var content = popup.querySelector('.ytx-translate-content');
        if (content) content.scrollTop = content.scrollHeight;
      }
    }

    if (msg.type === 'TRANSLATE_DONE') {
      if (!applyAuthoritativeTranslation(msg.text)) {
        cancelCurrentRequest('翻译最终输出无效或过长');
        showError('翻译最终输出无效或过长，请重试');
        return;
      }
      // Treat DONE.text as authoritative. It repairs a missing last CHUNK if
      // the extension service worker restarted between Port delivery steps.
      removeCursor();
      // 最终渲染
      var bodyDone = ensureResultBody();
      if (bodyDone) bodyDone.innerHTML = renderMarkdown(resultText);
      var completionWarning = translationCompletionWarning(msg);
      if (completionWarning && bodyDone) {
        var warningEl = document.createElement('div');
        warningEl.className = 'ytx-translate-incomplete-warning';
        warningEl.textContent = completionWarning;
        bodyDone.insertBefore(warningEl, bodyDone.firstChild);
      }
      setStatus(completionWarning ? 'Incomplete translation' : 'Translated',
        completionWarning ? 'incomplete' : 'done');
      finishCurrentRequest(msg.requestId);
    }

    if (msg.type === 'TRANSLATE_ERROR') {
      removeCursor();
      var errorBody = ensureResultBody();
      if (errorBody) {
        errorBody.textContent = typeof msg.error === 'string' ? msg.error.slice(0, 2000) : '翻译失败';
        errorBody.classList.add('ytx-translate-error');
      }
      setStatus('Error', 'error');
      finishCurrentRequest(msg.requestId);
    }
  }

  // ── 关闭逻辑（固定时点外部不关闭）────────────────────
  document.addEventListener('mousedown', function (e) {
    if (disposed || !featureEnabled || !e.isTrusted) return;
    if (uiHost && e.target === uiHost) return;
    if (icon && icon.contains(e.target)) return;
    if (popup && popup.contains(e.target)) return;

    if (popup && popup.style.display === 'flex') {
      if (!isPinned) hideAll();
      // 固定时不关闭
    } else {
      hideIcon();
    }
  }, { signal: lifecycle.signal });

  document.addEventListener('keydown', function (e) {
    if (disposed || !featureEnabled || !e.isTrusted) return;
    if (e.key === 'Escape') hideAll();
  }, { signal: lifecycle.signal });

  function setFeatureEnabled(nextEnabled) {
    if (disposed) return;
    var next = !!nextEnabled;
    if (featureEnabled === next) return;
    featureEnabled = next;
    if (!featureEnabled) {
      clearSelectionTimer();
      hideAll();
      if (uiLifecycle) uiLifecycle.abort();
      uiLifecycle = null;
      detachUi();
    } else {
      ensureUiHost();
    }
  }

  function handleStorageChanged(changes, area) {
    if (disposed || area !== 'sync' || !changes.enableTranslate) return;
    setFeatureEnabled(changes.enableTranslate.newValue !== false);
  }

  function loadFeatureSetting() {
    if (disposed) return;
    setFeatureEnabled(false);
    try {
      chrome.storage.sync.get(['enableTranslate'], function (data) {
        if (disposed) return;
        var runtimeError = null;
        try { runtimeError = chrome.runtime.lastError; } catch (_) { return; }
        if (runtimeError || !data) return;
        setFeatureEnabled(data.enableTranslate !== false);
      });
    } catch (_) {
      setFeatureEnabled(false);
    }
  }

  function dispose() {
    if (disposed) return;
    clearSelectionTimer();
    cancelCurrentRequest('页面已关闭，翻译请求已取消');
    featureEnabled = false;
    disposed = true;
    isDragging = false;
    if (uiLifecycle) uiLifecycle.abort();
    uiLifecycle = null;
    stopUiObserver();
    lifecycle.abort();
    try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch (_) {}
    try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch (_) {}
    if (uiHost && uiHost.parentNode) uiHost.parentNode.removeChild(uiHost);
    icon = null;
    popup = null;
    uiContainer = null;
    uiRoot = null;
    uiHost = null;
  }

  window.addEventListener('pagehide', function (e) {
    if (e.persisted) setFeatureEnabled(false);
    else dispose();
  }, { signal: lifecycle.signal });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) loadFeatureSetting();
  }, { signal: lifecycle.signal });

  try { chrome.runtime.onMessage.addListener(handleRuntimeMessage); } catch (_) {}
  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch (_) {}
  loadFeatureSetting();
})();
