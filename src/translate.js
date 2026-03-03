// src/translate.js — 划词翻译功能（独立于 YTX，在所有页面生效）

(function () {
  var icon, popup, currentText, isTranslating;
  var resultText = '';
  var selectionRect = null;
  var currentModel = '';
  var isPinned = false;
  var userPinPreference = false;

  // ── 拖拽状态 ──────────────────────────────────────────
  var isDragging = false;
  var dragOffsetX = 0, dragOffsetY = 0;

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

  // ── 监听 iframe 内的选区（iframe 事件不冒泡到父文档）────
  function hookIframe(iframe) {
    if (!iframe || iframe._ytxTranslateHooked) return;
    iframe._ytxTranslateHooked = true;
    var tryHook = function () {
      try {
        var doc = iframe.contentDocument;
        if (!doc) return;
        doc.addEventListener('mouseup', function (e) {
          var sel = doc.getSelection ? doc.getSelection() : null;
          var text = sel ? sel.toString().trim() : '';
          if (!text || text.length < 2 || text.length > 5000) return;
          // 把 iframe 内坐标转换到主页面坐标
          var iframeRect = iframe.getBoundingClientRect();
          var mx = e.clientX + iframeRect.left;
          var my = e.clientY + iframeRect.top;
          ensureElements();
          currentText = text;
          selectionRect = { left: mx, right: mx, top: my, bottom: my };
          icon.textContent = '译';
          icon.classList.remove('ytx-translate-loading');
          icon.style.display = 'flex';
          var ix = mx + 8;
          var iy = my + 8;
          if (ix + 32 > window.innerWidth) ix = mx - 36;
          if (iy + 32 > window.innerHeight) iy = my - 36;
          icon.style.left = ix + 'px';
          icon.style.top = iy + 'px';
        }, true);
      } catch (_) {}
    };
    iframe.addEventListener('load', tryHook);
    // iframe 可能已加载完
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') tryHook();
  }

  // 监听动态添加的 iframe（MutationObserver）
  var iframeObserver = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IFRAME') hookIframe(node);
        // 也检查子节点中的 iframe
        if (node.querySelectorAll) {
          var iframes = node.querySelectorAll('iframe');
          for (var k = 0; k < iframes.length; k++) hookIframe(iframes[k]);
        }
      }
    }
  });
  iframeObserver.observe(document.documentElement, { childList: true, subtree: true });
  // hook 页面上已有的 iframe
  document.querySelectorAll('iframe').forEach(hookIframe);

  // ── 创建 DOM 元素 ──────────────────────────────────────
  function ensureElements() {
    if (!icon) {
      icon = document.createElement('button');
      icon.id = 'ytx-translate-icon';
      icon.title = '翻译选中文本';
      icon.textContent = '译';
      icon.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
      });
      icon.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        handleIconClick();
      });
      document.documentElement.appendChild(icon);
    }
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'ytx-translate-popup';
      document.documentElement.appendChild(popup);
    }
  }

  // ── 检测扩展上下文是否有效 ────────────────────────────
  function isContextValid() {
    try { return !!chrome.runtime && !!chrome.runtime.id; } catch (_) { return false; }
  }

  // ── 读取 API 设置 ─────────────────────────────────────
  function getSettings(callback) {
    if (!isContextValid()) {
      showError('扩展已更新，请刷新页面后重试');
      isTranslating = false;
      return;
    }
    try {
      chrome.storage.sync.get(['provider', 'claudeKey', 'openaiKey', 'geminiKey', 'claudeModel', 'openaiModel', 'geminiModel'], function (s) {
        var provider = s.provider || 'claude';
        var keyMap = { claude: s.claudeKey, openai: s.openaiKey, gemini: s.geminiKey };
        var modelMap = { claude: s.claudeModel, openai: s.openaiModel, gemini: s.geminiModel };
        callback({
          provider: provider,
          activeKey: keyMap[provider] || '',
          model: modelMap[provider] || ''
        });
      });
    } catch (_) {
      showError('扩展已更新，请刷新页面后重试');
      isTranslating = false;
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

  // ── mouseup：检测选中文本 → 显示图标（基于鼠标位置） ────
  // 使用 capture 阶段，确保在 YouTube 等 SPA 框架的事件处理之前捕获选区
  document.addEventListener('mouseup', function (e) {
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
    var activeEl = document.activeElement;

    // textarea
    if (activeEl && activeEl.tagName === 'TEXTAREA' && typeof activeEl.selectionStart === 'number') {
      immediateText = activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd).trim();
    }
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

    var capturedActiveEl = activeEl;

    setTimeout(function () {
      // 优先用立即捕获的文本，回退到延迟读取
      var text = immediateText;
      if (!text) {
        var curActiveEl = document.activeElement;
        if (curActiveEl && curActiveEl.tagName === 'TEXTAREA' && typeof curActiveEl.selectionStart === 'number') {
          text = curActiveEl.value.substring(curActiveEl.selectionStart, curActiveEl.selectionEnd).trim();
        }
        if (!text) {
          var sel2 = window.getSelection();
          text = sel2 ? sel2.toString().trim() : '';
        }
      }

      if (!text || text.length < 2 || text.length > 5000) {
        if (!popup || !popup.contains(e.target)) hideIcon();
        return;
      }

      ensureElements();
      currentText = text;

      // 选区位置：优先用立即捕获的，回退到鼠标位置
      selectionRect = immediateRect || { left: mouseX, right: mouseX, top: mouseY, bottom: mouseY };

      // 在弹窗的 textarea 内选中短词 → 自动触发字典模式（带上下文）
      var inSourceTextarea = popup && popup.style.display === 'flex' &&
        capturedActiveEl && capturedActiveEl.classList.contains('ytx-translate-source-textarea');
      if (inSourceTextarea && isDictWord(text)) {
        var fullContext = capturedActiveEl.value.trim();
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
  }, true);

  // ── 点击图标 ──────────────────────────────────────────
  function handleIconClick() {
    if (isTranslating || !currentText) return;

    if (popup && popup.style.display === 'flex') {
      var textarea = popup.querySelector('.ytx-translate-source-textarea');
      if (textarea) textarea.value = currentText;
      doTranslate(currentText);
    } else {
      startTranslate();
    }
  }

  // ── 首次点击翻译 ──────────────────────────────────────
  function startTranslate() {
    if (isTranslating || !currentText) return;
    buildPopup(currentText);
    positionPopup();
    doTranslate(currentText);
  }

  // ── 实际发送翻译请求（context 可选，用于字典模式提供上下文）──
  function doTranslate(text, context) {
    if (isTranslating) return;

    getSettings(function (settings) {
      if (!settings.activeKey) {
        showError('请先在 AAtools 扩展设置中填入 API Key');
        return;
      }

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
      setStatus('Translating...', false);

      var msg = {
        type: 'TRANSLATE',
        text: text,
        targetLang: getTargetLang(),
        provider: settings.provider,
        activeKey: settings.activeKey,
        model: settings.model
      };
      // 传递上下文（textarea 全文），让字典模式结合语境解释
      if (context && context !== text) msg.context = context;

      try {
        chrome.runtime.sendMessage(msg);
      } catch (_) {
        showError('扩展已更新，请刷新页面后重试');
        isTranslating = false;
        setTranslating(false);
      }
    });
  }

  // ── 构建弹窗 HTML ─────────────────────────────────────
  function buildPopup(sourceText) {
    ensureElements();

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
        '<button class="ytx-translate-pin" title="固定弹窗">' + SVG_PIN + '</button>' +
        '<button class="ytx-translate-close" title="关闭">' + SVG_CLOSE + '</button>' +
      '</div>' +
      // 内容区
      '<div class="ytx-translate-content">' +
        // 原文
        '<div class="ytx-translate-source">' +
          '<textarea class="ytx-translate-source-textarea" spellcheck="false"></textarea>' +
          '<div class="ytx-translate-source-actions">' +
            '<button class="ytx-translate-action-btn" data-action="copy-source" title="复制原文">' + SVG_COPY + '</button>' +
            '<select class="ytx-translate-lang-select" title="目标语言">' + langOptions + '</select>' +
            '<button class="ytx-translate-submit" title="翻译 (Ctrl+Enter)">' + SVG_TRANSLATE + ' 翻译</button>' +
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
            '<button class="ytx-translate-action-btn" data-action="copy-result" title="复制译文">' + SVG_COPY + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // 底部
      '<div class="ytx-translate-footer">' +
        '<span class="ytx-translate-footer-text">Powered by AAtools</span>' +
      '</div>';

    popup.style.display = 'flex';
    isPinned = userPinPreference;

    // 填入原文
    var textarea = popup.querySelector('.ytx-translate-source-textarea');
    textarea.value = sourceText;
    autoResizeTextarea(textarea);
    textarea.addEventListener('input', function () { autoResizeTextarea(textarea); });
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSubmit(); }
    });

    // 绑定关闭
    popup.querySelector('.ytx-translate-close').addEventListener('click', function (e) {
      e.stopPropagation(); hideAll();
    });

    // 绑定固定（如果之前固定过，默认保持固定状态）
    var pinBtn = popup.querySelector('.ytx-translate-pin');
    if (isPinned) {
      pinBtn.innerHTML = SVG_PIN_FILLED;
      pinBtn.classList.add('ytx-translate-pin-active');
      pinBtn.title = '取消固定';
    }
    pinBtn.addEventListener('click', function (e) {
      e.stopPropagation(); togglePin();
    });

    // 绑定翻译按钮
    popup.querySelector('.ytx-translate-submit').addEventListener('click', function (e) {
      e.stopPropagation(); handleSubmit();
    });

    // 绑定复制
    popup.querySelectorAll('.ytx-translate-action-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var action = btn.getAttribute('data-action');
        if (action === 'copy-source') {
          var ta = popup.querySelector('.ytx-translate-source-textarea');
          copyText(ta ? ta.value : currentText, btn);
        }
        if (action === 'copy-result') copyText(resultText, btn);
      });
    });

    // 绑定拖拽（在 header 上）
    initDrag();
  }

  // ── 拖拽实现 ──────────────────────────────────────────
  function initDrag() {
    var header = popup && popup.querySelector('.ytx-translate-header');
    if (!header) return;

    header.addEventListener('mousedown', function (e) {
      // 不在按钮上才拖拽
      if (e.target.closest('.ytx-translate-close') || e.target.closest('.ytx-translate-pin')) return;
      e.preventDefault();
      isDragging = true;
      var pr = popup.getBoundingClientRect();
      dragOffsetX = e.clientX - pr.left;
      dragOffsetY = e.clientY - pr.top;
      popup.classList.add('ytx-translate-dragging');
    });
  }

  document.addEventListener('mousemove', function (e) {
    if (!isDragging || !popup) return;
    var newLeft = e.clientX - dragOffsetX;
    var newTop = e.clientY - dragOffsetY;
    // 限制在视口内
    var pw = popup.offsetWidth, ph = popup.offsetHeight;
    if (newLeft < 0) newLeft = 0;
    if (newTop < 0) newTop = 0;
    if (newLeft + pw > window.innerWidth) newLeft = window.innerWidth - pw;
    if (newTop + ph > window.innerHeight) newTop = window.innerHeight - ph;
    popup.style.left = newLeft + 'px';
    popup.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (isDragging) {
      isDragging = false;
      if (popup) {
        popup.classList.remove('ytx-translate-dragging');
        updateMaxHeight();
      }
    }
  });

  // ── 固定/取消固定 ─────────────────────────────────────
  function togglePin() {
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

  // ── textarea 自适应高度 ───────────────────────────────
  function autoResizeTextarea(el) {
    el.style.height = 'auto';
    var h = Math.min(el.scrollHeight, 150);
    el.style.height = h + 'px';
  }

  // ── 手动翻译按钮 ─────────────────────────────────────
  function handleSubmit() {
    if (isTranslating) return;
    var textarea = popup && popup.querySelector('.ytx-translate-source-textarea');
    if (!textarea) return;
    var text = textarea.value.trim();
    if (!text) return;
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
    if (!popup || !selectionRect) return;

    var pw = 520;
    var margin = 10;

    var left = selectionRect.left;
    if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
    if (left < margin) left = margin;

    var top = selectionRect.bottom + 8;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    // 清除之前手动 resize 设定的固定 height，让弹窗自适应内容
    popup.style.height = '';

    updateMaxHeight();

    requestAnimationFrame(function () {
      if (!popup) return;
      var pr = popup.getBoundingClientRect();
      if (pr.bottom > window.innerHeight - margin) {
        var newTop = selectionRect.top - pr.height - 8;
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
    if (maxH < 200) maxH = 200;
    popup.style.maxHeight = maxH + 'px';
  }

  // ── 复制文本 ──────────────────────────────────────────
  function copyText(text, btn) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(function () {
      var orig = btn.innerHTML;
      btn.innerHTML = SVG_CHECK;
      btn.classList.add('ytx-copied');
      setTimeout(function () {
        btn.innerHTML = orig;
        btn.classList.remove('ytx-copied');
      }, 1500);
    }).catch(function () {});
  }

  // ── 更新状态指示 ──────────────────────────────────────
  function setStatus(text, done) {
    var el = popup && popup.querySelector('.ytx-translate-status');
    if (!el) return;
    if (done) el.classList.add('done');
    else el.classList.remove('done');
    el.innerHTML = '<span class="ytx-translate-status-dot"></span>' + escapeHtml(text);
  }

  function updateFooter(provider, model) {
    var el = popup && popup.querySelector('.ytx-translate-footer-text');
    if (!el) return;
    var name = { claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini' }[provider] || provider;
    el.textContent = 'Powered by ' + name + (model ? ' ' + model : '');
  }

  function showError(msg) {
    ensureElements();
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
    setStatus('Error', true);
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
    hideIcon();
    if (popup) popup.style.display = 'none';
    isTranslating = false;
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

  // ── 消息监听 ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'TRANSLATE_MODEL') {
      currentModel = msg.model || '';
      updateFooter(msg.provider, msg.model);
    }

    if (msg.type === 'TRANSLATE_CHUNK') {
      resultText += msg.text;
      var body = popup && popup.querySelector('.ytx-translate-result-text');
      if (body) {
        removeCursor();
        body.innerHTML = renderMarkdown(resultText);
        addCursor();
        var content = popup.querySelector('.ytx-translate-content');
        if (content) content.scrollTop = content.scrollHeight;
      }
    }

    if (msg.type === 'TRANSLATE_DONE') {
      isTranslating = false;
      removeCursor();
      // 最终渲染
      var bodyDone = popup && popup.querySelector('.ytx-translate-result-text');
      if (bodyDone) bodyDone.innerHTML = renderMarkdown(resultText);
      setStatus('Translated', true);
      setTranslating(false);
      if (icon) {
        icon.textContent = '译';
        icon.classList.remove('ytx-translate-loading');
      }
    }

    if (msg.type === 'TRANSLATE_ERROR') {
      isTranslating = false;
      removeCursor();
      var body = popup && popup.querySelector('.ytx-translate-result-text');
      if (body) {
        body.textContent = msg.error || '翻译失败';
        body.classList.add('ytx-translate-error');
      }
      setStatus('Error', true);
      setTranslating(false);
      if (icon) {
        icon.textContent = '译';
        icon.classList.remove('ytx-translate-loading');
      }
    }
  });

  // ── 关闭逻辑（固定时点外部不关闭）────────────────────
  document.addEventListener('mousedown', function (e) {
    if (icon && icon.contains(e.target)) return;
    if (popup && popup.contains(e.target)) return;

    if (popup && popup.style.display === 'flex') {
      if (!isPinned) hideAll();
      // 固定时不关闭
    } else {
      hideIcon();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideAll();
  });
})();
