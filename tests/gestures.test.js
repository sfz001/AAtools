'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'gestures', 'gestures.js'), 'utf8');

// 把 gestures.js 跑在一个假 DOM 里：document 只记录/派发监听，定时器走虚拟时钟，
// 事件的 timeStamp 与虚拟时钟一致。返回 fire() 驱动事件序列，用返回事件的
// defaultPrevented 判断原生菜单是否被吞。
function loadGestures({ platform = 'MacIntel', settings = {} } = {}) {
  const listeners = new Map();
  const timers = [];
  let timerId = 0;
  let now = 0;
  const calls = { back: 0, forward: 0, messages: [] };

  function runTimersUntil(at) {
    for (;;) {
      const due = timers.filter(t => t.due <= at).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = due.due;
      due.fn();
    }
    now = at;
  }

  const document = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      for (const fn of (listeners.get(ev.type) || []).slice()) fn(ev);
      return true;
    },
    createElementNS() { return { style: {}, textContent: '', parentNode: null }; },
    body: { appendChild(el) { el.parentNode = this; } },
    documentElement: { scrollHeight: 1000 },
  };

  const sandbox = {
    navigator: { platform },
    document,
    history: { back() { calls.back++; }, forward() { calls.forward++; } },
    scrollTo() {},
    addEventListener() {},
    chrome: {
      storage: {
        sync: { get(keys, cb) { cb(settings); } },
        onChanged: { addListener() {} },
      },
      runtime: { sendMessage(msg) { calls.messages.push(msg); } },
    },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout(fn, ms) { const id = ++timerId; timers.push({ id, fn, due: now + ms }); return id; },
    clearTimeout(id) { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    console,
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'gestures.js' });

  function fire(type, props = {}) {
    if (props.at != null) runTimersUntil(props.at);
    const x = props.x != null ? props.x : 0;
    const y = props.y != null ? props.y : 0;
    const ev = {
      type, isTrusted: true, button: 2, shiftKey: false,
      clientX: x, clientY: y, screenX: x, screenY: y, deltaX: 0, deltaY: 0,
      timeStamp: now, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...props,
    };
    document.dispatchEvent(ev);
    return ev;
  }

  return { fire, calls, listenerCount: type => (listeners.get(type) || []).length };
}

// macOS / Linux：contextmenu 紧随 mousedown 派发
function press(g, at, x, y, extra = {}) {
  g.fire('mousedown', { at, x, y, ...extra });
  return g.fire('contextmenu', { at, x, y, ...extra });
}
function release(g, at, x, y) {
  g.fire('mouseup', { at, x, y });
}

test('Mac 手势模式：单击右键吞菜单，0.5s 内原地再按一次放行第二次的原生菜单且不进 tracking', () => {
  const g = loadGestures({ platform: 'MacIntel' });
  const first = press(g, 1000, 100, 100);
  assert.equal(first.defaultPrevented, true, '第一次按下的菜单被吞');
  release(g, 1080, 101, 100);

  const second = press(g, 1300, 103, 102);
  assert.equal(second.defaultPrevented, false, '双击的第二次按下放行原生菜单');

  // 菜单打开期间即使页面还收到拖动/松开，也不能被当成手势执行
  g.fire('mousemove', { at: 1350, x: 20, y: 102 });
  release(g, 1400, 20, 102);
  assert.equal(g.calls.back, 0);
  assert.equal(g.listenerCount('wheel'), 0, '放行菜单的按下不挂 wheel 监听');

  // 预备状态已消费：之后的普通右键拖动仍是手势
  const third = press(g, 2000, 300, 100);
  assert.equal(third.defaultPrevented, true);
  g.fire('mousemove', { at: 2050, x: 250, y: 100 });
  release(g, 2100, 250, 100);
  assert.equal(g.calls.back, 1, '← 后退正常触发');
});

test('Mac 手势模式：超过 500ms 的第二次按下仍是手势模式，但它自己会重新预备', () => {
  const g = loadGestures({ platform: 'MacIntel' });
  press(g, 1000, 100, 100);
  release(g, 1050, 100, 100);

  const late = press(g, 1050 + 600, 100, 100);
  assert.equal(late.defaultPrevented, true, '窗口已过期，菜单继续被吞');
  release(g, 1050 + 650, 100, 100);

  const quick = press(g, 1050 + 650 + 300, 100, 100);
  assert.equal(quick.defaultPrevented, false, '过期的那次短按重新预备，紧接的再按放行');
});

