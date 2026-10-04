const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  createScreenshotCapture,
  parseRegionPayload,
  pickScreenSource,
  computeCropRect,
  MAX_PNG_BYTES,
  MIN_SELECTION_PX,
} = require('../src/screenshot-window');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================ 纯函数

test('选区解析：反向拖动要归一化成「左上角 + 正宽高」', () => {
  const r = parseRegionPayload({ x: 300, y: 240, width: -200, height: -100 }, { width: 1920, height: 1080 });
  assert.deepEqual(r, { x: 100, y: 140, width: 200, height: 100 });
});

test('选区解析：clamp 回视口，贴着屏幕右下角也不能越界', () => {
  const r = parseRegionPayload({ x: 1900, y: 1070, width: 400, height: 400 }, { width: 1920, height: 1080 });
  assert.deepEqual(r, { x: 1900, y: 1070, width: 20, height: 10 });
});

test('选区解析：非数字/缺字段一律判非法，不得当成 0 继续', () => {
  const vp = { width: 1920, height: 1080 };
  assert.equal(parseRegionPayload(null, vp), null);
  assert.equal(parseRegionPayload({}, vp), null);
  assert.equal(parseRegionPayload({ x: NaN, y: 0, width: 50, height: 50 }, vp), null);
  assert.equal(parseRegionPayload({ x: 0, y: 0, width: Infinity, height: 50 }, vp), null);
});

test('选区解析：小于最小边长的判误点，交回 null 让用户重画', () => {
  const vp = { width: 1920, height: 1080 };
  assert.equal(parseRegionPayload({ x: 10, y: 10, width: 2, height: 200 }, vp), null, '宽太小');
  assert.equal(parseRegionPayload({ x: 10, y: 10, width: 200, height: 2 }, vp), null, '高太小');
  // 边界：正好等于最小值必须放行
  assert.ok(parseRegionPayload({ x: 10, y: 10, width: MIN_SELECTION_PX, height: MIN_SELECTION_PX }, vp));
});

test('选屏：必须按 display_id 匹配，**不得按数组下标猜**', () => {
  // 故意让 sources 的顺序与 display 顺序相反——按下标取就会取错屏
  const sources = [
    { display_id: '2', name: '副屏' },
    { display_id: '1', name: '主屏' },
  ];
  assert.equal(pickScreenSource(sources, { id: 1 }, 2).name, '主屏');
  assert.equal(pickScreenSource(sources, { id: 2 }, 2).name, '副屏');
});

test('选屏：多屏时匹配不上宁可失败，也绝不退回第一个', () => {
  const sources = [{ display_id: '7' }, { display_id: '9' }];
  assert.equal(pickScreenSource(sources, { id: 3 }, 2), null,
    '目标屏不在列表里就必须失败——返回 sources[0] 会稳定截错屏');
});

test('选屏：只有一块屏时兜底是成立的，不是猜测', () => {
  assert.ok(pickScreenSource([{ display_id: '乱码' }], { id: 42 }, 1));
  // 但系统明明多屏、结果只有一条时，兜底不成立
  assert.equal(pickScreenSource([{ display_id: 'x' }], { id: 42 }, 2), null);
});

test('换算：比例必须从缩略图**实际尺寸**反推，不能用 scaleFactor', () => {
  // 150% 缩放：DIP 1920x1080，缩略图实际 2880x1620
  const bounds = { width: 1920, height: 1080 };
  const size = { width: 2880, height: 1620 };
  const { crop, scaleX, scaleY } = computeCropRect(
    { x: 100, y: 50, width: 200, height: 100 }, size, bounds,
  );
  assert.equal(scaleX, 1.5);
  assert.equal(scaleY, 1.5);
  assert.deepEqual(crop, { x: 150, y: 75, width: 300, height: 150 });

  // 同一个选区在 100% 下必须得到不同的物理像素——这正是 HiDPI 截错的根因
  const at1x = computeCropRect(
    { x: 100, y: 50, width: 200, height: 100 }, { width: 1920, height: 1080 }, bounds,
  );
  assert.deepEqual(at1x.crop, { x: 100, y: 50, width: 200, height: 100 });
});

