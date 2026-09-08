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
  //   · macOS / Linux 上 Shift+右键 作为逃生口：放行让原生菜单弹出
  // - keepMenu=true（保留菜单）：
  //   · Windows：contextmenu 在 mouseup 之后触发 → 短按弹菜单、拖动触发手势
  //   · macOS / Linux：contextmenu 在 mousedown 时立即触发 → 普通右键弹菜单、Shift+右键 进手势
  // 总规则：在「contextmenu 于 mousedown 触发」的平台上，Shift 翻转 keepMenu 的行为
  // （XOR）— Shift 状态和 keepMenu 一致即弹菜单。
  // 该行为按平台分：Windows 在 mouseup 之后才派发 contextmenu，其余平台（macOS
  // 与 Linux/X11、Wayland）都在 mousedown 时立即派发，所以判据是「非 Windows」
  // 而不是「是 macOS」，否则 Linux 上 keepMenu=true 完全失效。
  const isWin = /Win/i.test(navigator.platform || '');
  const menuOnDown = !isWin;

  let enabled = true; // 总开关，默认启用，由 storage 决定
  let keepMenu = false; // 是否保留原生右键菜单（默认 false：右键直接走手势）
  let tracking = false;
  let lastPoint = null;
  let directions = [];
  let totalMoved = 0;
  // wheel 手势的跨事件位移累加器（触控板单个事件 delta 很小，必须累加）
  let wheelAccX = 0, wheelAccY = 0;
  let suppressContext = false;
  // 抑制标志的复位定时器：必须共用一个句柄，否则上一次右键排的定时器会在
  // 新一次右键刚设置好标志之后把它清掉，导致该抑制的菜单漏出来
  let suppressTimer = null;
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
        // 关闭时必须一并清掉 suppressContext：否则残留的 true 会让 contextmenu
        // 监听继续吞掉原生右键菜单，直到页面刷新
        if (!enabled) { tracking = false; suppressContext = false; hideIndicator(); }
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
    // 菜单在 mousedown 触发的平台（macOS / Linux）：Shift 与 keepMenu 不一致时
    // 让菜单弹出，不进 tracking
    //   keepMenu=true  + 普通右键   → 弹菜单（默认保留菜单行为）
    //   keepMenu=false + Shift+右键 → 弹菜单（手势模式下的逃生口）
    // Windows：keepMenu=true 时由 mouseup 决定；keepMenu=false 时一律进手势
    // 显式清 suppressContext，防止上一次未拖动的 mouseup 残留的 true 把这次菜单吞掉
    if (menuOnDown && keepMenu !== e.shiftKey) { suppressContext = false; return; }
    tracking = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    directions = [];
    totalMoved = 0;
    wheelAccX = 0;
    wheelAccY = 0;
    // 抑制 contextmenu：keepMenu=false 一律抑制；keepMenu=true 时只有菜单在
    // mousedown 触发的平台需要立即抑制（Windows 等到 mouseup 再决定）
    suppressContext = !keepMenu || menuOnDown;
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

    // 进了 tracking 就一律阻止滚动：用户在做手势，不是在浏览内容。
    // 必须在阈值判断之前，否则未达阈值的那几个事件会让页面照常滚动。
    e.preventDefault();

    const dx = -e.deltaX;
    const dy = -e.deltaY;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    totalMoved += dist;

    // 触控板一次滑动被拆成很多个小 delta 事件，单个事件几乎不可能达到 30px。
    // 必须跨事件累加，累加量达标后记一次方向并清零，否则中速滑动永远不成手势。
    wheelAccX += dx;
    wheelAccY += dy;
    if (Math.abs(wheelAccX) < MIN_SEGMENT && Math.abs(wheelAccY) < MIN_SEGMENT) return;

    const d = dirOf(wheelAccX, wheelAccY);
    wheelAccX = 0;
    wheelAccY = 0;
    if (directions[directions.length - 1] !== d) directions.push(d);

    if (totalMoved < MIN_GESTURE) return;
    const key = directions.join('');
    const g = GESTURES[key];
    showIndicator(g ? g.label : '手势 ' + (key.split('').map(c => ({L:'←',R:'→',U:'↑',D:'↓'}[c])).join('')), !!g);
  }, { passive: false, capture: true });

  document.addEventListener('mouseup', function (e) {
    if (!tracking || e.button !== 2) return;
    if (!e.isTrusted) return;
    tracking = false;
    hideIndicator();

    if (totalMoved < MIN_GESTURE) {
      // 短按（无拖动）：keepMenu=true 时希望菜单弹出
      //   · Windows：suppressContext=false（mousedown 时未抑制）→ 菜单正常弹
      //   · macOS / Linux：mousedown 时已 suppressContext=true → 菜单已被吞，无法补救
      //     （这是 keepMenu 模式下 Shift 短按的代价，可以接受）
      // keepMenu=false 时：suppressContext=true，菜单本就不该弹
      // 但标志必须限时复位：本次 contextmenu 之后若不清掉，后续由 Ctrl+click、
      // Shift+F10、菜单键等非 mousedown 途径唤起的右键菜单会被残留状态误吞。
      if (suppressContext) {
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(function () { suppressContext = false; }, 200);
      }
      return;
    }

    // 有手势：始终抑制 contextmenu（Mac 上 mousedown 时已抑制，这里 idempotent）
    suppressContext = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressContext = false; }, 200);

    const key = directions.join('');
    const g = GESTURES[key];
    if (g) {
      try { g.run(); } catch (_) {}
    }
  }, true);

  document.addEventListener('contextmenu', function (e) {
    if (destroyed) return;
    // 手势总开关关闭后原生菜单必须完全不受影响，不能靠残留标志继续抑制
    if (!enabled) return;
    // 菜单在 mousedown 触发的平台上，Shift 与 keepMenu 不一致时直接放行原生菜单
    //（手势模式的 Shift 逃生口 + 保留菜单模式的默认行为）
    // 直接读 e.shiftKey，不依赖 mousedown 提前设状态——某些情况下 contextmenu 事件顺序可能在 mousedown 前
    if (menuOnDown && keepMenu !== e.shiftKey) return;
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
