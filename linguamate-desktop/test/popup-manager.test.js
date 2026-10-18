const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createPopupManager,
  computePopupPosition,
  parseForegroundRect,
  POPUP_WIDTH,
  POPUP_MAX_HEIGHT,
  POPUP_MIN_HEIGHT,
  GUTTER,
  ABOVE_GAP,
} = require('../src/popup-manager');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };   // 典型 1080p 工作区

// 扫源码的断言必须先剥掉注释。
//
// 注释里出现的名字是**说明**，不是调用点。6B 的文件头注释为了强调「绝不自动
// 截图」提了一句 captureScreenRegion()，结果把「真调用点只有一个」数成了 2。
// 与其把注释改写得刚好躲过正则，不如让断言看真正的代码。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // 前面不是冒号，免得把 'http://localhost' 的 // 当成行注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ============================================================ 前台矩形解析

test('前台矩形：正常输出能解出四个边', () => {
  const rect = parseForegroundRect('LMFG\t100\t50\t1200\t700\n');
  assert.deepEqual(rect, { left: 100, top: 50, right: 1200, bottom: 700, width: 1100, height: 650 });
});

test('前台矩形：附加的 stdout 行不干扰', () => {
  const rect = parseForegroundRect('Windows PowerShell\r\nLMFG\t10\t20\t30\t40\r\nPS C:\\> ');
  assert.equal(rect.width, 20);
  assert.equal(rect.height, 20);
});

test('前台矩形：窗口最小化 / 退化时返回 null，不拿它当锚点', () => {
  // 右<=左、下<=上：窗口不可用，用它定位会把弹窗甩到屏幕外
  assert.equal(parseForegroundRect('LMFG\t0\t0\t0\t0'), null);
  assert.equal(parseForegroundRect('LMFG\t500\t300\t500\t700'), null);
});

test('前台矩形：缺行 / 非法数字都返回 null（调用方退到光标定位）', () => {
  assert.equal(parseForegroundRect(''), null);
  assert.equal(parseForegroundRect('no marker here'), null);
  assert.equal(parseForegroundRect('LMFG\ta\tb\tc\td'), null);
});

test('前台矩形：字段里有非数字就整条作废（锚点用垃圾数据比没有锚点更糟）', () => {
  assert.equal(parseForegroundRect('LMFG\t10\t20\t110\t220\textra'), null);
  // 字段数不够也要作废，否则 right/bottom 变成 NaN
  assert.equal(parseForegroundRect('LMFG\t10\t20\t110'), null);
});

// ============================================================ 定位几何

test('划词定位：水平居中于当前应用窗口，垂直在窗口顶部上方', () => {
  const fg = { left: 300, top: 500, right: 1300, bottom: 900, width: 1000, height: 400 };
  const p = computePopupPosition({
    mode: 'selection', foregroundRect: fg, cursorPoint: null,
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: WA,
  });
  assert.equal(p.x, 300 + (1000 - POPUP_WIDTH) / 2, '水平居中于前台窗口');
  assert.equal(p.y, 500 - ABOVE_GAP - 300, '窗口顶部上方 24px');
  assert.ok(p.y >= 0 && p.x >= 0);
});

test('划词定位：窗口顶到屏幕上沿时翻到窗口下方，绝不出屏', () => {
  const fg = { left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 };
  const p = computePopupPosition({
    mode: 'selection', foregroundRect: fg, cursorPoint: null,
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: WA,
  });
  assert.ok(p.y >= WA.y, '不得为负');
  assert.equal(p.y, ABOVE_GAP, '翻到窗口下方');
});

test('划词定位：拿不到前台矩形时退到光标，不返回 null 也不崩', () => {
  const p = computePopupPosition({
    mode: 'selection', foregroundRect: null, cursorPoint: { x: 500, y: 400 },
    popupWidth: POPUP_WIDTH, popupHeight: 200, workArea: WA,
  });
  assert.equal(p.x, 500 + GUTTER);
  assert.equal(p.y, 400 + GUTTER);
});

test('截图定位：光标右下 16px', () => {
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 700, y: 500 },
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: WA,
  });
  assert.equal(p.x, 700 + GUTTER);
  assert.equal(p.y, 500 + GUTTER);
});

test('边缘 clamp：光标在右下角时弹窗被拉回屏内', () => {
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 1919, y: 1039 },
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: WA,
  });
  assert.equal(p.x + POPUP_WIDTH, WA.width, '右边缘贴齐，不得越界');
  assert.equal(p.y + 300, WA.height, '下边缘贴齐，不得越界');
});

test('边缘 clamp：光标在左上角时不得为负', () => {
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 0, y: 0 },
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: WA,
  });
  assert.ok(p.x >= 0, 'x 不得为负');
  assert.ok(p.y >= 0, 'y 不得为负');
  assert.equal(p.x, 0 + GUTTER, '留 16px 边距，不贴死屏幕边');
  assert.equal(p.y, 0 + GUTTER);
});

test('边缘 clamp：多显示器时以目标屏 workArea 为准，而不是主屏 0 起点', () => {
  // 第二块屏在主屏右边，x 起点非 0
  const wa2 = { x: 1920, y: 0, width: 2560, height: 1400 };
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 2500, y: 700 },
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: wa2,
  });
  assert.ok(p.x >= wa2.x && p.x + POPUP_WIDTH <= wa2.x + wa2.width, '必须留在第二块屏内');
  assert.ok(p.y >= wa2.y && p.y + 300 <= wa2.y + wa2.height);
});

test('边缘 clamp：工作区比弹窗还小时不得产生负坐标或越界值', () => {
  const tiny = { x: 0, y: 0, width: 200, height: 100 };
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 50, y: 50 },
    popupWidth: POPUP_WIDTH, popupHeight: 300, workArea: tiny,
  });
  assert.equal(p.x, tiny.x);
  assert.equal(p.y, tiny.y);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('弹窗比工作区高时（超长译文）底部仍被 clamp', () => {
  const p = computePopupPosition({
    mode: 'screenshot', foregroundRect: null, cursorPoint: { x: 100, y: 900 },
    popupWidth: POPUP_WIDTH, popupHeight: 2000, workArea: WA,
  });
  assert.ok(p.y >= WA.y, '不得为负——左上角始终锚在屏内');
  assert.ok(Number.isFinite(p.y) && Number.isFinite(p.x));
  assert.equal(p.y, WA.y, '装不下时退到工作区顶部，而不是算出一个离屏坐标');
});

