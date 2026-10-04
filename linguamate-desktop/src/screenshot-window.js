// 阶段 5 步骤 5：截图覆盖层 + 屏幕捕获。
//
// 三条硬约束（来自 STAGE_5_PLAN v2「明确不做的事」）：
//   · 绝不自动截图——必须由用户显式触发（热键/菜单），划词失败也不许自动兜底
//   · 截图只在内存里流转：PNG 不落盘、不进项目目录、不进日志
//   · 覆盖层关闭之后才允许 capture，否则会把自己截进去
//
// 与划词弹窗相反：覆盖层是 **focusable:true + show()**。翻译弹窗当时为了不抢焦点
// 放弃了 Esc，这里相反——覆盖层是全屏的、用户正在主动拖框，焦点本来就该在它上面，
// Esc 取消必须立刻可用。

const path = require('path');

// 后端 /v1/ocr 的上限是 3MB。超了要在 UI 上有明确提示，不能静默截断。
const MAX_PNG_BYTES = 3 * 1024 * 1024;
// 覆盖层一直挂着会挡住整个桌面，必须有兜底超时
const OVERLAY_TIMEOUT_MS = 60 * 1000;
// 拖出来的框小于这个尺寸（CSS 像素）视为误点，不提交
const MIN_SELECTION_PX = 4;

// ------------------------------------------------------------------ 纯函数

/**
 * 校验并归一化覆盖层报上来的选区。
 *
 * @param {*} payload 渲染层发来的 { x, y, width, height }（CSS 像素）
 * @param {{width:number,height:number}} viewport 覆盖层视口尺寸，用来夹住越界
 * @param {number} [minSize] 最小边长
 * @returns {{x:number,y:number,width:number,height:number}|null} 不合法返回 null
 */
function parseRegionPayload(payload, viewport, minSize = MIN_SELECTION_PX) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = [payload.x, payload.y, payload.width, payload.height].map(Number);
  if (raw.some((n) => !Number.isFinite(n))) return null;
  const [px, py, pw, ph] = raw;

  // 反向拖动会得到负的宽高，先归一化成「左上角 + 正宽高」
  const x0 = pw < 0 ? px + pw : px;
  const y0 = ph < 0 ? py + ph : py;
  const width = Math.abs(pw);
  const height = Math.abs(ph);

  // clamp 回视口：覆盖层虽然铺满整块屏幕，坐标仍可能被窗口边界裁掉一点
  const maxW = Number(viewport && viewport.width) || 0;
  const maxH = Number(viewport && viewport.height) || 0;
  const x = maxW > 0 ? Math.min(Math.max(x0, 0), maxW) : Math.max(x0, 0);
  const y = maxH > 0 ? Math.min(Math.max(y0, 0), maxH) : Math.max(y0, 0);
  const w = maxW > 0 ? Math.min(width, maxW - x) : width;
  const h = maxH > 0 ? Math.min(height, maxH - y) : height;

  if (!(w >= minSize) || !(h >= minSize)) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

/**
 * 从 desktopCapturer 的结果里挑出目标屏幕。
 *
 * **绝不能按数组下标猜**——sources 的顺序不保证与 display 顺序一致，多屏时会
 * 稳定截错屏幕。必须按 display_id 匹配。
 *
 * @param {Array<{display_id: string}>} sources
 * @param {{id: number|string}} display Electron 的 display 对象
 * @param {number} totalDisplays 系统一共几块屏（决定「只有一块屏」这个兜底是否成立）
 */
function pickScreenSource(sources, display, totalDisplays) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length || !display) return null;

  const exact = list.find((s) => s && String(s.display_id) === String(display.id));
  if (exact) return exact;

  // 少数构建把 display_id 写成十六进制串，做一次数值等价比较
  const numeric = list.find((s) => s && Number(s.display_id) === Number(display.id));
  if (numeric) return numeric;

  // 兜底只在**系统确实只有一块屏**时成立——此时唯一的 screen 源必然是它，
  // 这不是猜测。多屏时宁可失败也不要截错屏。
  if (totalDisplays === 1 && list.length === 1) return list[0];
  return null;
}

/**
 * 把 CSS 像素的选区换算成缩略图（物理像素）里的裁剪矩形。
 *
 * 比例**从缩略图实际尺寸反推**，不用 display.scaleFactor、也不用请求时的
 * thumbnailSize：Windows 会按当前缩放把源图缩放到 thumbnailSize，实际返回的
 * 尺寸未必等于请求值。真按 scaleFactor 算，125%/150% 下就会截偏。
 *
 * @param {{x:number,y:number,width:number,height:number}} rect CSS 像素
 * @param {{width:number,height:number}} thumbnailSize 缩略图实际像素尺寸
 * @param {{width:number,height:number}} displayBounds 屏幕 DIP 尺寸
 */