test('换算：贴边的选区裁剪后不得越界（NativeImage.crop 越界会抛）', () => {
  const size = { width: 1920, height: 1080 };
  const { crop } = computeCropRect({ x: 1900, y: 1070, width: 20, height: 10 }, size, size);
  assert.ok(crop.x + crop.width <= size.width, '横向越界会让 crop() 抛异常');
  assert.ok(crop.y + crop.height <= size.height, '纵向越界会让 crop() 抛异常');
});

// ============================================================ 主入口

function makeHarness(overrides = {}) {
  const { EventEmitter } = require('node:events');
  const created = [];
  const calls = [];
  const log = [];
  const sendHandlers = new Map();
  // 任务栏占掉的高度（真实机器上是 48 DIP）
  const workAreaHeight = overrides.workAreaHeight || 1032;

  class FakeThumb {
    constructor(size) { this.size = size; }
    getSize() { return { ...this.size }; }
    crop(rect) {
      calls.push({ op: 'crop', rect, size: this.size });
      const png = Buffer.alloc(overrides.pngBytes || 128, 7);
      return { toPNG: () => png };
    }
  }

  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.destroyed = false;
      this.shown = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      // 忠实模拟 Electron 的真实行为：构造参数会被**夹到工作区**（实测 1536×960
      // 的屏传 height=960 只给到 912）。不建模这个，测试就是在给假件盖章。
      this.bounds = {
        x: opts.x,
        y: opts.y,
        width: opts.width,
        height: Math.min(opts.height, workAreaHeight),
      };
      created.push(this);
    }
    setMenu() {}
    getBounds() { return { ...this.bounds }; }
    setBounds(b) { this.bounds = { ...this.bounds, ...b }; }
    isDestroyed() { return this.destroyed; }
    show() { this.shown = true; }
    focus() { calls.push({ op: 'focus' }); }
    async loadFile() {}
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: overrides.scaleFactor || 1,
  };

  const screen = {
    getDisplayNearestPoint: () => display,
    getAllDisplays: () => [display],
  };

  const desktopCapturer = {
    getSources: async (opts) => {
      // 关键：记下这一刻覆盖层是不是已经销毁了
      calls.push({ op: 'getSources', overlayDestroyed: created[0] ? created[0].destroyed : null, opts });
      const size = overrides.thumbSize || { width: 1920, height: 1080 };
      // Electron 的 getSources 直接 resolve 成数组，不是 { sources: [...] }
      const ids = overrides.sourceIds || ['1'];
      return ids.map((id) => ({ display_id: id, thumbnail: new FakeThumb(size) }));
    },
  };

  const ipcMain = {
    on(ch, fn) { sendHandlers.set(ch, fn); },
    removeAllListeners(ch) { sendHandlers.delete(ch); },
    removeListener(ch, fn) { if (sendHandlers.get(ch) === fn) sendHandlers.delete(ch); },
  };

  const cap = createScreenshotCapture({
    BrowserWindow: FakeWindow,
    screen,
    ipcMain,
    desktopCapturer,
    getCursorPoint: () => ({ x: 100, y: 100 }),
    logger: (tag, key, value) => log.push(`${tag}:${key}=${value}`),
    ...overrides.deps,
  });

  return {
    cap, fx: { created, calls, log, sendHandlers, display },
  };
}

async function submit(h, rect) {
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const w = h.fx.created[0];
  h.fx.sendHandlers.get('screenshot:region')({ sender: w.webContents }, rect);
  return p;
}