// ============================================================ 单例与生命周期

// 假 Electron：只实现 popup-manager 真正用到的那几个方法
//
// 关键：**invoke 和 send 必须是两条独立的通道**。
// 早先把 handle/on 塞进同一个 map，测试又在 win.webContents 上模拟「渲染层发消息」，
// 而生产代码当时恰恰把 popup:copy 挂在了 webContents 上——测试的模拟方式和错误实现
// 是镜像的，于是 [复制] 明明收不到消息，测试却是绿的。真实端到端点击才暴露出来。
// 现在唯一能表达「渲染层 send」的入口是 ipcMain.sendFromRenderer()，
// 它只投递到 ipcMain.on 注册过的 handler，webContents 上的监听器收不到。
function fakeElectron() {
  const { EventEmitter } = require('node:events');
  const created = [];
  const invokeHandlers = new Map();   // ipcMain.handle —— 只服务 ipcRenderer.invoke
  const sendHandlers = new Map();     // ipcMain.on    —— 只服务 ipcRenderer.send
  const copied = [];
  let bound = { x: 0, y: 0, width: POPUP_WIDTH, height: POPUP_MIN_HEIGHT };
  let shown = 0;
  let visible = false;
  let focused = false;

  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      // 主进程 → 渲染层（webContents.send）。渲染层**发不到**这里。
      this.webContents.send = (ch, payload) => this.webContents.emit(ch, { sender: this.webContents }, payload);
      this.webContents.setWindowOpenHandler = () => {};
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height };
      created.push(this);
    }
    setMenu() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(next) { this.bounds = { ...this.bounds, ...next }; }
    setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return visible; }
    // show() 抢焦点，showInactive() 不抢。Esc 能不能用完全取决于这个差别。
    show() { visible = true; shown += 1; focused = true; }
    showInactive() { visible = true; shown += 1; }
    async loadFile() {}
    destroy() {
      this.destroyed = true;
      visible = false;
      this.emit('closed');
    }
  }

  const ipcMain = {
    handle(ch, fn) { invokeHandlers.set(ch, fn); },
    removeHandler(ch) { invokeHandlers.delete(ch); },
    on(ch, fn) { sendHandlers.set(ch, fn); },
    removeAllListeners(ch) { sendHandlers.delete(ch); },
    // 渲染层唯一的发送入口
    sendFromRenderer(ch, event, payload) {
      const fn = sendHandlers.get(ch);
      if (!fn) throw new Error(`ipcMain 没有 ${ch} 的 on 监听（渲染层 send 收不到）`);
      return fn(event, payload);
    },
    invokeFromRenderer(ch, event) {
      const fn = invokeHandlers.get(ch);
      if (!fn) throw new Error(`ipcMain 没有 ${ch} 的 handle（渲染层 invoke 收不到）`);
      return fn(event);
    },
    // 只读，用来断言「注册在哪个事件源上」
    channels() {
      return { invoke: [...invokeHandlers.keys()], send: [...sendHandlers.keys()] };
    },
    has(channel) { return invokeHandlers.has(channel) || sendHandlers.has(channel); },
  };

  const screen = {
    getPrimaryDisplay: () => ({ workArea: WA }),
    getDisplayNearestPoint: () => ({ workArea: WA }),
  };

  return {
    BrowserWindow: FakeWindow, screen, ipcMain, created, copied,
    invokeHandlers, sendHandlers,
    shownCount: () => shown,
    isVisible: () => visible,
    hasFocus: () => focused,
    setVisible: (v) => { visible = v; },
    writeClipboard: (t) => { copied.push(t); return true; },
  };
}

function makeManager(overrides = {}) {
  const fx = fakeElectron();
  const mgr = createPopupManager({
    BrowserWindow: fx.BrowserWindow,
    screen: fx.screen,
    ipcMain: fx.ipcMain,
    getCursorPoint: () => ({ x: 600, y: 400 }),
    readForeground: async () => ({ left: 300, top: 200, right: 1300, bottom: 800, width: 1000, height: 600 }),
    writeClipboard: fx.writeClipboard,
    ...overrides,
  });
  return { mgr, fx };
}

test('弹窗参数：必须可聚焦（Esc 的前提）、不得进任务栏、必须无边框置顶', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello', translation: '你好' });
  const o = fx.created[0].opts;
  // focusable:true 是 2026-09-30 用户点头换来的：Esc 要能用，窗口必须能拿到焦点。
  // 代价（抢焦点、打断原应用）写在 src/popup-manager.js 文件头。
  assert.equal(o.focusable, true, 'focusable:false 时键盘事件根本进不来，Esc 必然无效');
  assert.equal(o.frame, false);
  assert.equal(o.skipTaskbar, true);
  assert.equal(o.alwaysOnTop, true);
  assert.equal(o.resizable, false);
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.transparent, true);
  mgr.dispose();
});

test('初始数据用 invoke 拉而不是 push——loadFile 后立刻 send 会丢事件', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'abc', translation: '甲乙丙' });
  const got = await fx.ipcMain.invokeFromRenderer('popup:getData', {});
  assert.equal(got.translation, '甲乙丙');
  assert.equal(got.sourceText, 'abc');
  assert.equal(got.mode, 'selection');
  mgr.dispose();
});

test('[重试]：点它必须走 ipcMain.on，且回调拿到的是**主进程自己的 payload**', async () => {
  // 不传原文是刻意的：渲染层把原文回传一遍，等于让用户选中的文本在渲染进程里
  // 多走一程；主进程本来就有 payload，直接给它。
  const seen = [];
  const { mgr, fx } = makeManager({ onRetry: (p) => seen.push(p) });
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello world', translation: '' });
  assert.equal(fx.ipcMain.channels().send.includes('popup:retry'), true, '必须注册在 ipcMain.on 上');
  fx.ipcMain.sendFromRenderer('popup:retry', { sender: fx.created[0].webContents });
  assert.equal(seen.length, 1, '回调应被调用一次');
  assert.equal(seen[0].sourceText, 'hello world', '拿到的是当前弹窗的 payload');
  mgr.dispose();
});

