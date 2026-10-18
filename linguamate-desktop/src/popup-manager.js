// 阶段 5 步骤 4：划词 / 截图共用的浮动译文弹窗。
//
// 三条硬约束（来自 STAGE_5_PLAN v2）：
//  1. 弹窗**抢焦点**（focusable:true + show），否则键盘事件进不来，Esc 形同虚设。
//     ⚠️ 这是 2026-09-30 用户在「弹窗关不掉、Esc 无效」之后明确点头换来的：代价是
//     弹窗一出现，原应用的选区/光标/输入法被打断，且弹窗盖住的那块区域后续按键
//     会被弹窗吞掉（输入是真的丢，不只是看不见）。计划第 531 行本来禁止这么改，
//     除非用户明确接受打断当前工作——他现在接受了。**要改回去是用户的决定。**
//     关闭入口：[×]、Esc、以及点弹窗以外的任何地方（blur）。
//  2. 同一时刻只有一个弹窗，新的先 destroy 旧的。
//  3. 本阶段唯一一处写剪贴板：用户**显式点 [复制]** 时才写，不是捕获手段。
//
// 定位分两种：
//  - selection：当前应用窗口的水平中点、顶部上方 24px（"出现在当前应用上方"）
//  - screenshot：光标右下 16px
//  两者都要 clamp 回 workArea 内。

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const POPUP_WIDTH = 480;
const POPUP_MAX_HEIGHT = 520;
const POPUP_MIN_HEIGHT = 120;
const GUTTER = 16;          // screenshot 模式光标右下偏移
const ABOVE_GAP = 24;       // selection 模式窗口顶部上方的间距

