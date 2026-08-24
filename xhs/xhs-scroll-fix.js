// 小红书帖子弹窗滚动修复
(function () {
  'use strict';
  if (!/(^|\.)xiaohongshu\.com$/.test(location.hostname)) return;

  const lifecycle = new AbortController();
  let disposed = false;
  let featureEnabled = false; // 设置读取成功前 fail closed
  let activeWheelSnapshot = null;

  function isVisibleFixedOverlay(el) {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= window.innerWidth * 0.4 || rect.height <= window.innerHeight * 0.4) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const style = getComputedStyle(el);
    return style.position === 'fixed' && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
  }

  function findOverlay(el) {
    while (el && el !== document.documentElement) {
      if (isVisibleFixedOverlay(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function axisCanScroll(el, axis, delta, style) {
    if (!delta) return false;
    if (axis === 'y') {
      if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
      if (el.scrollHeight <= el.clientHeight + 1) return false;
      if (delta < 0) return el.scrollTop > 0;
      return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    }

    if (!/(auto|scroll|overlay)/.test(style.overflowX)) return false;
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    if (delta < 0) return el.scrollLeft > 0;
    return el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  // 从 target 向 overlay 逐层查找真正能消费当前方向 delta 的滚动容器。
  // 内层到边界时继续检查外层，保留浏览器正常的滚动链。
  function findScrollConsumer(target, overlay, deltaX, deltaY) {
    // 对角触控板事件以主轴为准，避免“横向能滚一点、纵向已到边界”时
    // 因次轴可消费而放任主轴穿透到背景。
    const axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
    const delta = axis === 'x' ? deltaX : deltaY;
    if (!delta) return null;
    let el = target && target.nodeType === 1 ? target : target && target.parentElement;
    while (el && overlay.contains(el)) {
      const style = getComputedStyle(el);
      if (axisCanScroll(el, axis, delta, style)) return el;
      if (el === overlay) break;
      el = el.parentElement;
    }
    return null;
  }

  function restoreBackgroundScroll(snapshot) {
    if (!snapshot) return;
    const scroller = snapshot.scroller;
    if (!scroller) return;
    if (scroller.scrollLeft !== snapshot.left) scroller.scrollLeft = snapshot.left;
    if (scroller.scrollTop !== snapshot.top) scroller.scrollTop = snapshot.top;
  }

  function captureWheelBackground(e) {
    if (disposed || !featureEnabled || !e.isTrusted || e.ctrlKey) return;
    const overlay = findOverlay(e.target);
    if (!overlay) return;
    const scroller = document.scrollingElement || document.documentElement || document.body;
    const snapshot = {
      event: e,
      overlay,
      scroller,
      left: Number(scroller?.scrollLeft) || 0,
      top: Number(scroller?.scrollTop) || 0,
      reachedBubble: false,
    };
    activeWheelSnapshot = snapshot;
    // A capture listener may stop propagation before our document-bubble
    // guard. Restore only after the full synchronous dispatch so overlay
    // target handlers retain their normal wheel event. Two microtask turns put
    // this fallback after first-order Promise work queued by page capture or
    // target handlers; rAF also repairs capture handlers that defer to a frame.
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (activeWheelSnapshot !== snapshot) return;
        restoreBackgroundScroll(snapshot);
        requestAnimationFrame(() => {
          if (activeWheelSnapshot !== snapshot) return;
          restoreBackgroundScroll(snapshot);
          if (snapshot.reachedBubble) return;
          // Propagation was stopped before document bubble. A second frame is
          // later than rAF work registered by capture listeners in this frame.
          requestAnimationFrame(() => {
            if (activeWheelSnapshot !== snapshot) return;
            restoreBackgroundScroll(snapshot);
            activeWheelSnapshot = null;
          });
        });
      });
    });
  }

  function handleWheel(e) {
    if (disposed || !featureEnabled || !e.isTrusted || e.ctrlKey) return;
    const overlay = findOverlay(e.target);
    if (!overlay) return;

    // 该监听位于 document bubble 阶段：目标/弹窗内部的 wheel 处理器已运行。
    // document_start 保证本监听先于页面后续注册的同节点监听器；在这里
    // 同时截断后续 document 监听器和 window 冒泡，避免背景级 handler 接管。
    const consumer = findScrollConsumer(e.target, overlay, e.deltaX, e.deltaY);
    e.stopImmediatePropagation();
    if (!consumer) e.preventDefault();
    if (activeWheelSnapshot?.event === e) {
      const snapshot = activeWheelSnapshot;
      snapshot.reachedBubble = true;
      restoreBackgroundScroll(snapshot);
      // This queues after microtasks registered by window/document capture and
      // overlay target handlers. Keep the identity live for the capture-side
      // rAF fallback; a newer wheel replaces it and makes both callbacks no-op.
      queueMicrotask(() => {
        if (activeWheelSnapshot === snapshot) restoreBackgroundScroll(snapshot);
      });
      // Chrome performs microtask checkpoints between event listeners, and
      // capture/target handlers can register rAF before document bubble runs.
      // Registering here makes this the last same-frame restoration.
      requestAnimationFrame(() => {
        if (activeWheelSnapshot !== snapshot) return;
        restoreBackgroundScroll(snapshot);
        activeWheelSnapshot = null;
      });
    }
  }

  function handleStorageChanged(changes, area) {
    if (disposed || area !== 'sync' || !changes.enableXhs) return;
    featureEnabled = changes.enableXhs.newValue !== false;
  }

  function loadSetting() {
    if (disposed) return;
    featureEnabled = false;
    try {
      chrome.storage.sync.get(['enableXhs'], (data) => {
        if (disposed) return;
        let runtimeError;
        try { runtimeError = chrome.runtime.lastError; } catch (_) { return; }
        if (runtimeError || !data) return;
        featureEnabled = data.enableXhs !== false;
      });
    } catch (_) {
      featureEnabled = false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    featureEnabled = false;
    activeWheelSnapshot = null;
    lifecycle.abort();
    try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch (_) {}
  }

  // Capture 阶段只快照背景位置，不截断事件；弹窗内的虚拟列表、缩放和
  // 轮播仍会收到 wheel。Bubble 阶段再恢复页面 capture handler 的背景副作用。
  window.addEventListener('wheel', captureWheelBackground, {
    capture: true,
    passive: true,
    signal: lifecycle.signal,
  });
  document.addEventListener('wheel', handleWheel, { passive: false, signal: lifecycle.signal });
  window.addEventListener('pagehide', (e) => {
    featureEnabled = false;
    if (!e.persisted) dispose();
  }, { signal: lifecycle.signal });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) loadSetting();
  }, { signal: lifecycle.signal });

  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch (_) {}
  loadSetting();
})();