test('主流程：交出选区后拿到 base64 PNG', async () => {
  const h = makeHarness();
  const result = await submit(h, { x: 100, y: 50, width: 200, height: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 128);
  assert.equal(result.displayId, '1');
  assert.deepEqual(result.rect, { x: 100, y: 50, width: 200, height: 100 });
  assert.equal(Buffer.from(result.pngBase64, 'base64').length, 128);
  h.cap.dispose();
});

test('回归：覆盖层必须在 getSources 之前销毁，否则会把自己截进去', async () => {
  const h = makeHarness();
  await submit(h, { x: 0, y: 0, width: 400, height: 300 });
  const call = h.fx.calls.find((c) => c.op === 'getSources');
  assert.ok(call, '应当调用过 getSources');
  assert.equal(call.overlayDestroyed, true,
    'getSources 时遮罩必须已经没了——顺序反了截出来的是 50% 黑遮罩');
  h.cap.dispose();
});

test('回归：成功路径必须真的把结果交出去（自毁不得把结果吃掉）', async () => {
  // destroyOverlay() 会同步触发 'closed'。如果没区分「我们自己关的」和
  // 「用户关的」，closed 会先把 promise settle 成 null，成功结果被 guard 丢掉——
  // 整条成功路径静默哑掉，表现为「截图永远不出结果」。
  const h = makeHarness();
  const result = await submit(h, { x: 10, y: 10, width: 300, height: 200 });
  assert.equal(result && result.ok, true, '必须拿到成功结果，而不是被 closed 抢先 settle 成 null');
  h.cap.dispose();
});

test('HiDPI：缩略图实际尺寸与请求不一致时，按实际尺寸换算', async () => {
  // 请求的是 1920（scaleFactor=1），Windows 实际给回 2880 宽
  const h = makeHarness({ thumbSize: { width: 2880, height: 1620 } });
  const result = await submit(h, { x: 100, y: 50, width: 200, height: 100 });
  const crop = h.fx.calls.find((c) => c.op === 'crop').rect;
  assert.deepEqual(crop, { x: 150, y: 75, width: 300, height: 150 },
    '必须按实际缩略图尺寸换算；按请求值算会在高缩放下截偏');
  assert.equal(result.ok, true);
  h.cap.dispose();
});

test('取消：Esc / 右键上报 cancel 后返回 null，且覆盖层被销毁', async () => {
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const w = h.fx.created[0];
  h.fx.sendHandlers.get('screenshot:cancel')({ sender: w.webContents });
  assert.equal(await p, null);
  assert.equal(w.destroyed, true, '取消后覆盖层必须销毁，不能留在屏幕上挡着整个桌面');
  h.cap.dispose();
});

test('取消：不是本覆盖层发来的事件一律忽略', async () => {
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const w = h.fx.created[0];
  // 别的窗口冒用同一个通道
  h.fx.sendHandlers.get('screenshot:region')({ sender: { id: 'impostor' } }, { x: 0, y: 0, width: 400, height: 300 });
  await tick(20);
  assert.equal(h.cap.isCapturing, true, '伪造事件不得结束捕获');
  h.fx.sendHandlers.get('screenshot:cancel')({ sender: w.webContents });
  assert.equal(await p, null);
  h.cap.dispose();
});

test('误点：框太小不结束捕获，让用户原地重画', async () => {
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const w = h.fx.created[0];
  h.fx.sendHandlers.get('screenshot:region')({ sender: w.webContents }, { x: 10, y: 10, width: 2, height: 2 });
  await tick(20);
  assert.equal(h.cap.isCapturing, true, '误点不得把覆盖层关掉——用户还得重画');
  assert.equal(h.fx.calls.some((c) => c.op === 'getSources'), false, '更不得触发截图');
  h.fx.sendHandlers.get('screenshot:cancel')({ sender: w.webContents });
  assert.equal(await p, null);
  h.cap.dispose();
});

test('回归：覆盖层被**外部**关掉也必须 settle，不能让调用方永久挂起', async () => {
  // 覆盖层是独立窗口，用户可以 Alt+F4 或从任务栏关掉它。那种情况下既没有
  // screenshot:region 也没有 screenshot:cancel，只有一个 'closed'。
  // 不 settle 的话 handleScreenshotTranslate 会永远 await 下去，弹窗卡在「识别中…」。
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  h.fx.created[0].destroy();          // 不是我们走 settle 关的
  // 用 race 而不是直接 await：settle 丢失时是**永久挂起**，必须快速失败并说清原因
  const raced = await Promise.race([p, tick(80).then(() => '__hung__')]);
  assert.equal(raced, null, '窗口被外部关掉时必须 settle 成 null');
  h.cap.dispose();
});

test('回归：已在截的时候再触发一次，绝不能留下孤儿覆盖层', async () => {
  // 用户手快，连按两下 Ctrl+Shift+S。上面 on() 每次都先 removeAllListeners(channel)，
  // 第二次进来会把**第一个**覆盖层的 IPC 监听摘掉——它当场变聋子，之后再点它、
  // 松手它，事件都被新 handler 的 isOwnSender 挡掉。结果是屏幕上留一个挡住整个
  // 桌面、又点不动、也关不掉的罩子，只能等 60 秒超时。
  const h = makeHarness();
  const first = h.cap.captureScreenRegion();
  await tick(10);
  const second = await h.cap.captureScreenRegion();
  assert.equal(second, null, '已经在截了，第二次必须直接返回 null');
  assert.equal(h.fx.created.length, 1, '绝不能建第二个覆盖层');
  assert.equal(h.cap.isCapturing, true, '第一次的捕获完全不受影响');

  h.fx.sendHandlers.get('screenshot:cancel')({ sender: h.fx.created[0].webContents });
  assert.equal(await first, null);
  h.cap.dispose();
});

test('PNG 超 3MB 时明确报 too-large，不得静默截断', async () => {
  const h = makeHarness({ pngBytes: MAX_PNG_BYTES + 1 });
  const result = await submit(h, { x: 0, y: 0, width: 500, height: 400 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too-large');
  assert.equal(result.maxBytes, MAX_PNG_BYTES);
  assert.equal(result.pngBase64, undefined, '超限时不得把 base64 交出去');
  h.cap.dispose();
});

test('找不到目标屏时判 display-not-found，绝不截错屏', async () => {
  // 结果里只有 7 和 9，没有目标屏 1
  const h = makeHarness({ sourceIds: ['7', '9'] });
  const result = await submit(h, { x: 0, y: 0, width: 300, height: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'display-not-found');
  assert.equal(result.pngBase64, undefined, '失败时不得交出任何图像数据');
  h.cap.dispose();
});

test('单屏时 display_id 对不上仍可兜底（此时唯一那条必然是它）', async () => {
  const h = makeHarness({ sourceIds: ['对不上'] });
  const result = await submit(h, { x: 0, y: 0, width: 300, height: 200 });
  assert.equal(result.ok, true, '系统只有一块屏时，唯一的 screen 源必然是目标屏');
  h.cap.dispose();
});

test('超时：覆盖层一直没人管也必须自己收摊', async () => {
  const h = makeHarness({ deps: { timeoutMs: 40 } });
  const result = await h.cap.captureScreenRegion();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(h.fx.created[0].destroyed, true, '超时后覆盖层必须销毁');
  h.cap.dispose();
});

test('dispose 之后不得再开覆盖层', async () => {
  const h = makeHarness();
  h.cap.dispose();
  assert.equal(await h.cap.captureScreenRegion(), null);
  assert.equal(h.fx.created.length, 0);
});

test('覆盖层窗口参数：铺满目标屏、置顶、不进任务栏、且 Esc 要能收到', async () => {
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const o = h.fx.created[0].opts;
  assert.equal(o.width, 1920);
  assert.equal(o.height, 1080);
  assert.equal(o.x, 0);
  assert.equal(o.y, 0);
  assert.equal(o.frame, false);
  assert.equal(o.transparent, true);
  assert.equal(o.alwaysOnTop, true);
  assert.equal(o.skipTaskbar, true);
  assert.equal(o.resizable, false);
  // 覆盖层与译文弹窗相反：它必须 focusable，否则 Esc 收不到、用户没法取消
  assert.equal(o.focusable, true, '覆盖层 focusable:false 就取消不掉了');
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(h.fx.created[0].shown, true, '必须真的显示出来');
  h.fx.sendHandlers.get('screenshot:cancel')({ sender: h.fx.created[0].webContents });
  await p;
  h.cap.dispose();
});

// ============================================================ 边界与卫生

test('回归：构造参数之外必须再显式 setBounds 整块屏（frameless 会被夹到工作区）', async () => {
  // 实测：1536×960 的屏，构造时传 height=960，Electron 只给 1536×912——
  // 差的那 48px 正是任务栏高度。那条既遮不住也框不到，用户会以为那块选不了。
  // resizable:true 救不回来，只有构造后显式 setBounds 一次才行。
  const h = makeHarness();
  const p = h.cap.captureScreenRegion();
  await tick(10);
  const w = h.fx.created[0];
  // 假件忠实模拟 Electron：构造参数被夹到工作区(1032)，只有显式 setBounds 才能到 1080。
  // 变异「删掉 applyBounds」时这里会读到 1032 —— 这条断言是否有用，看它会不会红。
  assert.deepEqual(w.getBounds(), { x: 0, y: 0, width: 1920, height: 1080 },
    '覆盖层必须真的铺满整块屏，而不是工作区');
  h.fx.sendHandlers.get('screenshot:cancel')({ sender: w.webContents });
  await p;
  h.cap.dispose();
});

test('绝不自动截图：模块里不得有任何自动触发 capture 的入口', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screenshot-window.js'), 'utf8');
  // 唯一的 capture 入口是 captureScreenRegion，且必须由外部显式调用
  assert.equal(/setTimeout\([^)]*captureScreenRegion/.test(src), false, '不得定时自动截图');
  assert.equal(/on\(['"]blur['"][^)]*captureScreenRegion/.test(src), false, '不得在失焦时自动截图');
  assert.match(src, /async function captureScreenRegion/, '截图必须由显式调用触发');
});

test('截图只在内存里：默认路径不得写任何文件', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screenshot-window.js'), 'utf8');
  // 唯一的写盘入口是 saveDebugShot，且必须由调用方注入，默认值是 null
  assert.match(src, /saveDebugShot = null/, 'saveDebugShot 默认必须是 null');
  assert.equal(/writeFileSync|createWriteStream|appendFileSync/.test(src), false, '模块内不得直接写盘');
});

test('日志只记元数据：不得出现像素内容/选区坐标之外的东西', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screenshot-window.js'), 'utf8');
  assert.equal(/logger\([^)]*pngBase64/.test(src), false, 'base64 绝不能进日志');
  assert.equal(/logger\([^)]*toString\(['"]base64/.test(src), false);
  // saveDebugShot 的调用点附近不能顺手 log 一个 Buffer
  const calls = src.match(/logger\([^;]*\);/g) || [];
  for (const c of calls) {
    assert.equal(/\bpng\b(?!\.length)/.test(c), false, `日志里出现了 png 本身：${c}`);
  }
});

test('IPC 配对：渲染层 send 与主进程 on 必须成对（配错是静默失败）', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload-screenshot.js'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screenshot-window.js'), 'utf8');
  assert.match(preload, /ipcRenderer\.send\('screenshot:region'/, '选区用 send');
  assert.match(preload, /ipcRenderer\.send\('screenshot:cancel'/, '取消用 send');
  assert.equal(/ipcRenderer\.invoke\('screenshot/.test(preload), false, '不得用 invoke');
  assert.match(src, /on\('screenshot:region'/, '主进程必须用 ipcMain.on 接 send');
  assert.match(src, /on\('screenshot:cancel'/, '主进程必须用 ipcMain.on 接 send');
  assert.equal(/handle\('screenshot/.test(src), false, '不得用 handle 接 send 的消息');
});

test('覆盖层渲染层：Esc 与右键都走 cancel，且都不带坐标', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'screenshot', 'index.js'), 'utf8');
  assert.match(js, /contextmenu[\s\S]{0,200}?api\.cancel\(\)/, '右键必须取消');
  assert.match(js, /keydown[\s\S]{0,300}?Escape[\s\S]{0,200}?api\.cancel\(\)/, 'Esc 必须取消');
  // cancel() 不得携带选区
  assert.equal(/api\.cancel\([^)]/.test(js), false, '取消时不得把选区一起报上去');
});

test('覆盖层渲染层：坐标一律 clamp 回视口，不得把越界值交给主进程', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'screenshot', 'index.js'), 'utf8');
  assert.match(js, /clampPoint/, '必须有夹取');
  assert.match(js, /Math\.min\(Math\.max\(event\.clientX, 0\), window\.innerWidth\)/, 'x 必须夹在视口内');
  assert.match(js, /Math\.min\(Math\.max\(event\.clientY, 0\), window\.innerHeight\)/, 'y 必须夹在视口内');
});

test('打包配置：screenshot/** 必须进 files，否则 loadFile 找不到', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('screenshot/**/*'), 'screenshot/**/* 必须进 files');
});

test('覆盖层页面：不得引入任何外部资源（CSP 下也不该有）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'screenshot', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/, '必须有 CSP');
  assert.equal(/https?:\/\//.test(html.replace(/http:\/\/localhost:8787/g, '')), false, '不得引用外部资源');
  assert.match(html, /src="index\.js"/);
  assert.match(html, /href="styles\.css"/);
});
