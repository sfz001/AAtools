// 鼠标手势：右键按住拖动触发
// ← 后退   → 前进   ↓→ 关闭标签页   ←↑ 恢复关闭的标签页
(function () {
  'use strict';
  if (window.top !== window) return; // 只在顶层窗口启用，跳过 iframe

  const MIN_SEGMENT = 30; // 单段最小位移（像素）
  const MIN_GESTURE = 8;  // 累计移动超过此值才视为手势（屏蔽误触）

  let enabled = true; // 总开关，默认启用，由 storage 决定
  let tracking = false;
  let lastPoint = null;
  let directions = [];
  let totalMoved = 0;
  let suppressContext = false;
  let indicator = null;

  // 启动时读取设置；监听变化实时响应（无需刷新页面）
  try {
    chrome.storage.sync.get(['enableGestures'], (data) => {
      enabled = data.enableGestures !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.enableGestures) {
        enabled = changes.enableGestures.newValue !== false;
        if (!enabled) { tracking = false; hideIndicator(); }
      }
    });
  } catch (_) {}

  const GESTURES = {
    'L':  { label: '← 后退',          run: () => history.back() },
    'R':  { label: '→ 前进',          run: () => history.forward() },
    'DR': { label: '↓→ 关闭标签页',    run: () => chrome.runtime.sendMessage({ type: 'GESTURE_CLOSE_TAB' }) },
    'LU': { label: '←↑ 恢复关闭页',    run: () => chrome.runtime.sendMessage({ type: 'GESTURE_REOPEN_TAB' }) },
  };

  function dirOf(dx, dy) {
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
  }

  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'background:rgba(20,20,20,0.82)', 'color:#fff',
      'padding:10px 18px', 'border-radius:10px',
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'z-index:2147483647', 'pointer-events:none', 'user-select:none',
      'box-shadow:0 6px 20px rgba(0,0,0,0.3)', 'display:none',
    ].join(';');
    (document.body || document.documentElement).appendChild(indicator);
    return indicator;
  }

  function showIndicator(text, matched) {
    const el = ensureIndicator();
    el.textContent = text;
    el.style.opacity = matched ? '1' : '0.7';
    el.style.display = 'block';
  }

  function hideIndicator() {
    if (indicator) indicator.style.display = 'none';
  }

  document.addEventListener('mousedown', function (e) {
    if (!enabled) return;
    if (!e.isTrusted) return;
    if (e.button !== 2) return;
    tracking = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    directions = [];
    totalMoved = 0;
    suppressContext = false;
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!tracking) return;
    if (!e.isTrusted) return;
    const dx = e.clientX - lastPoint.x;
    const dy = e.clientY - lastPoint.y;
    const dist = Math.hypot(dx, dy);
    totalMoved += dist;
    if (Math.abs(dx) < MIN_SEGMENT && Math.abs(dy) < MIN_SEGMENT) return;

    const d = dirOf(dx, dy);
    if (directions[directions.length - 1] !== d) directions.push(d);
    lastPoint = { x: e.clientX, y: e.clientY };

    if (totalMoved < MIN_GESTURE) return;
    const key = directions.join('');
    const g = GESTURES[key];
    showIndicator(g ? g.label : '手势 ' + (key.split('').map(c => ({L:'←',R:'→',U:'↑',D:'↓'}[c])).join('')), !!g);
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!tracking || e.button !== 2) return;
    if (!e.isTrusted) return;
    tracking = false;
    hideIndicator();

    if (totalMoved < MIN_GESTURE) return; // 普通右键，放行原生菜单

    suppressContext = true;
    setTimeout(() => { suppressContext = false; }, 200);

    const key = directions.join('');
    const g = GESTURES[key];
    if (g) {
      try { g.run(); } catch (_) {}
    }
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (suppressContext) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 拖出窗口或切窗口时复位
  window.addEventListener('blur', function () {
    tracking = false;
    hideIndicator();
  });
})();