test('[重试]：外来 sender 一律拒绝（否则悬浮窗能让主进程翻它指定的内容）', async () => {
  let called = 0;
  const { mgr, fx } = makeManager({ onRetry: () => { called += 1; } });
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello' });
  fx.ipcMain.sendFromRenderer('popup:retry', { sender: { id: 999 } });   // 别人的 webContents
  assert.equal(called, 0, '别人的窗口点重试必须无效');
  fx.ipcMain.sendFromRenderer('popup:retry', { sender: fx.created[0].webContents });
  assert.equal(called, 1, '自己窗口的重试仍然可用');
  mgr.dispose();
});

test('[重试]：没接 onRetry 时也不该崩（只是没反应）', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello' });
  fx.ipcMain.sendFromRenderer('popup:retry', { sender: fx.created[0].webContents });
  mgr.dispose();
});

test('dispose：retry 通道也要一起摘掉，不能留在 ipcMain 上', async () => {
  const { mgr, fx } = makeManager({ onRetry: () => { throw new Error('dispose 之后不该再被调用'); } });
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello' });
  const sender = fx.created[0].webContents;
  mgr.dispose();
  assert.deepEqual(fx.ipcMain.channels().send, [], 'send 侧通道应全部清空');
  assert.deepEqual(fx.ipcMain.channels().invoke, [], 'invoke 侧通道应全部清空');
  assert.throws(() => fx.ipcMain.sendFromRenderer('popup:retry', { sender }));
});

test('单例：连续触发只留最新一个，旧弹窗被销毁', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: '第一条' });
  await mgr.showTranslationPopup({ mode: 'selection', translation: '第二条' });
  assert.equal(fx.created.length, 2, '确实建了两个');
  assert.equal(fx.created[0].isDestroyed(), true, '第一个必须被销毁');
  assert.equal(fx.created[1].isDestroyed(), false);
  const got = await fx.ipcMain.invokeFromRenderer('popup:getData', {});
  assert.equal(got.translation, '第二条', '留下的是最新的');
  mgr.dispose();
});

test('单例：并发触发（不等前一次建完）也只留最新一个，旧窗口必须被销毁', async () => {
  // 回归：2026-10-18 用户报「没按 Ctrl+C 也弹出划词面板，且卡在「正在读取…」关不掉」。
  // 真实触发是**并发**的——语音输入法一轮写两次剪贴板，两次触发间隔约 500ms，
  // 而建窗要 await readForeground()（一次 PowerShell，~300ms）才往下走。
  // 两次调用于是交错：都先跑过 destroy()，再各自建一个窗，后一个把 win 的引用覆盖掉。
  // 被覆盖的那个窗口**还在屏幕上**，但 isOwnSender 会拒掉它发来的 popup:close，
  // 于是点 [×] / 按 Esc 都没有任何反应——这正是「关不掉」。
  // 顺序 await 的那个单例测试抓不到这个：它两次调用根本不会交错。
  const { mgr, fx } = makeManager({
    // 建窗前那段 await 用可控闸门制造交错
    readForeground: () => new Promise((resolve) => { gates.push(resolve); }),
  });
  const gates = [];

  const first = mgr.showTranslationPopup({ mode: 'selection', translation: '第一条' });
  const second = mgr.showTranslationPopup({ mode: 'selection', translation: '第二条' });

  // 放行两次 readForeground，两次调用在 await 处交错后继续
  assert.equal(gates.length, 2, '两次调用都进入了 await readForeground');
  gates[0]();
  gates[1]();
  await Promise.all([first, second]);

  const alive = fx.created.filter((w) => !w.isDestroyed());
  assert.equal(alive.length, 1, `同一时刻只允许一个弹窗在屏幕上，实际有 ${alive.length} 个`);
  mgr.dispose();
});

test('关不掉回归：孤儿窗口若存在，[×] 与 Esc 都必须还能把它关掉', async () => {
  // 上一条修的是「别产生孤儿」。这一条守的是**万一还是产生了**的兜底：
  // 屏幕上任何一个还活着的弹窗，用户点 [×] 必须能关掉它。
  // isOwnSender 只认「当前那一个」，一旦引用错位，屏幕上的窗口就成了关不掉的死面板。
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: '第一条' });
  const orphan = fx.created[0];

  // 模拟引用错位：又来一次触发，win 指向了新窗口
  await mgr.showTranslationPopup({ mode: 'selection', translation: '第二条' });
  const current = fx.created[1];

  // 无论引用指向谁，destroy 都得把**所有**活着的窗口收掉
  mgr.close();
  assert.equal(orphan.isDestroyed(), true, '屏幕上那个窗口必须被销毁，不能留在那儿');
  assert.equal(current.isDestroyed(), true);
});

test('update 能把「识别中…」推成「译文」而不重建窗口', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'screenshot', status: '识别中…' });
  const win = fx.created[0];
  const seen = [];
  win.webContents.on('popup:data', (_e, p) => seen.push(p.translation || p.status));
  mgr.update({ translation: '识别结果', status: '完成' });
  assert.equal(win.isDestroyed(), false, '更新不应重建窗口');
  assert.deepEqual(seen, ['识别结果'], '内容已推送');
  mgr.dispose();
});

test('渲染层回报高度后按新高度定位，且只在此时显示一次', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  assert.equal(fx.isVisible(), false, 'loadFile 后不该先亮出来，避免闪');
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: fx.created[0].webContents }, { height: 300 });
  assert.equal(fx.created[0].bounds.height, 300);
  assert.equal(fx.isVisible(), true);
  assert.equal(fx.shownCount(), 1);
  mgr.dispose();
});

test('渲染层回报高度：超界夹到 [120,520]，不采信任意高度', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  const h = (e, p) => fx.ipcMain.sendFromRenderer('popup:resized', e, p);
  h({ sender: fx.created[0].webContents }, { height: 9999 });
  assert.equal(fx.created[0].bounds.height, POPUP_MAX_HEIGHT);
  h({ sender: fx.created[0].webContents }, { height: 3 });
  assert.equal(fx.created[0].bounds.height, POPUP_MIN_HEIGHT);
  h({ sender: fx.created[0].webContents }, { height: 'not a number' });
  assert.equal(fx.created[0].bounds.height, POPUP_MIN_HEIGHT, '非法高度不得被采信');
  mgr.dispose();
});

test('渲染层回报高度：非本窗口的 sender 一律拒绝', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: { id: 'other' } }, { height: 400 });
  assert.notEqual(fx.created[0].bounds.height, 400, '别的窗口不能改我的尺寸');
  mgr.dispose();
});

