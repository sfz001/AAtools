// 鼠标手势：右键按住拖动触发（Mac 触控板：左下角=右键 后按住滑动）
// ← 后退   → 前进   ↓ 滚到底   ↑ 滚到顶   ↓→ 关闭   ←↑ 恢复   ↑↓ 强制刷新
(function () {
  'use strict';
  if (window.top !== window) return;

  const MIN_SEGMENT = 30;
  const MIN_GESTURE = 30;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const isMac = /Mac|iPhone|iPod|iPad/i.test(platform);
  const lifecycle = new AbortController();
  const captureOptions = { capture: true, signal: lifecycle.signal };

  // 设置读取成功前 fail closed；默认保留原生右键菜单。
  let enabled = false;
  let keepMenu = true;
  let disposed = false;
  let tracking = false;
  let lastRawPoint = null;
  let segmentAnchor = null;
  let wheelAccumX = 0;
  let wheelAccumY = 0;
  let directions = [];
  let totalMoved = 0;
  let suppressContext = false;
  let suppressTimer = null;
  let feedbackTimer = null;
  let actionGeneration = 0;
  let indicator = null;

  function sendGestureRequest(type) {
    return Promise.resolve(chrome.runtime.sendMessage({ type: type })).then((response) => {
      if (!response || response.ok !== true) {
        throw new Error(response && typeof response.error === 'string'
          ? response.error
          : '浏览器未能完成手势操作');
      }
      return response;
    });
  }

  const GESTURES = {
    'L':  { label: '← 后退',          run: () => history.back() },
    'R':  { label: '→ 前进',          run: () => history.forward() },
    'U':  { label: '↑ 滚动到顶部',     run: () => window.scrollTo({ top: 0, behavior: 'auto' }) },
    'D':  { label: '↓ 滚动到底部',     run: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }) },
    'DR': { label: '↓→ 关闭标签页',    run: () => sendGestureRequest('GESTURE_CLOSE_TAB') },
    'LU': { label: '←↑ 恢复关闭页',    run: () => sendGestureRequest('GESTURE_REOPEN_TAB') },
    'UD': { label: '↑↓ 强制刷新',      run: () => sendGestureRequest('GESTURE_RELOAD_HARD') },
  };

  function isAAToolsUiEvent(e) {
    let path = [];
    try { path = typeof e.composedPath === 'function' ? e.composedPath() : []; } catch (_) {}
    if (!path.length && e.target) path = [e.target];
    return path.some((node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.id === 'ytx-panel-host') return true;
      try {
        return (node.tagName === 'DIV' &&
          node.getAttribute('data-aatools-ui') === 'translate') ||
          node.hasAttribute('data-aatools-gesture-indicator');
      } catch (_) {
        return false;
      }
    });
  }

  function dirOf(dx, dy) {
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
  }

  function clearSuppressTimer() {
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = null;
  }

  function releaseContextSoon() {
    clearSuppressTimer();
    suppressTimer = setTimeout(() => {
      suppressTimer = null;
      suppressContext = false;
    }, 250);
  }

  function ensureIndicator() {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.setAttribute('data-aatools-gesture-indicator', '');
      indicator.style.cssText = [
        'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
        'background:rgba(20,20,20,0.82)', 'color:#fff',
        'padding:10px 18px', 'border-radius:10px',
        'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        'z-index:2147483647', 'pointer-events:none', 'user-select:none',
        'box-shadow:0 6px 20px rgba(0,0,0,0.3)', 'display:none',
      ].join(';');
    }
    if (!indicator.isConnected) (document.body || document.documentElement).appendChild(indicator);
    return indicator;
  }

  function showIndicator(text, matched) {
    const el = ensureIndicator();
    el.textContent = text;
    el.style.background = 'rgba(20,20,20,0.82)';
    el.style.opacity = matched ? '1' : '0.7';
    el.style.display = 'block';
  }

  function showActionError(error, generation) {
    if (disposed || tracking || generation !== actionGeneration) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    const message = String(error && error.message ? error.message : error || '操作失败').slice(0, 200);
    const el = ensureIndicator();
    el.textContent = '操作失败：' + message;
    el.style.background = 'rgba(153,27,27,0.94)';
    el.style.opacity = '1';
    el.style.display = 'block';
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      if (!tracking && generation === actionGeneration) hideIndicator();
    }, 1800);
  }

  function hideIndicator() {
    if (indicator) indicator.style.display = 'none';
  }

  function resetTracking(options) {
    const opts = options || {};
    tracking = false;
    lastRawPoint = null;
    segmentAnchor = null;
    wheelAccumX = 0;
    wheelAccumY = 0;
    directions = [];
    totalMoved = 0;
    hideIndicator();
    if (opts.releaseContext) {
      suppressContext = false;
      clearSuppressTimer();
    }
  }

  function addDirection(direction) {
    if (directions[directions.length - 1] !== direction) directions.push(direction);
    const key = directions.join('');
    const gesture = GESTURES[key];
    showIndicator(
      gesture ? gesture.label : '手势 ' + key.split('').map(c => ({ L: '←', R: '→', U: '↑', D: '↓' }[c])).join(''),
      !!gesture
    );
    // 只有形成真实方向段后，保留菜单模式才开始抑制 contextmenu。
    suppressContext = true;
  }

  function beginTracking(e) {
    if (disposed || !enabled || !e.isTrusted || e.button !== 2 || isAAToolsUiEvent(e)) return;

    // Mac：Shift 翻转“保留菜单”行为。
    if (isMac && keepMenu !== e.shiftKey) {
      suppressContext = false;
      clearSuppressTimer();
      return;
    }

    clearSuppressTimer();
    actionGeneration++;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = null;
    tracking = true;
    lastRawPoint = { x: e.clientX, y: e.clientY };
    segmentAnchor = { x: e.clientX, y: e.clientY };
    wheelAccumX = 0;
    wheelAccumY = 0;
    directions = [];
    totalMoved = 0;
    suppressContext = !keepMenu || isMac;
  }

  function trackMouse(e) {
    if (!tracking || disposed || !e.isTrusted) return;
    // mouseup 丢在窗口外时，下一次移动可据 buttons 自愈。
    if ((e.buttons & 2) === 0) {
      resetTracking({ releaseContext: keepMenu });
      return;
    }

    const rawDx = e.clientX - lastRawPoint.x;
    const rawDy = e.clientY - lastRawPoint.y;
    totalMoved += Math.hypot(rawDx, rawDy);
    lastRawPoint = { x: e.clientX, y: e.clientY };

    const segmentDx = e.clientX - segmentAnchor.x;
    const segmentDy = e.clientY - segmentAnchor.y;
    if (Math.abs(segmentDx) < MIN_SEGMENT && Math.abs(segmentDy) < MIN_SEGMENT) return;

    addDirection(dirOf(segmentDx, segmentDy));
    segmentAnchor = { x: e.clientX, y: e.clientY };
  }

  function trackWheel(e) {
    if (!tracking || disposed || !enabled || !e.isTrusted) return;

    e.preventDefault();
    const dx = -e.deltaX;
    const dy = -e.deltaY;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.01) return;

    totalMoved += distance;
    wheelAccumX += dx;
    wheelAccumY += dy;
    if (Math.abs(wheelAccumX) < MIN_SEGMENT && Math.abs(wheelAccumY) < MIN_SEGMENT) return;

    addDirection(dirOf(wheelAccumX, wheelAccumY));
    wheelAccumX = 0;
    wheelAccumY = 0;
  }

  function finishTracking(e) {
    if (!tracking || disposed || e.button !== 2 || !e.isTrusted) return;

    const key = directions.join('');
    const gesture = GESTURES[key];
    const validGesture = enabled && totalMoved >= MIN_GESTURE && directions.length > 0 && !!gesture;

    tracking = false;
    hideIndicator();
    lastRawPoint = null;
    segmentAnchor = null;
    wheelAccumX = 0;
    wheelAccumY = 0;
    directions = [];
    totalMoved = 0;

    if (!validGesture) {
      // 空方向、过短或未匹配序列都不吞保留模式的菜单。
      if (keepMenu) {
        suppressContext = false;
        clearSuppressTimer();
      } else {
        suppressContext = true;
        releaseContextSoon();
      }
      return;
    }

    suppressContext = true;
    releaseContextSoon();
    const generation = actionGeneration;
    try {
      const result = gesture.run();
      if (result && typeof result.catch === 'function') {
        result.catch((error) => showActionError(error, generation));
      }
    } catch (error) {
      showActionError(error, generation);
    }
  }

  function handleContextMenu(e) {
    if (disposed || !enabled || !e.isTrusted || isAAToolsUiEvent(e)) return;
    if (isMac && keepMenu !== e.shiftKey) return;
    if (suppressContext) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function handleStorageChanged(changes, area) {
    if (disposed || area !== 'sync') return;
    if (changes.enableGestures) {
      enabled = changes.enableGestures.newValue !== false;
      if (!enabled) resetTracking({ releaseContext: true });
    }
    if (changes.gestureKeepMenu) {
      keepMenu = changes.gestureKeepMenu.newValue !== false;
      if (keepMenu && !tracking) {
        suppressContext = false;
        clearSuppressTimer();
      }
    }
  }

  function loadSettings() {
    if (disposed) return;
    enabled = false;
    try {
      chrome.storage.sync.get(['enableGestures', 'gestureKeepMenu'], (data) => {
        if (disposed) return;
        let runtimeError;
        try { runtimeError = chrome.runtime.lastError; } catch (_) { return; }
        if (runtimeError || !data) return;
        keepMenu = data.gestureKeepMenu !== false;
        enabled = data.enableGestures !== false;
        if (!enabled) resetTracking({ releaseContext: true });
      });
    } catch (_) {
      enabled = false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    resetTracking({ releaseContext: true });
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = null;
    lifecycle.abort();
    try { chrome.storage.onChanged.removeListener(handleStorageChanged); } catch (_) {}
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    indicator = null;
  }

  document.addEventListener('mousedown', beginTracking, captureOptions);
  window.addEventListener('mousemove', trackMouse, captureOptions);
  window.addEventListener('mouseup', finishTracking, captureOptions);
  document.addEventListener('wheel', trackWheel, { passive: false, capture: true, signal: lifecycle.signal });
  document.addEventListener('contextmenu', handleContextMenu, captureOptions);
  window.addEventListener('blur', () => resetTracking({ releaseContext: keepMenu }), { signal: lifecycle.signal });
  window.addEventListener('pointercancel', () => resetTracking({ releaseContext: keepMenu }), captureOptions);
  document.addEventListener('mouseleave', () => resetTracking({ releaseContext: keepMenu }), captureOptions);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetTracking({ releaseContext: keepMenu });
  }, { signal: lifecycle.signal });
  window.addEventListener('pagehide', (e) => {
    resetTracking({ releaseContext: true });
    if (!e.persisted) dispose();
  }, { signal: lifecycle.signal });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) loadSettings();
  }, { signal: lifecycle.signal });

  try { chrome.storage.onChanged.addListener(handleStorageChanged); } catch (_) {}
  loadSettings();
})();
