// 鼠标手势：右键按住拖动触发（Mac 触控板：左下角=右键 后按住滑动）
// ← 后退   → 前进   ↓ 滚到底   ↑ 滚到顶   ↓→ 关闭   ←↑ 恢复   ↑↓ 强制刷新
(function () {
  'use strict';
  if (window.top !== window) return; // 只在顶层窗口启用，跳过 iframe

  const MIN_SEGMENT = 30; // 单段最小位移（像素）
  const MIN_GESTURE = 8;  // 累计移动超过此值才视为手势（屏蔽误触）

  // contextmenu 抑制策略，由 gestureKeepMenu 设置切换：
  // - keepMenu=false（默认，触控板友好）：右键直接进手势模式，contextmenu 始终抑制
  //   适合 Mac 触控板"左下角=右键"配置，按住 + 滑动即触发手势
  //   · macOS 上 Shift+右键 作为逃生口：放行让原生菜单弹出
  // - keepMenu=true（保留菜单）：
  //   · Windows/Linux：contextmenu 在 mouseup 之后触发 → 短按弹菜单、拖动触发手势
  //   · macOS：contextmenu 在 mousedown 时立即触发 → 普通右键弹菜单、Shift+右键 进手势
  // Mac 上的总规则：Shift 翻转 keepMenu 的行为（XOR）— Shift 状态和 keepMenu 一致即弹菜单
  const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || '');

  let enabled = true; // 总开关，默认启用，由 storage 决定
  let keepMenu = false; // 是否保留原生右键菜单（默认 false：右键直接走手势）
  let tracking = false;
  let lastPoint = null;
  let directions = [];
  let totalMoved = 0;
  let suppressContext = false;
  let indicator = null;

  // ── 代际接管：扩展重载后 background 会重注入本脚本 ──────
  // 新实例广播接管事件（DOM 事件跨 isolated world 传播），旧实例收到后
  // 自我卸载：移除浮层、mousedown 经 destroyed 短路（其余 handler 依赖 tracking）。
  let destroyed = false;
  const GEN_EVENT = 'aatools-takeover-gestures';
  try { document.dispatchEvent(new Event(GEN_EVENT)); } catch (_) {}
  document.addEventListener(GEN_EVENT, () => {
    destroyed = true;
    tracking = false;
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    indicator = null;
  });

  // 启动时读取设置；监听变化实时响应（无需刷新页面）
  try {
    chrome.storage.sync.get(['enableGestures', 'gestureKeepMenu'], (data) => {
      enabled = data.enableGestures !== false;
      keepMenu = !!data.gestureKeepMenu;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enableGestures) {
        enabled = changes.enableGestures.newValue !== false;
        if (!enabled) { tracking = false; hideIndicator(); }
      }
      if (changes.gestureKeepMenu) {
        keepMenu = !!changes.gestureKeepMenu.newValue;
      }
    });
  } catch (_) {}

  const GESTURES = {
    'L':  { label: '← 后退',          run: () => history.back() },
    'R':  { label: '→ 前进',          run: () => history.forward() },
    'U':  { label: '↑ 滚动到顶部',     run: () => window.scrollTo({ top: 0, behavior: 'auto' }) },
    'D':  { label: '↓ 滚动到底部',     run: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' }) },
    'DR': { label: '↓→ 关闭标签页',    run: () => chrome.runtime.sendMessage({ type: 'GESTURE_CLOSE_TAB' }) },
    'LU': { label: '←↑ 恢复关闭页',    run: () => chrome.runtime.sendMessage({ type: 'GESTURE_REOPEN_TAB' }) },
    'UD': { label: '↑↓ 强制刷新',      run: () => chrome.runtime.sendMessage({ type: 'GESTURE_RELOAD_HARD' }) },
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
    if (destroyed) return;
    if (!enabled) return;
    if (!e.isTrusted) return;
    if (e.button !== 2) return;
    // Mac 上 Shift 与 keepMenu 不一致时让菜单弹出（不进 tracking）：
    //   keepMenu=true  + 普通右键   → 弹菜单（默认保留菜单行为）
    //   keepMenu=false + Shift+右键 → 弹菜单（手势模式下的逃生口）
    // 非 Mac：keepMenu=true 时由 mouseup 决定；keepMenu=false 时一律进手势
    // 显式清 suppressContext，防止上一次未拖动的 mouseup 残留的 true 把这次菜单吞掉
    if (isMac && keepMenu !== e.shiftKey) { suppressContext = false; return; }
    tracking = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    directions = [];
    totalMoved = 0;
    // 抑制 contextmenu：keepMenu=false 一律抑制；keepMenu=true 时仅 Mac mousedown 立即抑制（Win/Linux 等 mouseup 决定）
    suppressContext = !keepMenu || isMac;
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

  // macOS 触摸板按住右键 + 另一根手指滑动 → 系统发 wheel 事件而非 mousemove
  // tracking 期间把 wheel 也算成手势位移；deltaX/deltaY 取反以匹配手指物理方向（macOS 自然滚动）
  document.addEventListener('wheel', function (e) {
    if (!tracking) return;
    if (!e.isTrusted) return;
    const dx = -e.deltaX;
    const dy = -e.deltaY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    totalMoved += dist;
    if (Math.abs(dx) < MIN_SEGMENT && Math.abs(dy) < MIN_SEGMENT) return;

    const d = dirOf(dx, dy);
    if (directions[directions.length - 1] !== d) directions.push(d);

    if (totalMoved < MIN_GESTURE) return;
    const key = directions.join('');
    const g = GESTURES[key];
    showIndicator(g ? g.label : '手势 ' + (key.split('').map(c => ({L:'←',R:'→',U:'↑',D:'↓'}[c])).join('')), !!g);

    // 阻止页面同时滚动（用户在做手势，不是在浏览内容）
    e.preventDefault();
  }, { passive: false, capture: true });

  document.addEventListener('mouseup', function (e) {
    if (!tracking || e.button !== 2) return;
    if (!e.isTrusted) return;
    tracking = false;
    hideIndicator();

    if (totalMoved < MIN_GESTURE) {
      // 短按（无拖动）：keepMenu=true 时希望菜单弹出
      //   · Win/Linux：suppressContext=false（mousedown 时未抑制）→ 菜单正常弹
      //   · Mac：mousedown 时已 suppressContext=true → 菜单已被吞，无法补救（这是 keepMenu+Mac 模式 Shift 短按的代价，可以接受）
      // keepMenu=false 时：suppressContext=true，菜单本就不该弹
      return;
    }

    // 有手势：始终抑制 contextmenu（Mac 上 mousedown 时已抑制，这里 idempotent）
    suppressContext = true;
    setTimeout(() => { suppressContext = false; }, 200);

    const key = directions.join('');
    const g = GESTURES[key];
    if (g) {
      try { g.run(); } catch (_) {}
    }
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (destroyed) return;
    // Mac 上 Shift 与 keepMenu 不一致时直接放行原生菜单（手势模式的 Shift 逃生口 + 保留菜单模式的默认行为）
    // 直接读 e.shiftKey，不依赖 mousedown 提前设状态——某些情况下 contextmenu 事件顺序可能在 mousedown 前
    if (isMac && keepMenu !== e.shiftKey) return;
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