test('[复制] 只在显式点击时写剪贴板，且写的是译文', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: '原文', translation: '译文正文' });
  assert.equal(fx.copied.length, 0, '显示弹窗本身绝不能写剪贴板');
  fx.ipcMain.sendFromRenderer('popup:copy', { sender: fx.created[0].webContents }, '译文正文');
  assert.deepEqual(fx.copied, ['译文正文']);
  mgr.dispose();
});

test('[复制] 空字符串不写', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: '' });
  fx.ipcMain.sendFromRenderer('popup:copy', { sender: fx.created[0].webContents }, '');
  fx.created[0].webContents.emit('popup:copy', { sender: fx.created[0].webContents }, null);
  assert.equal(fx.copied.length, 0);
  mgr.dispose();
});

test('[×] 关闭后弹窗真的被销毁', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  assert.equal(mgr.isOpen, true);
  fx.ipcMain.sendFromRenderer('popup:close', { sender: fx.created[0].webContents });
  assert.equal(fx.created[0].isDestroyed(), true);
  assert.equal(mgr.isOpen, false);
  mgr.dispose();
});

test('[复制] 外来 sender 一律拒绝——否则别的窗口能让本应用写剪贴板', async () => {
  // 「剪贴板只在用户显式点 [复制] 时写」是硬约束。任何能发 IPC 的窗口
  // （比如悬浮窗）都能伪造 popup:copy 来白嫖写剪贴板，这条必须锁死。
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: '译文正文' });
  fx.ipcMain.sendFromRenderer('popup:copy', { sender: { id: 'floater' } }, '偷偷写进去');
  assert.equal(fx.copied.length, 0, '别的窗口不能让本应用写剪贴板');
  // 自己窗口的仍然要能写，否则这条校验写死了功能
  fx.ipcMain.sendFromRenderer('popup:copy', { sender: fx.created[0].webContents }, '译文正文');
  assert.deepEqual(fx.copied, ['译文正文']);
  mgr.dispose();
});

test('[×] 外来 sender 不能关掉别人的弹窗', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  fx.ipcMain.sendFromRenderer('popup:close', { sender: { id: 'floater' } });
  assert.equal(mgr.isOpen, true, '别的窗口关不掉弹窗');
  mgr.dispose();
});

test('回归：渲染层→主进程的通道必须注册在 ipcMain，不是 win.webContents', () => {
  // 2026-09-29 端到端实测踩到：popup:copy / popup:close 挂在 win.webContents.on 上，
  // 而 ipcRenderer.send 的消息只到 ipcMain —— [复制] 没反应、[×] 关不掉，且**没有任何报错**。
  // 更糟的是当时的单测在 webContents 上模拟发消息，与错误实现是镜像的，测试全绿。
  const { mgr, fx } = makeManager();
  const ch = fx.ipcMain.channels();
  for (const c of ['popup:resized', 'popup:copy', 'popup:close']) {
    assert.ok(ch.send.includes(c), `${c} 必须用 ipcMain.on（配 ipcRenderer.send）`);
    assert.equal(ch.invoke.includes(c), false, `${c} 不得用 ipcMain.handle（那只服务 invoke）`);
  }
  assert.ok(ch.invoke.includes('popup:getData'), 'popup:getData 用 handle（配 invoke）');
  mgr.dispose();

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
  for (const c of ['popup:copy', 'popup:close']) {
    assert.equal(
      new RegExp(`webContents\\.on\\('${c}'`).test(src),
      false,
      `${c} 不得挂在 webContents 上——渲染层 send 收不到`,
    );
  }
});

test('取前台矩形失败时用光标定位，弹窗照常出', async () => {
  const { mgr, fx } = makeManager({ readForeground: async () => null });
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: fx.created[0].webContents }, { height: 200 });
  assert.equal(fx.created[0].bounds.x, 600 + GUTTER, '退到光标右下');
  assert.equal(mgr.isOpen, true, '不能因为读不到矩形就不弹');
  mgr.dispose();
});

test('dispose 后拒绝再弹窗，并清掉 IPC handler', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' });
  mgr.dispose();
  assert.equal(mgr.isOpen, false);
  assert.equal(fx.ipcMain.channels().invoke.length + fx.ipcMain.channels().send.length, 0,
    'handler 必须摘掉，否则重复 bootstrap 会抛');
  assert.equal(await mgr.showTranslationPopup({ mode: 'selection', translation: 'y' }), null);
});

test('非 Windows 平台直接返回 null，不建窗口', async () => {
  const { mgr, fx } = makeManager();
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  try {
    assert.equal(await mgr.showTranslationPopup({ mode: 'selection', translation: 'x' }), null);
    assert.equal(fx.created.length, 0);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
  mgr.dispose();
});

// ============================================================ 前端资源

test('弹窗资源齐备且 preload 用的是 popup 专用那一份', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
  assert.match(src, /preload-popup\.js/, '必须用 preload-popup.js，不能蹭 renderer 的 preload');
  for (const f of ['index.html', 'popup.js', 'styles.css']) {
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', 'popup', f)),
      `popup/${f} 必须存在，否则 loadFile 会失败`,
    );
  }
});

test('弹窗 HTML 有 CSP，且不引入任何远程脚本', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.equal(/https?:\/\/(?!localhost)/.test(html), false, '不得引用任何远程资源');
});

test('package.json 的 build.files 收进了 popup/**，否则打包后 loadFile 会找不到', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('popup/**/*'), 'popup/**/* 必须进 files');
});

test('Esc 关闭（一半）：弹窗显示时必须真的拿到焦点，否则键盘事件根本进不来', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello', translation: '你好' });
  // 渲染层回报高度的那一刻才显示（主进程要按内容高度定好位再亮相）
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: fx.created[0].webContents }, { height: 134 });
  assert.equal(fx.isVisible(), true, '弹窗应该已经显示');
  // 变异：把 show() 换回 showInactive()，这里就会红——那正是 Esc 无效的根因
  assert.equal(fx.hasFocus(), true, '必须用 show() 抢焦点；showInactive() 拿不到键盘事件');
});