function computeCropRect(rect, thumbnailSize, displayBounds) {
  const scaleX = thumbnailSize.width / displayBounds.width;
  const scaleY = thumbnailSize.height / displayBounds.height;
  const crop = {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY),
  };
  // 夹进缩略图：选区贴着屏幕边缘时 crop 会越界，NativeImage.crop 越界会抛异常
  const maxX = Math.max(thumbnailSize.width - 1, 0);
  const maxY = Math.max(thumbnailSize.height - 1, 0);
  crop.x = Math.min(Math.max(crop.x, 0), maxX);
  crop.y = Math.min(Math.max(crop.y, 0), maxY);
  crop.width = Math.min(crop.width, thumbnailSize.width - crop.x);
  crop.height = Math.min(crop.height, thumbnailSize.height - crop.y);
  return { crop, scaleX, scaleY };
}

// ------------------------------------------------------------------ 主入口

function createScreenshotCapture(deps = {}) {
  const {
    BrowserWindow,
    screen,
    ipcMain,
    desktopCapturer,
    getCursorPoint = () => null,
    preloadPath = path.join(__dirname, 'preload-screenshot.js'),
    indexPath = path.join(__dirname, '..', 'screenshot', 'index.html'),
    maxPngBytes = MAX_PNG_BYTES,
    timeoutMs = OVERLAY_TIMEOUT_MS,
    // 只有显式注入时才落盘（端到端验证用）。生产路径**永远**是 null。
    saveDebugShot = null,
    logger = () => {},
  } = deps;

  let overlay = null;
  let disposed = false;

  function destroyOverlay() {
    if (!overlay) return;
    const dying = overlay;
    overlay = null;
    try { dying.destroy(); } catch { /* 已经没了 */ }
  }

  function on(channel, listener) {
    if (!ipcMain || typeof ipcMain.on !== 'function') return () => {};
    try { ipcMain.removeAllListeners(channel); } catch { /* 首次注册 */ }
    ipcMain.on(channel, listener);
    return () => {
      try { ipcMain.removeListener(channel, listener); } catch { /* 已移除 */ }
    };
  }

  async function captureScreenRegion() {
    if (disposed) return null;
    // 已经在截了：绝不能再开第二个覆盖层。
    //
    // 不只是「多一个窗口难看」的问题。下面 on() 每次都先 removeAllListeners(channel)，
    // 第二次进来会把**第一次**注册的 IPC 监听摘掉——旧覆盖层当场变聋子，
    // 之后再点它、松手它，事件都被新 handler 的 isOwnSender 挡掉。它会一直挂在
    // 屏幕上挡住整个桌面，直到 60 秒超时才自己收摊。
    if (overlay) {
      logger('screenshot', 'busy', 'ignored');
      return null;
    }
    if (!BrowserWindow || !screen || !desktopCapturer) {
      logger('screenshot', 'error', 'missing-deps');
      return null;
    }

    const display = screen.getDisplayNearestPoint(getCursorPoint());
    const bounds = display.bounds;

    // 覆盖层的窗口坐标与渲染层的 CSS 像素是同一个单位（DIP），1:1 对应，
    // 所以渲染层报上来的选区不用做偏移，加到 bounds.x/y 上就是屏幕坐标。
    overlay = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,          // Esc 取消要立刻可用
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'LinguaMate',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    overlay.setMenu(null);
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // ⚠️ Electron 的构造参数会把 frameless 窗口**夹到工作区**，而不是给到整块屏。
    // 实测本机 1536×960 的屏，传 height=960 实际只拿到 1536×912——差的那 48px
    // 正是任务栏。`resizable:true` 也救不回来，只有构造完再显式 setBounds 一次才行。
    // 不修的后果很具体：屏幕最底下那条既遮不住也框不到，用户会以为那块选不了。
    const applyBounds = () => overlay && !overlay.isDestroyed() && overlay.setBounds({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    });
    applyBounds();

    const unregister = [];
    let timer = null;
    // teardown 中途（正在走捕获流程）时，closed 事件不代表用户取消。
    // 不置这个位的话：destroyOverlay() 会同步触发 'closed'，把 promise 先
    // settle 成 null，后面的成功结果被 settle 保护直接丢掉——成功路径整个哑掉。
    let tearingDown = false;
    let settled = false;
    let resolvePending = null;
    const pending = new Promise((resolve) => { resolvePending = resolve; });

    function settle(value) {
      if (settled) return;
      settled = true;
      unregister.forEach((fn) => fn());
      destroyOverlay();
      resolvePending(value);
    }

    overlay.on('closed', () => {
      if (tearingDown) return;      // 我们自己关的，别当成用户取消
      overlay = null;
      settle(null);
    });

    const isOwnSender = (event) => Boolean(
      overlay && event && event.sender && overlay.webContents && event.sender === overlay.webContents,
    );

    unregister.push(on('screenshot:region', async (event, payload) => {
      if (!isOwnSender(event)) return;
      const rect = parseRegionPayload(payload, { width: bounds.width, height: bounds.height });
      if (!rect) {
        // 误点（框太小）：**不结束**，让用户重画。反正还没截图，没有任何代价。
        logger('screenshot', 'region', 'too-small');
        return;
      }

      // ① 覆盖层必须在 capture 之前就没了，否则那块 50% 黑遮罩会出现在图里。
      //    这也是本模块最核心的一条：顺序反了，截出来的是自己的遮罩。
      tearingDown = true;
      destroyOverlay();
      if (timer) clearTimeout(timer);

      try {
        const scaleGuess = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          // 只是「希望拿到这么大」，实际尺寸一律以 thumbnail.getSize() 为准
          thumbnailSize: {
            width: Math.round(bounds.width * scaleGuess),
            height: Math.round(bounds.height * scaleGuess),
          },
        });
        const all = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [display];
        const source = pickScreenSource(sources, display, all.length);
        if (!source) {
          // 宁可失败也不要截错屏
          logger('screenshot', 'error', 'display-not-found');
          settle({ ok: false, reason: 'display-not-found' });
          return;
        }

        const size = source.thumbnail.getSize();
        const { crop, scaleX, scaleY } = computeCropRect(rect, size, bounds);
        if (crop.width < 1 || crop.height < 1) {
          logger('screenshot', 'error', 'empty-crop');
          settle({ ok: false, reason: 'empty-crop' });
          return;
        }

        const png = source.thumbnail.crop(crop).toPNG();
        // 只记元数据：尺寸、字节数、比例。绝不含像素内容。
        logger('screenshot', 'captured', `rect=${rect.width}x${rect.height} thumb=${size.width}x${size.height} scale=${scaleX.toFixed(3)}x${scaleY.toFixed(3)} bytes=${png.length}`);

        if (typeof saveDebugShot === 'function') {
          // 端到端验证用：写盘路径由调用方决定，绝不落进项目目录
          try { saveDebugShot(png, rect); } catch { /* 验证辅助，失败无所谓 */ }
        }

        if (png.length > maxPngBytes) {
          settle({ ok: false, reason: 'too-large', bytes: png.length, maxBytes: maxPngBytes });
          return;
        }
        settle({
          ok: true,
          pngBase64: png.toString('base64'),
          bytes: png.length,
          rect,
          displayId: String(display.id),
        });
      } catch (error) {
        logger('screenshot', 'error', String(error && error.message ? error.message : error));
        settle({ ok: false, reason: 'capture-failed' });
      }
    }));

    unregister.push(on('screenshot:cancel', (event) => {
      if (!isOwnSender(event)) return;
      logger('screenshot', 'cancelled', 'by-user');
      settle(null);
    }));

    timer = setTimeout(() => {
      logger('screenshot', 'error', 'timeout');
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    unregister.push(() => clearTimeout(timer));

    try {
      await overlay.loadFile(indexPath);
    } catch (error) {
      logger('screenshot', 'error', `load:${String(error && error.message ? error.message : error)}`);
      settle(null);
      return null;
    }
    if (disposed || !overlay) return null;
    // 先 show 再 focus：show() 在 Windows 上已经会激活窗口，focus() 是保险
    overlay.show();
    overlay.focus();
    // 复核一次：窗口尺寸是在这一刻才最终定型的，show() 之前的 setBounds 可能被覆盖
    applyBounds();

    return pending;
  }

  function dispose() {
    disposed = true;
    destroyOverlay();
  }

  return {
    captureScreenRegion,
    dispose,
    get isCapturing() { return overlay !== null; },
  };
}

module.exports = {
  createScreenshotCapture,
  parseRegionPayload,
  pickScreenSource,
  computeCropRect,
  MAX_PNG_BYTES,
  OVERLAY_TIMEOUT_MS,
  MIN_SELECTION_PX,
};