test('Mac 手势模式：第二次按下移动超过 10px 不算双击', () => {
  const g = loadGestures({ platform: 'MacIntel' });
  press(g, 1000, 100, 100);
  release(g, 1050, 100, 100);
  const far = press(g, 1200, 130, 100);
  assert.equal(far.defaultPrevented, true);
});

test('Mac 手势模式：完成手势后紧接的右键不弹菜单（手势松开不预备双击）', () => {
  const g = loadGestures({ platform: 'MacIntel' });
  press(g, 1000, 200, 100);
  g.fire('mousemove', { at: 1040, x: 150, y: 100 });
  release(g, 1100, 150, 100);
  assert.equal(g.calls.back, 1);

  const next = press(g, 1300, 150, 100);
  assert.equal(next.defaultPrevented, true, '手势后紧接的右键仍是手势模式');
});

test('Mac 手势模式：Shift+右键 逃生口不受影响，且不污染双击预备', () => {
  const g = loadGestures({ platform: 'MacIntel' });
  const shift = press(g, 1000, 100, 100, { shiftKey: true });
  assert.equal(shift.defaultPrevented, false, 'Shift+右键 直接放行原生菜单');
  release(g, 1050, 100, 100);

  const plain = press(g, 1200, 100, 100);
  assert.equal(plain.defaultPrevented, true, 'Shift 短按不预备，紧接的普通右键仍被吞');
});

test('Linux 与 Mac 同策略：右键按下即吞菜单，双击右键放行，Shift+右键 逃生', () => {
  const g = loadGestures({ platform: 'Linux x86_64' });
  const first = press(g, 1000, 100, 100);
  assert.equal(first.defaultPrevented, true);
  release(g, 1050, 100, 100);
  const second = press(g, 1300, 100, 100);
  assert.equal(second.defaultPrevented, false, '双击的第二次放行');
  assert.equal(g.listenerCount('wheel'), 0, 'Linux 不挂 wheel 监听');

  const shift = press(g, 3000, 100, 100, { shiftKey: true });
  assert.equal(shift.defaultPrevented, false, 'Shift+右键 逃生口');
});

test('总开关关闭：右键完全不被接管', () => {
  const g = loadGestures({ platform: 'MacIntel', settings: { enableGestures: false } });
  const ev = press(g, 1000, 100, 100);
  assert.equal(ev.defaultPrevented, false);
  release(g, 1050, 100, 100);
  g.fire('mousemove', { at: 1100, x: 20, y: 100 });
  assert.equal(g.calls.back, 0);
});

test('Windows：contextmenu 在 mouseup 后派发，短按直接弹原生菜单，拖动出手势并吞掉随后的菜单', () => {
  const g = loadGestures({ platform: 'Win32' });
  g.fire('mousedown', { at: 1000, x: 100, y: 100 });
  g.fire('mouseup', { at: 1060, x: 100, y: 100 });
  const short = g.fire('contextmenu', { at: 1062, x: 100, y: 100 });
  assert.equal(short.defaultPrevented, false, '单击右键原生菜单照常弹，不需要双击');
  assert.equal(g.listenerCount('wheel'), 0, 'Windows 不挂 wheel 监听');

  g.fire('mousedown', { at: 2000, x: 300, y: 100 });
  g.fire('mousemove', { at: 2040, x: 250, y: 100 });
  g.fire('mouseup', { at: 2100, x: 250, y: 100 });
  const afterGesture = g.fire('contextmenu', { at: 2102, x: 250, y: 100 });
  assert.equal(g.calls.back, 1);
  assert.equal(afterGesture.defaultPrevented, true, '手势后紧随的菜单被吞');
});

test('Windows：手势后 200ms 复位窗口内的短按仍正常弹菜单', () => {
  const g = loadGestures({ platform: 'Win32' });
  g.fire('mousedown', { at: 1000, x: 300, y: 100 });
  g.fire('mousemove', { at: 1040, x: 250, y: 100 });
  g.fire('mouseup', { at: 1100, x: 250, y: 100 });
  g.fire('contextmenu', { at: 1102, x: 250, y: 100 });

  g.fire('mousedown', { at: 1150, x: 250, y: 100 });
  g.fire('mouseup', { at: 1200, x: 250, y: 100 });
  const short = g.fire('contextmenu', { at: 1202, x: 250, y: 100 });
  assert.equal(short.defaultPrevented, false);
});