test('Esc 关闭（另一半）：渲染层真的把 Escape 接到 close 上', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  // 先剥注释：文件头就写着「Esc 关不掉」这类说明，不剥会误判成已经实现
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = code.match(/addEventListener\(\s*'keydown',\s*\(\w+\)\s*=>\s*\{([\s\S]*?)\n\}\);/);
  assert.ok(m, '必须注册 keydown 监听——Esc 全靠它');

  // 把 handler 真跑起来，而不是只检查它「存在」：
  // 写成 keydown 监听但条件写反、或忘了调 close，这类错都能被抓到。
  let prevented = 0;
  const closed = [];
  const handler = new Function('event', 'api', m[1]);
  const api = { close: () => closed.push('close') };

  handler({ key: 'Escape', preventDefault: () => { prevented += 1; } }, api);
  assert.deepEqual(closed, ['close'], '按 Esc 必须真的发出关闭');
  assert.equal(prevented, 1, 'Esc 应当被 preventDefault');

  for (const key of ['a', 'Enter', 'Tab']) {
    handler({ key, preventDefault: () => {} }, api);
  }
  assert.equal(closed.length, 1, '非 Esc 的按键绝不能关闭弹窗');
});

test('点弹窗以外的地方就关：失焦即销毁（Windows 上点别处就是换焦点）', async () => {
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello', translation: '你好' });
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: fx.created[0].webContents }, { height: 134 });
  assert.equal(fx.isVisible(), true, '先确认弹窗确实显示了');
  const w = fx.created[0];
  w.emit('blur');
  assert.equal(w.isDestroyed(), true, '失焦必须销毁弹窗——否则它会一直赖在屏幕上，用户只能去瞄准 [×]');
  assert.equal(mgr.isOpen, false);
  mgr.dispose();
});

test('回归：显示之前不得挂 blur——建窗到亮相之间的焦点事件不代表用户不要了', async () => {
  // 变异：把 win.once("blur", ...) 挪回建窗处，这里第一句就会红
  const { mgr, fx } = makeManager();
  await mgr.showTranslationPopup({ mode: 'selection', sourceText: 'hello', translation: '你好' });
  fx.created[0].emit('blur');
  assert.equal(fx.created[0].isDestroyed(), false, '还没显示时收到 blur 不得销毁弹窗');
  fx.ipcMain.sendFromRenderer('popup:resized', { sender: fx.created[0].webContents }, { height: 134 });
  fx.created[0].emit('blur');
  assert.equal(fx.created[0].isDestroyed(), true, '显示之后再 blur 才关');
  mgr.dispose();
});

test('[重试] 点它不得把原文回传给主进程（原文已经在主进程手里了）', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  assert.match(js, /api\.retry\(\s*\)/, '必须是 api.retry()，不带任何参数');

  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload-popup.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.send\('popup:retry'\s*\)/, 'preload 侧也必须是无参 send');

  const html = fs.readFileSync(path.join(__dirname, '..', 'popup', 'index.html'), 'utf8');
  assert.match(html, /id="retry"/, '必须有这个按钮');
});

test('[重试] 的显隐规则：由 retryable 决定，不能靠「有没有原文」猜', () => {
  // 真正要验的是**表达式本身的行为**，不是它长什么样。所以把表达式取出来
  // 当函数跑：换掉实现（写成 el.retry.hidden = true，或 = !translation）这里就会红。
  const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  const m = js.match(/el\.retry\.hidden = ([^;]+);/);
  assert.ok(m, '必须显式控制 [重试] 的显隐');
  const fn = new Function('source', 'translation', 'data', `return ${m[1]}`);

  // 划词翻译失败：重发的是同一段内存里的文本，该给
  assert.equal(
    Boolean(fn('hello world', '', { error: '翻译服务异常' })), false, '有原文就该能重试',
  );
  // ⭐ 截图 OCR 挂掉时**压根还没有原文**——旧规则按「有没有原文」判，会把这个
  //   最需要重试的场景判成「不该给」。重试在这里是重发同一张图，用户不必重新框选。
  assert.equal(
    Boolean(fn('', '', { error: '识别失败', retryable: true })), false,
    '没有原文但 retryable:true（截图 OCR 失败）时必须能重试',
  );
  // 主进程显式说「重发这张没意义」时不给
  assert.equal(
    Boolean(fn('', '', { error: '未识别到文字', retryable: false })), true,
    'retryable:false 时必须隐藏',
  );
  assert.equal(
    Boolean(fn('hello', '', { error: '此内容无法读取', retryable: false })), true,
    '「读不到内容」重试多少次都一样，必须隐藏',
  );
  // 正在翻译 / 已经成功：没有「重试」的语义，不该冒出来
  assert.equal(Boolean(fn('hello', '', { status: '正在翻译…' })), true, '翻译中不该显示 [重试]');
  assert.equal(Boolean(fn('hello', '译文', { status: '完成' })), true, '成功后不该显示 [重试]');
});

test('[截图翻译] 只在主进程点名要它时才出现，渲染层自己不会去截图', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  const m = js.match(/el\.screenshot\.hidden = ([^;]+);/);
  assert.ok(m, '必须显式控制 [截图翻译] 的显隐');
  const fn = new Function('data', `return ${m[1]}`);

  // 划词读不到内容 → 主进程给 action:'screenshot'，这是唯一该出现它的场景
  assert.equal(Boolean(fn({ error: '此内容无法读取', action: 'screenshot' })), false, '点了要有用');
  // 正常划词成功时绝不能冒出来
  assert.equal(Boolean(fn({ sourceText: 'hello', translation: '你好' })), true, '成功时不该出现');
  // 截图进行中也不该出现（截图自己的失败态才给）
  assert.equal(Boolean(fn({ status: '正在识别…' })), true, '识别中不该出现');

  // 渲染层拿不到任何截图能力——这是「绝不自动截图」在结构上的保证
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload-popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'popup', 'index.html'), 'utf8');
  assert.match(html, /id="screenshot"/, '必须有这个按钮');
  assert.match(js, /api\.screenshot\(\)/, '点它只转发一次点击');
  assert.match(preload, /ipcRenderer\.send\('popup:screenshot'\)/, '走 ipcMain.send');
  assert.equal(/captureScreenRegion|desktopCapturer/.test(js), false, '渲染层绝不许碰截图能力');
  assert.equal(/captureScreenRegion|desktopCapturer/.test(preload), false, 'preload 也不许碰');
});