// 取前台窗口矩形。必须在创建弹窗**之前**调用——一旦弹窗出现，
// "前台窗口"就可能变成弹窗自己。
//
// 纯 ASCII：PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解码，中文字节会
// 把行尾换行吃掉、把下一行并进注释，表现为「静默不执行、退出码 0、stderr 空」。
const FOREGROUND_SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LMFg {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [LMFg]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output "LMFG\`t0\`t0\`t0\`t0\`t0"; exit 0 }
$r = New-Object LMFg+RECT
[void][LMFg]::GetWindowRect($h, [ref]$r)
$owner = 0
[void][LMFg]::GetWindowThreadProcessId($h, [ref]$owner)
Write-Output ("LMFG\`t" + $r.Left + "\`t" + $r.Top + "\`t" + $r.Right + "\`t" + $r.Bottom + "\`t" + $owner)
`;

// 只取第 6 段：前台窗口**属于哪个进程**。
//
// 为什么要这个：划词接线后，用户点过托盘就会让 LinguaMate 自己的悬浮窗变成前台窗口。
// 此时若拿它当锚点，弹窗会定位到自己的窗口上——「当前应用上方」这个语义就整个错了。
// 判定归属必须在**读矩形的同一次调用**里做，不能事后另查：弹窗一旦出现前台就变了。
function parseForegroundPid(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((l) => l.startsWith('LMFG'));
  if (!line) return null;
  const parts = line.split('\t').map((p) => Number(p.trim()));
  if (parts.length < 6) return null;
  return Number.isFinite(parts[5]) ? parts[5] : null;
}

function parseForegroundRect(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((l) => l.startsWith('LMFG'));
  if (!line) return null;
  const parts = line.split('\t').map((p) => Number(p.trim()));
  if (parts.length < 5 || parts.slice(1).some((n) => !Number.isFinite(n))) return null;
  const [, left, top, right, bottom] = parts;
  // 右<=左 或 下<=上 说明窗口被最小化 / 不可用，不要拿它当锚点
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// 单发一次 PowerShell 读前台窗口矩形。失败一律返回 null，让调用方退到光标定位。
//
// selfPid 默认 process.pid：前台窗口属于本进程时**直接判 null**。
// 划词接线后这是常事——用户点过托盘，悬浮窗就成了前台窗口。
// 若不排掉，弹窗会以自己的窗口为锚点，「出现在当前应用上方」的语义整个作废。
//
// 临时目录必须在 **execFile 回调里** 删，不能放 finally。
// `return new Promise(() => {...})` 写在 try{}finally{} 里时，finally 会在异步工作
// 完成之前就执行——脚本文件先被删掉，PowerShell 还没打开它就找不到了，
// 表现为「永远返回 null」而不是任何报错。（步骤 3 在 selection-reader.js 上踩过一次，
// 这里必须按同样的写法。）
function readForegroundRect(options = {}) {
  const { timeout = 3000, selfPid = process.pid } = options;
  // 非 Windows 没有 powershell.exe，也不该去尝试
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let dir = null;
    let scriptPath = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-fg-'));
      scriptPath = path.join(dir, 'fg.ps1');
      // 以 ASCII 落盘，绝不带 BOM
      fs.writeFileSync(scriptPath, Buffer.from(FOREGROUND_SCRIPT, 'ascii'));
    } catch {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 残留无害 */ } }
      resolve(null);
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 残留无害 */ }
        if (err) { resolve(null); return; }
        resolve(parseForegroundPid(stdout) === selfPid ? null : parseForegroundRect(stdout));
      },
    );
  });
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * 纯几何计算，不碰 Electron，方便单测。
 *
 * @param {object} o
 * @param {'selection'|'screenshot'} o.mode
 * @param {{left,top,right,bottom}|null} o.foregroundRect  selection 模式用
 * @param {{x,y}|null} o.cursorPoint                        screenshot 模式用
 * @param {number} o.popupWidth
 * @param {number} o.popupHeight
 * @param {{x,y,width,height}} o.workArea
 * @returns {{x:number,y:number}} 已 clamp 进 workArea 的左上角
 */
function computePopupPosition({ mode, foregroundRect, cursorPoint, popupWidth, popupHeight, workArea }) {
  const wa = workArea;
  let x;
  let y;

  if (mode === 'selection' && foregroundRect) {
    // 水平居中于当前应用窗口
    x = foregroundRect.left + Math.round((foregroundRect.width - popupWidth) / 2);
    // 垂直置于窗口顶部上方；顶到屏幕上沿就翻到窗口下方，绝不越界
    y = foregroundRect.top - ABOVE_GAP - popupHeight;
    if (y < wa.y) y = foregroundRect.top + ABOVE_GAP;
  } else {
    // 拿不到前台矩形时退到光标附近（截图模式本来就用光标）
    const point = cursorPoint || { x: wa.x + wa.width - popupWidth - GUTTER, y: wa.y + wa.height - popupHeight - GUTTER };
    x = point.x + GUTTER;
    y = point.y + GUTTER;
  }

  return {
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - popupWidth)),
    y: Math.round(clamp(y, wa.y, wa.y + wa.height - popupHeight)),
  };
}

// 本阶段唯一一处写剪贴板，且只在用户显式点 [复制] 时触发。
//
// 为什么收在这里而不是让 main.js 注入：计划要求 main.js 里不得出现任何写剪贴板的
// 调用（划词捕获链路必须与写剪贴板彻底无关）。把这一处收进本模块，main.js 就连
// clipboard 的写方法都碰不到，「捕获 → 翻译 → 弹窗」全程零写入在结构上就是真的。
//
// 懒 require：node --test 下没有 electron，必须不炸；单测则用注入的假实现覆盖。
function defaultWriteClipboard(text) {
  try {
    // eslint-disable-next-line global-require
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function createPopupManager(deps = {}) {
  const {
    BrowserWindow,
    screen,
    ipcMain,
    getCursorPoint,
    preloadPath = path.join(__dirname, 'preload-popup.js'),
    indexPath = path.join(__dirname, '..', 'popup', 'index.html'),
    writeClipboard = defaultWriteClipboard,
    readForeground = readForegroundRect,
    onRetry = null,
    // [截图翻译] 按钮的落点。**只转发点击**，不做任何补拍：
    // 划词读不到内容时给用户一个出口，但截图必须由用户在这条链路上亲自再点一次。
    onScreenshot = null,
    logger = () => {},
  } = deps;

  let win = null;
  let payload = null;
  let disposed = false;
  // 屏幕上**所有**活着的弹窗。win 只是「当前那一个」的引用。
  //
  // 为什么不能只有 win：建窗要 await readForeground()（一次 PowerShell，约 300ms），
  // 这段是悬空的。并发触发时两次调用会先后都通过 destroy()，再各自建一个窗，
  // 后一个把 win 的引用覆盖掉。被覆盖的那个**还在屏幕上**，但：
  //   · update() 只发给 win → 它永远停在建窗时的「正在读取…」
  //   · isOwnSender() 拒掉它发来的 popup:close（sender 不是当前 win）→ [×] 和 Esc 都没反应
  // 两者叠加就是「弹窗卡住且关不掉」。2026-10-18 用户报的就是这个，
  // 见 CLAUDE_HANDOFF §5.1 BADCASE-001，回归测试在 test/popup-manager.test.js。
  const live = new Set();
  // 建窗序号。await 期间若又来了一次触发，序号就对不上，本次直接放弃。
  let showSeq = 0;

  function handle(channel, listener) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    // 重复 bootstrap 时 handle 会抛，用 removeHandler 兜住
    try { ipcMain.removeHandler(channel); } catch { /* 首次注册没有旧 handler */ }
    ipcMain.handle(channel, listener);
  }

  // send/on 与 invoke/handle 是两套，不能混用：
  // 渲染层用 ipcRenderer.send 发的消息，ipcMain.handle **收不到**。
  // （配错了不会报错，弹窗会一直停在 show:false 永不显示——静默失败。）
  function on(channel, listener) {
    if (!ipcMain || typeof ipcMain.on !== 'function') return;
    try { ipcMain.removeAllListeners(channel); } catch { /* 首次注册没有旧 listener */ }
    ipcMain.on(channel, listener);
  }

  // 供 preload 拉取初始数据。用 request-response 而不是 push：
  // loadFile 之后立刻 send 有竞态——renderer 还没注册 listener 事件就丢了。
  // 这与 preload.js 里 getConfigStatus 的理由相同。
  handle('popup:getData', () => payload || {});

  on('popup:resized', (event, payloadArg) => {
    if (!win || win.isDestroyed()) return;
    if (event && event.sender && win.webContents && event.sender !== win.webContents) return;
    const height = Number(payloadArg && payloadArg.height);
    if (!Number.isFinite(height)) return;
    const clamped = Math.round(clamp(height, POPUP_MIN_HEIGHT, POPUP_MAX_HEIGHT));
    win.setBounds({ ...win.getBounds(), height: clamped });
    position(clamped);
    // 只在这一刻显示：先按内容高度定好位再亮相，避免闪一下再跳
    if (!win.isVisible()) {
      // show() 而非 showInactive()：Esc 要能用，窗口必须真的拿到焦点。
      // 抢焦点的取舍见文件头注释——是用户点头换的。
      win.show();
      // 点弹窗以外的地方就关。
      //
      // 用 blur 而**不是**铺一个全屏透明窗口吃点击：那种做法会连带把用户对
      // **原应用**的点击一起吃掉，而弹窗没有自动消失（会一直挂着直到被关掉），
      // 于是原应用在弹窗存在期间彻底点不动。blur 是零成本的等价物——在 Windows
      // 上点别处就是换焦点，顺带还覆盖了 Alt+Tab、任务栏点击。
      //
      // 挂在这里而不是建窗时：建窗到 show() 之间窗口还没亮相，那段时间的焦点
      // 事件不代表用户「看了弹窗又不要了」。
      win.once('blur', () => destroy());
      // 只记窗口坐标这类元数据：不含选区文本、不含译文（§4.1 第 3 条的口径）
      logger('popup', 'bounds', JSON.stringify(win.getBounds()));
    }
  });

  // 渲染层渲染完成后按实际内容高度重新定位一次，避免先按最大值闪一下
  function position(popupHeight) {
    if (!win || win.isDestroyed() || !screen) return;
    const isSelection = payload && payload.mode === 'selection';
    // 光标点两种模式都要取：截图模式用它定位；划词模式取不到前台矩形时也退到它，
    // 否则 computePopupPosition 会一路退到「工作区右下角」，弹窗直接飞到屏幕边上。
    const cursorPoint = getCursorPoint ? getCursorPoint() : null;
    const rect = isSelection ? payload.foregroundRect : null;
    const anchorPoint = rect
      ? { x: Math.round((rect.left + rect.right) / 2), y: rect.top }
      : cursorPoint;
    const display = screen.getDisplayNearestPoint(
      anchorPoint || {
        x: Math.round(screen.getPrimaryDisplay().workArea.width / 2),
        y: Math.round(screen.getPrimaryDisplay().workArea.height / 2),
      },
    );
    const { x, y } = computePopupPosition({
      mode: isSelection ? 'selection' : 'screenshot',
      foregroundRect: rect,
      cursorPoint,
      popupWidth: POPUP_WIDTH,
      popupHeight,
      workArea: display.workArea,
    });
    win.setPosition(x, y);
  }

  // 渲染层 → 主进程的消息一律走 ipcMain。
  // **不能**挂在 win.webContents 上：webContents.on 收的是「主进程发给渲染层」的消息，
  // 渲染层 send 过来的根本到不了那里（2026-09-29 实测：[复制] 点了没反应、[×] 关不掉，
  // 而且没有任何报错）。这跟 popup:resized 踩的是同一类配对错误。
  function isOwnSender(event) {
    if (!win || win.isDestroyed()) return false;
    if (event && event.sender && win.webContents && event.sender !== win.webContents) return false;
    return true;
  }

  // 注册一次即可，win 是 manager 作用域的变量，调用时再取当前窗口做 sender 校验
  function registerRendererChannels() {
    // 本阶段唯一一处写剪贴板：用户显式点 [复制] 时才写，不是捕获手段
    on('popup:copy', (event, text) => {
      if (!isOwnSender(event)) return;
      if (typeof text === 'string' && text && writeClipboard) writeClipboard(text);
    });
    // [×] 关闭。Esc 走的是渲染层 keydown → 同一个 popup:close 通道。
    on('popup:close', (event) => {
      if (!isOwnSender(event)) return;
      destroy();
    });
    // [重试]。传的是**当前弹窗的 payload**，不是渲染层回传的原文——
    // 渲染层回传等于把原文在渲染进程里再走一圈，没必要，也让「谁持有原文」
    // 这件事变模糊。主进程本来就有 payload，直接给它。
    on('popup:retry', (event) => {
      if (!isOwnSender(event)) return;
      if (typeof onRetry !== 'function') return;
      onRetry(payload);
    });
    // [截图翻译]。同上：只把「用户点了」转出去，主进程那边自己开覆盖层。
    on('popup:screenshot', (event) => {
      if (!isOwnSender(event)) return;
      if (typeof onScreenshot !== 'function') return;
      onScreenshot();
    });
  }
  registerRendererChannels();

  function update(next) {
    payload = { ...(payload || {}), ...next };
    if (win && !win.isDestroyed()) win.webContents.send('popup:data', payload);
    return payload;
  }

  function destroy() {
    // 遍历**全部**活着的窗口，而不是只关 win。
    // 只关 win 的话，任何引用错位留下的窗口都会变成屏幕上点不掉、Esc 也关不掉的死面板。
    for (const w of live) {
      if (!w || w.isDestroyed()) continue;
      try { w.destroy(); } catch { /* 已经没了 */ }
    }
    live.clear();
    win = null;
  }

  /**
   * @param {object} data
   * @param {'selection'|'screenshot'} data.mode
   * @param {string} [data.sourceText]
   * @param {string} [data.translation]
   * @param {boolean} [data.truncated]
   * @param {string} [data.status]
   */
  async function showTranslationPopup(data = {}) {
    if (disposed) return null;
    if (process.platform !== 'win32') return null;

    const mySeq = ++showSeq;

    // 顺序要紧：先读前台矩形，再建窗口，否则"前台"可能已经是弹窗了
    let foregroundRect = null;
    if (data.mode === 'selection' && !data.ignoreForeground) {
      foregroundRect = await readForeground();
      // 只输出窗口坐标这类元数据：不含选区文本、不含剪贴板内容（§4.1 第 3 条的口径）
      logger('popup', 'foreground', foregroundRect ? JSON.stringify(foregroundRect) : 'fallback');
      // await 期间可能又来了一次触发（语音输入法一轮写两次剪贴板就会这样）。
      // 后来的那次才是用户当下要的，本次直接放弃——两个都建出来的话后一个会
      // 覆盖 win 的引用，前一个就成了关不掉的孤儿（BADCASE-001 缺陷 A）。
      if (mySeq !== showSeq) return null;
    }

    // 销毁必须放在 await **之后**。放在前面挡不住并发的那一次：
    // 两次调用会先后都通过它，然后各自建一个窗。
    destroy();

    payload = { ...data, foregroundRect, mode: data.mode || 'screenshot' };

    const created = new BrowserWindow({
      width: POPUP_WIDTH,
      height: POPUP_MIN_HEIGHT,
      show: false,                 // 等渲染层回报真实高度再显示，避免闪
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,             // 抢焦点 → Esc 进得来。取舍见文件头注释
      fullscreenable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'LinguaMate',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    live.add(created);
    win = created;

    created.setMenu(null);
    // 关掉窗口（Alt+F4 / 任务栏）也要走同一条销毁路径。
    // 只在 win 仍指向自己时才置空——否则会把后来的那个窗口的引用也抹掉。
    created.on('closed', () => {
      live.delete(created);
      if (win === created) win = null;
    });
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    try {
      await created.loadFile(indexPath);
    } catch (error) {
      // 加载期间窗口被顶掉了（并发触发）是最常见的一种，按作废处理返回 null。
      // 不接住的话它会一路冒到 main.js，那里没人处理这个 rejection。
      if (!created.isDestroyed()) {
        logger('popup', 'loadFile failed', String((error && error.message) || error));
      }
      return null;
    }
    return created;
  }

  function dispose() {
    disposed = true;
    destroy();
    for (const channel of ['popup:getData', 'popup:resized', 'popup:copy', 'popup:close', 'popup:retry', 'popup:screenshot']) {
      try { ipcMain && ipcMain.removeHandler(channel); } catch { /* 没注册过 */ }
      try { ipcMain && ipcMain.removeAllListeners(channel); } catch { /* 没注册过 */ }
    }
  }

  return {
    showTranslationPopup,
    update,
    close: destroy,
    dispose,
    get isOpen() { return Boolean(win) && !win.isDestroyed(); },
  };
}

module.exports = {
  createPopupManager,
  computePopupPosition,
  parseForegroundRect,
  parseForegroundPid,
  readForegroundRect,
  POPUP_WIDTH,
  POPUP_MAX_HEIGHT,
  POPUP_MIN_HEIGHT,
  GUTTER,
  ABOVE_GAP,
};
