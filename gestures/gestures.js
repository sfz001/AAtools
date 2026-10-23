// 鼠标手势：右键按住拖动触发（Mac 触控板：左下角=右键 后按住滑动）；双击右键弹原生菜单
// ← 后退   → 前进   ↓ 滚到底   ↑ 滚到顶   ↓→ 关闭   ←↑ 恢复   ↑↓ 强制刷新
(function () {
  'use strict';
  if (window.top !== window) return; // 只在顶层窗口启用，跳过 iframe

  const MIN_SEGMENT = 30; // 单段最小位移（像素）
  const MIN_GESTURE = 8;  // 累计移动超过此值才视为手势（屏蔽误触）
  // 双击右键弹菜单的判定窗口：两次按下的间隔与位置（screen 坐标，不受页面滚动影响）。
  // 500ms 对齐系统双击间隔；手势模式下「原地短按」本身只有想要菜单这一种动机，
  // 所以窗口内紧接的第二次按下被当成手势的歧义极少
  const DOUBLE_CLICK_MS = 500;
  const DOUBLE_CLICK_DIST = 10;

  // contextmenu 策略按平台定，没有设置项：
  // - Windows：Chromium 在 mouseup 之后才派发 contextmenu → mousedown 不抑制，
  //   mouseup 时按位移决定：短按放行原生菜单、拖动出手势并吞掉随后的菜单。
  //   「普通右键弹菜单、拖动出手势」在这里原生可达，不需要双击
  // - macOS / Linux（X11、Wayland 同）：contextmenu 在 mousedown 时立即派发，菜单一旦
  //   弹出页面就收不到后续 mousemove/mouseup，所以右键按下必须立即抑制并进手势模式：
  //   · 双击右键弹原生菜单：短按（无拖动）松开后 DOUBLE_CLICK_MS 内原地再按一次右键，
  //     第二次按下的 contextmenu 放行、不进 tracking。第一次的菜单已被吞且 content
  //     script 没有任何途径事后补弹，这是鼠标用户不按修饰键的唯一出路；Chrome 上的
  //     手势扩展（Smooth Gestures / crxMouse / SimpleMouseGestures 等）在 Mac 上都是这一套
  //   · Shift+右键 作为逃生口：放行让原生菜单弹出，不进 tracking
  // 判据是「非 Windows」而不是「是 macOS」，否则 Linux 上菜单会在每次右键按下时弹出、手势无法开始
  const isWin = /Win/i.test(navigator.platform || '');
  const menuOnDown = !isWin;
  // wheel 手势只对 macOS 触控板有意义（按住右键 + 另一指滑动会发 wheel 而非
  // mousemove），且取反 delta 假设的是 macOS 默认的自然滚动。
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');

  let enabled = true; // 总开关，默认启用，由 storage 决定
  let tracking = false;
  // lastPoint 只作 MIN_SEGMENT 的分段锚点（过阈值才前移）；
  // prevPoint 每次 mousemove 都前移，用来累计真实路径长度
  let lastPoint = null;
  let prevPoint = null;
  let directions = [];
  let totalMoved = 0;
  // wheel 手势的跨事件位移累加器（触控板单个事件 delta 很小，必须累加）
  let wheelAccX = 0, wheelAccY = 0;
  let suppressContext = false;
  // 抑制标志的复位定时器：必须共用一个句柄，否则上一次右键排的定时器会在
  // 新一次右键刚设置好标志之后把它清掉，导致该抑制的菜单漏出来
  let suppressTimer = null;
  // 双击右键的预备状态：被吞掉菜单的短按在 mouseup 记下时间与位置，下一次右键
  // 按下落在窗口内就放行它的原生菜单。只在短按分支设置、在每次右键 mousedown 消费
  let menuArmedAt = 0;
  let menuArmedPoint = null;
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
    stopWheelTracking();
    if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
    indicator = null;
  });

  // 启动时读取设置；监听变化实时响应（无需刷新页面）
  try {
    chrome.storage.sync.get(['enableGestures'], (data) => {
      enabled = data.enableGestures !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enableGestures) {
        enabled = changes.enableGestures.newValue !== false;
        // 关闭时必须一并清掉 suppressContext：否则残留的 true 会让 contextmenu
        // 监听继续吞掉原生右键菜单，直到页面刷新
        if (!enabled) { tracking = false; stopWheelTracking(); suppressContext = false; disarmMenu(); hideIndicator(); }
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

  function armMenu(e) {
    menuArmedAt = e.timeStamp;
    menuArmedPoint = { x: e.screenX, y: e.screenY };
  }
  function disarmMenu() {
    menuArmedAt = 0;
    menuArmedPoint = null;
  }
  // 这次右键按下是否构成「双击右键」：上一次是被吞掉菜单的短按，且这次在时间/距离窗口内。
  // 时间差写成 <= 的肯定形式：timeStamp 异常为 NaN 时比较为 false，宁可不弹菜单也不误放行
  function isDoubleRightClick(e) {
    if (!menuArmedPoint) return false;
    if (!(e.timeStamp - menuArmedAt <= DOUBLE_CLICK_MS)) return false;
    return Math.hypot(e.screenX - menuArmedPoint.x, e.screenY - menuArmedPoint.y) <= DOUBLE_CLICK_DIST;
  }

  function ensureIndicator() {
    if (indicator) return indicator;
    // 直接打开的 .svg / .xml / RSS 是非 HTML 文档，createElement('div') 按规范
    // 返回 null 命名空间的普通 Element，没有 .style，赋值即抛 TypeError；
    // 显式指定 XHTML 命名空间才能拿到 HTMLElement
    indicator = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    indicator.style.cssText = [
      'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'background:rgba(20,20,20,0.82)', 'color:#fff',
      'padding:10px 18px', 'border-radius:10px',
      'font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'z-index:2147483647', 'pointer-events:none', 'user-select:none',
      'box-shadow:0 6px 20px rgba(0,0,0,0.3)', 'display:none',
    ].join(';');
    var host = document.body || document.documentElement;
    if (host && host.appendChild) host.appendChild(indicator);
    return indicator;
  }

  // 浮层只是视觉反馈，任何失败都不能冒泡到 mouseup —— 否则处理器中断，
  // 后面的 g.run() 永远执行不到，手势在这类页面上静默失效
  function showIndicator(text, matched) {
    try {
      const el = ensureIndicator();
      if (!el || !el.style) return;
      el.textContent = text;
      el.style.opacity = matched ? '1' : '0.7';
      el.style.display = 'block';
    } catch (_) {}
  }

  function hideIndicator() {
    try {
      if (indicator && indicator.style) indicator.style.display = 'none';
    } catch (_) {}
  }

  document.addEventListener('mousedown', function (e) {
    if (destroyed) return;
    if (!enabled) return;
    if (!e.isTrusted) return;
    if (e.button !== 2) return;
    // 双击右键：上一次是被吞掉菜单的短按，这次在窗口内原地再按 → 放行这次按下的
    // 原生菜单，不进 tracking。预备状态无论命中与否都消费掉，避免过期预备残留到
    // 很久以后的某次右键。Chromium 先派发 mousedown 再派发 contextmenu，所以这里
    // 清掉 suppressContext（含上一次短按排下的 200ms 复位定时器）即可让菜单通过
    const doubleClick = isDoubleRightClick(e);
    disarmMenu();
    if (doubleClick) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
      suppressContext = false;
      return;
    }
    // 菜单在 mousedown 触发的平台（macOS / Linux）：Shift+右键 是逃生口，放行原生菜单、
    // 不进 tracking。显式清 suppressContext，防止上一次短按残留的 true 把这次菜单吞掉
    if (menuOnDown && e.shiftKey) { suppressContext = false; return; }
    // 上一次手势排下的 200ms 复位定时器必须在这里取消：否则它会在本次右键按住期间
    // 把刚设好的 suppressContext 翻回 false，Mac/Linux 上这次若是短按，mouseup 按
    // suppressContext 判断「菜单是否被吞」就会漏掉双击预备
    clearTimeout(suppressTimer);
    suppressTimer = null;
    tracking = true;
    lastPoint = { x: e.clientX, y: e.clientY };
    prevPoint = { x: e.clientX, y: e.clientY };
    directions = [];
    totalMoved = 0;
    wheelAccX = 0;
    wheelAccY = 0;
    // 抑制 contextmenu：菜单在 mousedown 触发的平台必须立即抑制；Windows 等到 mouseup 再决定
    suppressContext = menuOnDown;
    startWheelTracking();
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!tracking) return;
    if (!e.isTrusted) return;
    // totalMoved 要的是路径长度：必须按「距上一次事件」累加。按「距分段锚点」
    // 累加的话，30px 内的慢速漂移会以 1+2+3+4… 叠加，MIN_GESTURE=8 的有效
    // 阈值被压到 3-4px，指针轻微抖动就被判成手势（Windows 上会吞掉 contextmenu，
    // 用户既无菜单也无动作）。wheel 分支用的正是增量口径。
    totalMoved += Math.hypot(e.clientX - prevPoint.x, e.clientY - prevPoint.y);
    prevPoint = { x: e.clientX, y: e.clientY };

    const dx = e.clientX - lastPoint.x;
    const dy = e.clientY - lastPoint.y;
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
  //
  // 监听按需注册（见 startWheelTracking / stopWheelTracking），不是脚本加载时常驻：
  // · 它只在 tracking 期间需要非 passive（要 preventDefault），常驻一个 <all_urls>
  //   的阻塞型 document 级 wheel 捕获监听会让每段滚动的首个事件等待主线程
  // · 取反 delta 只适配 macOS 自然滚动；Windows/Linux 上每次右键都进 tracking，
  //   按住右键滚一格就会被记成方向相反的手势并吞掉滚动
  function onWheel(e) {
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
  }

  let wheelBound = false;
  function startWheelTracking() {
    if (wheelBound || !isMac) return;
    wheelBound = true;
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  }
  function stopWheelTracking() {
    if (!wheelBound) return;
    wheelBound = false;
    document.removeEventListener('wheel', onWheel, { capture: true });
  }

  document.addEventListener('mouseup', function (e) {
    if (!tracking || e.button !== 2) return;
    if (!e.isTrusted) return;
    tracking = false;
    stopWheelTracking();
    hideIndicator();

    if (totalMoved < MIN_GESTURE) {
      // 短按（无拖动）：
      //   · Windows：suppressContext=false（mousedown 时未抑制）→ 随后的 contextmenu 放行，菜单正常弹
      //   · macOS / Linux：mousedown 时已 suppressContext=true → 这次菜单已被吞，
      //     无法事后补弹，只能预备双击让下一次原地右键放行
      // 标志必须限时复位：本次 contextmenu 之后若不清掉，后续由 Ctrl+click、
      // Shift+F10、菜单键等非 mousedown 途径唤起的右键菜单会被残留状态误吞。
      if (suppressContext) {
        // 菜单被吞掉的短按：预备双击，窗口内原地再按一次右键就放行那次的原生菜单
        armMenu(e);
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(function () { suppressContext = false; }, 200);
      }
      return;
    }

    // 有手势：始终抑制 contextmenu（Mac 上 mousedown 时已抑制，这里 idempotent）。
    // 不预备双击：手势刚结束紧接着的右键应当还是手势，而不是弹菜单
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
    // 菜单在 mousedown 触发的平台上，Shift+右键 直接放行原生菜单（逃生口）。
    // 直接读 e.shiftKey，不依赖 mousedown 提前设状态——某些情况下 contextmenu 事件顺序可能在 mousedown 前
    if (menuOnDown && e.shiftKey) return;
    if (suppressContext) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // 拖出窗口或切窗口时复位
  window.addEventListener('blur', function () {
    tracking = false;
    stopWheelTracking();
    hideIndicator();
  });
})();