test('[截图翻译] 通道必须注册在 ipcMain.on 上，且 dispose 时一起摘掉', async () => {
  let clicked = 0;
  const { mgr, fx } = makeManager({ onScreenshot: () => { clicked += 1; } });
  assert.equal(fx.ipcMain.channels().send.includes('popup:screenshot'), true, '必须注册在 ipcMain.on 上');
  // 别的窗口冒用同一个通道
  fx.ipcMain.sendFromRenderer('popup:screenshot', { sender: { id: 999 } });
  assert.equal(clicked, 0, '别人的 webContents 必须被挡住');

  await mgr.showTranslationPopup({ mode: 'selection', sourceText: '', status: '无法读取' });
  fx.ipcMain.sendFromRenderer('popup:screenshot', { sender: fx.created[0].webContents });
  assert.equal(clicked, 1, '本窗口的点击要转出去');
  mgr.dispose();

  assert.throws(() => fx.ipcMain.sendFromRenderer('popup:screenshot', { sender: fx.created[0].webContents }));
});

test('main.js 步骤 6B：截图链路只被显式触发，绝无自动入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const i = src.indexOf('步骤 6B：截图翻译串接');
  assert.ok(i > 0, '应能定位到步骤 6B 那一段');
  // 剥掉注释：注释里为了强调约束会提到这些名字，那不是调用点
  const section = stripComments(src.slice(i));

  // captureScreenRegion 只允许在 handleScreenshotTranslate 里出现一次。
  // 绝不能被划词失败之类的分支自动调用。
  const callers = [...section.matchAll(/captureScreenRegion\(\)/g)].length;
  assert.equal(callers, 1, `captureScreenRegion 只应在 handleScreenshotTranslate 里出现一次，实际 ${callers}`);

  // 每个 handleScreenshotTranslate 的调用点都必须挂在**一次用户动作**上。
  // 合法入口只有四类：全局热键、托盘菜单 click、弹窗 [截图翻译]、弹窗 [重试]。
  // 任何「读不到内容就自动补拍一截图」的分支都会在这里被抓出来。
  //
  // 刻意扫**整个文件**而不是 6B 那一段：入口是故意分散的——托盘菜单在
  // buildTrayMenu，[重试] 在 handlePopupRetry（6A 段里），热键在 bootstrap 末尾。
  // 按 6B 切片去数只能数到 2 个，看起来像少入口，其实是把范围划错了。
  const whole = stripComments(src);
  const defIdx2 = whole.indexOf('async function handleScreenshotTranslate');
  const callSites = [...whole.matchAll(/handleScreenshotTranslate\(\)/g)]
    .map((m) => m.index)
    .filter((idx) => idx !== defIdx2 + 'async function '.length);
  assert.equal(callSites.length, 4, `应恰好四个用户入口（热键/托盘/[截图翻译]/[重试]），实际 ${callSites.length}`);
  for (const idx of callSites) {
    const before = whole.slice(Math.max(0, idx - 200), idx);
    assert.match(
      before,
      /(click:|handler:|function handlePopup(Retry|Screenshot)\s*\([^)]*\)\s*\{)/,
      `有个 handleScreenshotTranslate 调用点不在任何用户动作处理器里：…${before.slice(-90)}`,
    );
  }
  assert.match(section, /function handlePopupScreenshot\(\) \{\s*void handleScreenshotTranslate\(\);/,
    '[截图翻译] 按钮只转发点击，不夹带任何自动逻辑');

  // 「读不到内容」那条路径只给按钮，绝不在背地里截图
  const unreadable = stripComments(src.slice(
    src.indexOf('function handleSelectionUnreadable'),
    src.indexOf('function handleSelectionCaptured'),
  ));
  assert.equal(/captureScreenRegion|handleScreenshotTranslate/.test(unreadable), false,
    '划词读不到内容时绝不许自动去截图');
  assert.match(unreadable, /action: 'screenshot'/, '应该给用户一个 [截图翻译] 按钮');
  assert.match(unreadable, /retryable: false/, '「读不到内容」重试无意义，必须显式标掉');
});

test('main.js 步骤 6B：截图只在内存里，日志绝不带内容', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const raw = src.slice(src.indexOf('步骤 6B：截图翻译串接'));
  const section = stripComments(raw);
  // 没有任何落盘调用
  assert.equal(/writeFileSync|createWriteStream|appendFileSync/.test(section), false, '截图链路不得写盘');
  // saveDebugShot 明确不注入（注释里会提到它，所以看剥完的代码）
  assert.equal(/saveDebugShot\s*[:=]/.test(section), false, '生产路径绝不注入 saveDebugShot（截图永不落盘）');
  // base64 不进日志
  assert.equal(/logger\([^)]*pngBase64/.test(section), false, 'base64 绝不能进日志');

  // 埋点只许出现长度/计数/状态，不许出现内容变量
  const calls = section.match(/logScreenshotMeta\([^;]*?\);/g) || [];
  assert.ok(calls.length >= 5, `应有多处埋点，实际 ${calls.length}`);
  for (const c of calls) {
    const rest = c
      .replace(/ocrText\.length/g, 'LEN')
      .replace(/\(result\.translation \|\| ''\)\.length/g, 'LEN');
    for (const forbidden of ['ocrText', 'body', 'translation', 'sourceText', 'pngBase64']) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`).test(rest),
        false,
        `埋点里出现了内容变量 ${forbidden}：${c}`,
      );
    }
  }
  assert.match(section, /chars: ocrText\.length/, '应记录识别字符数而不是识别内容');
  assert.match(section, /outLen: \(result\.translation \|\| ''\)\.length/, '应记录译文长度而不是译文');
});

test('main.js 步骤 6B：划词与截图共用同一个操作号，慢请求不得覆盖新结果', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // 两段链路都必须用同一个 popupOpId。用两个计数器的话，「串结果」这个 bug
  // 只是从划词内部挪到了划词↔截图之间，并没有消失。
  assert.equal(/selectionOpId/.test(src), false, '不得存在划词专属的操作号');
  const bumps = [...src.matchAll(/\+\+popupOpId/g)].length;
  assert.equal(bumps, 3, `划词、截图捕获、OCR 翻译三处都要自增，实际 ${bumps}`);
  // 每一处 await 之后都要重新核对归属
  const guards = [...src.matchAll(/if \(myOp !== popupOpId\) return;/g)].length;
  assert.ok(guards >= 5, `每个 await 之后都要核对归属，实际只有 ${guards} 处`);
});

test('main.js 步骤 6B：图里没字要报「未识别到文字」，不得掉进通用 5xx', () => {
  // 端到端实测踩到的：框一块纯白区域，腾讯返的是 502 +
  // FailedOperation.ImageNoText，**不是**「200 但段落为空」。只判空段落的话，
  // 这一档会掉进通用 5xx 分支，弹窗显示「OCR 服务异常，可重试」——而能重试的
  // 是同一张图，重试一百次结果一样，用户只能一直点。
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'));
  const fn = src.slice(src.indexOf('function describeOcrError'));
  const noText = fn.indexOf("'FailedOperation.ImageNoText'");
  const generic5xx = fn.indexOf('status >= 500');
  assert.ok(noText !== -1, '必须显式处理 FailedOperation.ImageNoText');
  assert.ok(noText < generic5xx,
    'ImageNoText 必须排在通用 5xx **之前**，否则永远轮不到它');

  // 那一档给的是「换一块区域」，不是「重试同一张图」
  const branch = fn.slice(noText, fn.indexOf('}', fn.indexOf('action:', noText)) + 1);
  assert.match(branch, /status: '未识别到文字'/, '状态文案必须是「未识别到文字」');
  assert.match(branch, /retryable: false/, '重发同一张图必然同样失败，不得标成可重试');
  assert.match(branch, /action: 'screenshot'/, '必须给 [截图翻译] 让用户换一块区域');

  // action 得真的透传到弹窗，否则按钮永远不出现
  assert.match(src, /popupManager\.update\(\{[^}]*action: info\.action[^}]*\}\)/,
    'OCR 错误分支必须把 action 一起 update 给弹窗');
});

test('main.js：追加热键的函数里绝不能出现 unregister', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const i = src.indexOf('function registerExtraShortcuts');
  assert.ok(i > 0, '应能定位到 registerExtraShortcuts');
  const body = src.slice(i, src.indexOf('function createFloater'));
  // registerShortcut 开头的 unregisterAll() 会清空系统里所有已注册快捷键，
  // 复用它或在本函数里 unregister，用户的 Ctrl+Shift+L 录音就会失效。
  assert.equal(/unregister/.test(body), false,
    '追加注册路径里出现 unregister，会连带清掉录音快捷键');
  assert.match(body, /globalShortcut\.register\(/, '应该直接用 register（本身即追加语义）');
  // 而且必须排在 registerShortcut 之后调用，否则会被它开头的 unregisterAll 清掉
  const boot = src.slice(src.indexOf('async function bootstrap'));
  assert.ok(
    boot.indexOf('registerShortcut(accelerator)') < boot.indexOf('registerExtraShortcuts('),
    '追加注册必须排在 registerShortcut 之后，否则会被 unregisterAll 清掉',
  );
});


test('main.js 划词链路：只读剪贴板，绝不写', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const section = src.slice(src.indexOf('步骤 6A：划词翻译串接'), src.indexOf('function buildTrayIcon'));
  assert.ok(section.length > 500, '应能定位到步骤 6A 那一段');
  assert.equal(/clipboard\.write(Text|Image|HTML|Buffer)/.test(section), false, '划词链路不得写剪贴板');
  assert.match(section, /readText: \(\) => clipboard\.readText\(\)/, '只允许读');
});

test('main.js 的 [重试] 不得重读剪贴板（会翻译到用户后来复制的另一段内容）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function handlePopupRetry'), src.indexOf('/**', src.indexOf('function handlePopupRetry')));
  assert.ok(fn.length > 100, '应能定位到 handlePopupRetry');
  assert.equal(/clipboard/.test(fn), false, '重试只重发内存里的 payload，不得碰剪贴板');
  assert.match(fn, /payload\.sourceText/, '必须用弹窗自己的 payload.sourceText');
});

test('main.js 的诊断日志绝不带原文和译文（只许长度、状态、耗时、操作号）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const section = src.slice(src.indexOf('步骤 6A：划词翻译串接'), src.indexOf('function buildTrayIcon'));
  const calls = section.match(/logSelectionMeta\([^;]*?\);/g) || [];
  assert.ok(calls.length >= 4, `应有多处埋点，实际 ${calls.length}`);

  // 先把**允许**的两个取值形式删掉，剩下的里再不许出现内容变量名。
  // 直接对原串做否定匹配是不够的：写 "text: body }" 时 body 后面跟的是 } 不是逗号，
  // 朴素正则会漏过去（真的踩到了：改成 logSelectionMeta('captured', { text: body })
  // 之后测试照样是绿的）。
  for (const c of calls) {
    const rest = c
      .replace(/body\.length/g, 'LEN')
      .replace(/\(result\.translation \|\| ''\)\.length/g, 'LEN');
    for (const forbidden of ['body', 'translation', 'sourceText', 'payload.text']) {
      assert.equal(
        new RegExp(`\\b${forbidden.replace('.', '\\.')}\\b`).test(rest),
        false,
        `埋点里出现了内容变量 ${forbidden}：${c}`,
      );
    }
  }
  assert.match(section, /len: body\.length/, '应记录原文长度而不是原文');
  assert.match(section, /outLen: \(result\.translation \|\| ''\)\.length/, '应记录译文长度而不是译文');
});

test('[复制] 只在有译文时出现', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
  assert.match(js, /el\.copy\.hidden = !translation/, '[复制] 只在有译文时出现');
});

test('回归：原文区不得被 flex 压扁后把文字画到译文上（2026-09-29 截图实测）', () => {
  // .source 曾是 flex:0 1 auto + min-height:0：内容一多 flex 真的把它压矮，
  // 而 .source-text 仍按自然高度绘制、.source 没有 overflow:hidden，
  // 于是原文第三行画到盒子外面，正好盖住译文第一行。单测看不见，只有截图能看见。
  //
  // **必须先剥掉注释再断言**：这段 CSS 里就有解释 bug 的注释，注释里字面写着
  // "flex:0 0 auto" 和 "min-height:0"，不剥注释的话正则会匹配到注释文本，
  // 测试在写错的代码上照样全绿（真的踩到了）。
  const raw = fs.readFileSync(path.join(__dirname, '..', 'popup', 'styles.css'), 'utf8');
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(css.includes('曾经写成'), false, '注释应已剥净');

  const source = css.slice(css.indexOf('.source {'), css.indexOf('.source-label'));
  assert.match(source, /flex:\s*0\s+0\s+auto/, '原文区必须不参与压缩');
  assert.match(source, /overflow:\s*hidden/, '必须裁剪，杜绝画到盒子外');

  // 压缩必须由译文区吸收——它有 min-height:0 + overflow-y:auto，才能真的滚
  const result = css.slice(css.indexOf('.result {'), css.indexOf('.translation {'));
  assert.match(result, /flex:\s*1\s+1\s+auto/, '译文区要能伸缩');
  assert.match(result, /overflow-y:\s*auto/, '译文区必须能滚动');
  assert.match(result, /min-height:\s*0/, '没有 min-height:0 就压不动，弹窗会被撑破 520 上限');
});

// ============================================================ 前台矩形的真实调用

test('回归：脚本必须在子进程启动时仍然存在（finally 提前删目录）', async () => {
  // 步骤 3 在 selection-reader.js 上踩过：return new Promise 写在 try{}finally{} 里时，
  // finally 会在 execFile 回调之前执行，脚本先被删掉，PowerShell 打不开它，
  // 表现是「永远返回 null」而不是任何报错。这里锁死。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
  const fn = src.slice(src.indexOf('function readForegroundRect'), src.indexOf('function clamp'));
  assert.equal(/\}\s*finally\s*\{/.test(fn), false, '不得用 finally 清理——它会早于回调执行');
  assert.match(fn, /\(err, stdout\) => \{[\s\S]*rmSync/, '必须在 execFile 回调里删目录');
});

test('回归：脚本纯 ASCII 落盘（PowerShell 5.1 按 GBK 读无 BOM 文件会吃掉换行）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
  const m = src.match(/const FOREGROUND_SCRIPT = `([\s\S]*?)\n`;/);
  assert.ok(m, '应能取到 FOREGROUND_SCRIPT');
  const script = eval('`' + m[1] + '`');
  assert.equal(Buffer.from(script, 'ascii').every((c) => c < 128), true, '必须纯 ASCII');
  assert.equal(/[一-鿿]/.test(script), false, '不得含中文字符');
});

test('readForegroundRect：实调一次必须拿到真实矩形，且不留临时目录', async () => {
  const os = require('os');
  const { readForegroundRect } = require('../src/popup-manager');
  if (process.platform !== 'win32') return;
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('lm-fg-')).length;
  const rect = await readForegroundRect();
  assert.ok(rect, '在 Windows 上必须拿到前台窗口矩形——拿不到说明脚本根本没被执行');
  assert.ok(rect.width > 0 && rect.height > 0);
  assert.equal(Number.isFinite(rect.left) && Number.isFinite(rect.top), true);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('lm-fg-')).length;
  assert.equal(after, before, '临时目录用完即删');
});

test('前台 pid 解析：取第 6 段；缺字段 / 非数字返回 null', () => {
  const { parseForegroundPid } = require('../src/popup-manager');
  assert.equal(parseForegroundPid('LMFG\t100\t50\t1200\t700\t4242\n'), 4242);
  assert.equal(parseForegroundPid('Windows PowerShell\r\nLMFG\t10\t20\t30\t40\t77\r\nPS C:\\> '), 77);
  assert.equal(parseForegroundPid('LMFG\t10\t20\t30\t40'), null, '老格式没有 pid 段');
  assert.equal(parseForegroundPid('LMFG\t10\t20\t30\t40\txyz'), null);
  assert.equal(parseForegroundPid(''), null);
});

test('回归：前台窗口是自己时必须放弃这个锚点（托盘被点过时悬浮窗就是前台）', async () => {
  // 步骤 4 遗留：划词接线后用户点过托盘 → 前台窗口 = LinguaMate 自己的悬浮窗。
  // 拿它当锚点，弹窗会定位到自己的窗口上，「出现在当前应用上方」整个语义作废。
  // 这里不用假的前台矩形，而是真的调一次 PowerShell 拿到真 pid，再假装那就是自己。
  if (process.platform !== 'win32') return;
  const { readForegroundRect, parseForegroundPid } = require('../src/popup-manager');
  const real = await readForegroundRect({ selfPid: -1 });   // 关闭排除，拿到真实矩形
  if (!real) return;   // 本机没有可见前台窗口（无人值守的 CI），这条测不了

  // 重新取一次 pid：必须用**独立的一次调用**，不能从 rect 里推
  const { execFile } = require('child_process');
  const os = require('os');
  const p = await new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-fg-'));
    const sp = path.join(dir, 'fg.ps1');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
    const m = src.match(/const FOREGROUND_SCRIPT = `([\s\S]*?)\n`;/);
    fs.writeFileSync(sp, Buffer.from(eval('`' + m[1] + '`'), 'ascii'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sp],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (e, so) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 残留无害 */ }
        resolve(e ? null : parseForegroundPid(so));
      });
  });
  assert.ok(Number.isFinite(p) && p > 0, '必须能读到前台窗口的 pid');
  assert.equal(await readForegroundRect({ selfPid: p }), null, '前台是自己时必须返回 null，退到光标定位');
  assert.ok(await readForegroundRect({ selfPid: -1 }), 'pid 对不上时照常返回矩形');
});

test('readForegroundRect：非 Windows 直接返回 null，不 spawn 任何东西', async () => {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    assert.equal(await require('../src/popup-manager').readForegroundRect(), null);
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});

test('回归：send/on 与 invoke/handle 必须配对（配错会让弹窗永远停在 show:false）', () => {
  // 真实踩过：preload 用 ipcRenderer.send('popup:resized')，主进程却注册了
  // ipcMain.handle。handle 只服务 invoke，send 过来的消息**根本收不到**，
  // 没有任何报错，弹窗就是永远不显示。
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload-popup.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.send\('popup:resized'/, '高度回报用的是 send');
  assert.match(preload, /ipcRenderer\.invoke\('popup:getData'/, '初始数据用的是 invoke');

  const viaOn = [];
  const viaHandle = [];
  const { EventEmitter } = require('node:events');
  const em = new EventEmitter();
  const mgr = createPopupManager({
    BrowserWindow: function () { throw new Error('不该建窗口'); },
    screen: {}, ipcMain: { on: (c) => viaOn.push(c), handle: (c) => viaHandle.push(c), removeHandler() {}, removeAllListeners() {} },
  });
  mgr.dispose();

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-manager.js'), 'utf8');
  assert.match(src, /on\('popup:resized'/, "popup:resized 必须用 ipcMain.on（配 send）");
  assert.match(src, /handle\('popup:getData'/, "popup:getData 必须用 ipcMain.handle（配 invoke）");
  assert.equal(/handle\('popup:resized'/.test(src), false, '不得用 handle 接 send 的消息');
});
