// 阶段 4 桌面端：阶段 3 全部能力 + APPDATA/.env 检测 + /health 配置校验 +
// 首次启动托盘气泡 + 打开 FIRST_RUN.md IPC。按 CLAUDE_HANDOFF.md §4.2 阶段 4
// 验收合同，本阶段刻意不做自动粘贴、系统 Hook、开机自启。
//
// 阶段 5 已接入：步骤 6A 划词（双 Ctrl+C，零热键）、步骤 6B 截图（Ctrl+Shift+S）。
// 上面那三项**阶段 5 也没做**——它们仍需用户在 §4.2 阶段 5 合同下单独点名，
// 阶段 5 只做了用户点名的划词与截图两项。

const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, ipcMain, screen, clipboard, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { createPopupManager } = require('./popup-manager');
const { createSelectionCapture, SCRIPT_DIR_PREFIX } = require('./selection-capture');
const { readActiveSelection } = require('./selection-reader');
const { createScreenshotCapture } = require('./screenshot-window');

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+L';
// 截图翻译热键。计划 v2 定的是 Ctrl+Shift+S，可用 LINGUAMATE_SCREENSHOT_HOTKEY 覆盖。
// 划词**没有**热键（双 Ctrl+C 才是它的入口），所以这里没有对应的划词默认值。
const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+S';
const FLOATER_WIDTH = 460;
const FLOATER_HEIGHT = 260;

let tray = null;
let floater = null;
let backendApp = null;
let isRecording = false;
let popupManager = null;
let screenshotCapture = null;

function resolveBackendDir() {
  if (process.env.LINGUAMATE_BACKEND_DIR) return process.env.LINGUAMATE_BACKEND_DIR;
  // 阶段 4 打包后：backend 整个作为 extraResources 拷到 process.resourcesPath/backend/，
  // 避免安装目录里找不到源码。dev 模式仍走仓库内的 linguamate-live/backend。
  if (app.isPackaged) return path.join(process.resourcesPath, 'backend');
  return path.resolve(__dirname, '..', '..', 'linguamate-live', 'backend');
}

function resolveAppDataEnvPath() {
  if (!process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'LinguaMate', '.env');
}

function isPackaged() {
  // electron-builder 打包后 app.isPackaged=true；dev 模式 npm start 是 false。
  return app.isPackaged === true;
}

function ensureAppDataDir() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const dir = path.join(appdata, 'LinguaMate');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[linguamate-desktop] cannot create APPDATA dir:', dir, error.message);
  }
  // 把 FIRST_RUN.md 落地一份，方便用户从开始菜单 / 文件夹直接打开（asar 路径 shell 打不开）。
  if (isPackaged()) {
    const target = path.join(dir, 'FIRST_RUN.md');
    try {
      if (!fs.existsSync(target)) {
        const src = path.join(process.resourcesPath, 'app.asar.unpacked', 'FIRST_RUN.md');
        if (fs.existsSync(src)) fs.copyFileSync(src, target);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[linguamate-desktop] cannot seed FIRST_RUN.md:', error.message);
    }
  }
  return dir;
}

function resolveDotenvForBackend() {
  // dev mode：显式把 backend/.env 注入，绕过 server.js 的多路径查找，避免误读其它 .env。
  // prod mode：不注入 env，让 server.js 按 APPDATA → dev fallback 顺序自己选。
  if (process.env.LINGUAMATE_DOTENV_PATH) return;
  if (!isPackaged()) {
    const backendDir = resolveBackendDir();
    process.env.LINGUAMATE_DOTENV_PATH = path.join(backendDir, '.env');
  }
}

async function startBackend() {
  if (backendApp) return backendApp;
  resolveDotenvForBackend();
  const port = Number(process.env.LINGUAMATE_BACKEND_PORT || 8787);
  const allowedOrigin = process.env.LINGUAMATE_ALLOWED_ORIGIN || '*';
  // require 会触发 backend 模块顶层 dotenv.config()
  const mod = require(path.join(resolveBackendDir(), 'src', 'server.js'));
  backendApp = await mod.startServer({ port, allowedOrigin });
  // eslint-disable-next-line no-console
  console.log(`[linguamate-desktop] backend ready at http://localhost:${backendApp.port}`);
  return backendApp;
}

async function stopBackend() {
  if (!backendApp) return;
  try { await backendApp.close(); } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[linguamate-desktop] backend close failed:', error);
  }
  backendApp = null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!floater) return;
    if (floater.isVisible()) floater.hide();
    else showAndFocus();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[linguamate-desktop] bootstrap failed:', error);
    app.exit(1);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 必须先停监听：它是常驻 PowerShell 子进程，不杀会变成孤儿进程继续占着剪贴板监听
  stopSelectionWatcher();
  // 步骤 4：退出时必须销毁弹窗，否则 frameless + alwaysOnTop 的窗口会留残影
  popupManager?.dispose();
  // 步骤 5：退出时必须销毁覆盖层。frameless + alwaysOnTop + 全屏的窗口留残影的话，
  // 用户会看到一个怎么点都没反应的黑罩，只能靠任务栏结束进程。
  screenshotCapture?.dispose();
  // 内存里那张待重试的 PNG 一并丢掉
  lastScreenshotPng = null;
});

function showAndFocus() {
  if (!floater) return;
  positionFloaterAtBottomRight();
  floater.show();
  floater.focus();
}

function hideFloater() {
  floater?.hide();
}

function toggleFloaterVisibility() {
  if (!floater) return;
  if (floater.isVisible()) hideFloater();
  else showAndFocus();
}

// 全局快捷键回调：阶段 2 = "按一次开始、再按一次停止"，不发窗口显隐。
function toggleRecording() {
  if (!floater) return;
  isRecording = !isRecording;
  if (isRecording) showAndFocus();
  floater.webContents.send('recording:state', { active: isRecording });
}

function positionFloaterAtBottomRight() {
  if (!floater) return;
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workArea;
  const bounds = floater.getBounds();
  const margin = 16;
  floater.setPosition(
    Math.round(screenWidth - bounds.width - margin),
    Math.round(screenHeight - bounds.height - margin),
    false,
  );
}

// ⚠️ 这个函数开头是 unregisterAll()——整个系统里已注册的快捷键会被它清空。
// **只准用于登记那条录音快捷键**，任何新增热键都必须走 registerExtraShortcuts()。
// 2026-09-30 加截图热键时踩的就是这条：复用它会把用户的 Ctrl+Shift+L 弄丢。
function registerShortcut(accelerator) {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(accelerator, toggleRecording);
    if (!ok) {
      floater?.webContents.send('shortcut:registration-failed', {
        accelerator,
        reason: '系统拒绝注册该快捷键，可能已被其它应用占用。',
      });
      return false;
    }
    floater?.webContents.send('shortcut:registered', { accelerator });
    return true;
  } catch (error) {
    floater?.webContents.send('shortcut:registration-failed', {
      accelerator,
      reason: error?.message || '注册快捷键时抛出异常。',
    });
    return false;
  }
}

/**
 * **追加**注册全局热键，绝不碰已有的。
 *
 * 划词录音的 `Ctrl+Shift+L` 走的是上面那个 `registerShortcut()`，它开头就是
 * `globalShortcut.unregisterAll()`。所以这里**绝不能**复用它，本函数体内也
 * 绝不能出现任何 unregister：一旦截图热键注册失败又回头去调 registerShortcut，
 * 用户的录音快捷键就没了。`globalShortcut.register` 本身就是追加语义。
 *
 * @param {Array<{accelerator: string, handler: Function, label: string}>} defs
 * @returns {Array<{accelerator: string, label: string, ok: boolean, reason?: string}>}
 *          逐条结果。**某条返回 false 只代表该功能不可用**，
 *          绝不能因此宣称「全部可用」。
 */
function registerExtraShortcuts(defs = []) {
  const results = [];
  for (const def of defs) {
    if (!def || typeof def.accelerator !== 'string' || !def.accelerator || typeof def.handler !== 'function') {
      results.push({ accelerator: def && def.accelerator, label: (def && def.label) || '', ok: false, reason: '定义不完整' });
      continue;
    }
    let ok = false;
    let reason = '';
    try {
      ok = globalShortcut.register(def.accelerator, def.handler);
      if (!ok) reason = '系统拒绝注册该快捷键，可能已被其它应用占用。';
    } catch (error) {
      ok = false;
      reason = error?.message || '注册快捷键时抛出异常。';
    }
    results.push({ accelerator: def.accelerator, label: def.label || '', ok, reason });
    // eslint-disable-next-line no-console
    console.log(`[linguamate-desktop] ${def.label || def.accelerator} ${ok ? '已注册' : `注册失败：${reason}`} (${def.accelerator})`);
    // 注册失败要把原因送到悬浮窗，否则用户在界面上完全看不出为什么按了没反应
    if (!ok) floater?.webContents.send('shortcut:registration-failed', { accelerator: def.accelerator, reason });
  }
  return results;
}

function createFloater() {
  floater = new BrowserWindow({
    width: FLOATER_WIDTH,
    height: FLOATER_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#10121a',
    title: 'LinguaMate',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  floater.setMenuBarVisibility(false);
  floater.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  floater.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideFloater();
    }
  });
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('LinguaMate Live（阶段 2：语音主链路）');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleFloaterVisibility);
}

function buildTrayMenu() {
  const template = [
    { label: isRecording ? '停止说话' : '开始说话', click: () => toggleRecording() },
    { type: 'separator' },
    { label: '显示 / 隐藏悬浮窗', click: toggleFloaterVisibility },
  ];

  // 划词没有热键（计划 v2：Ctrl+Shift+D 已作废，改为监听双 Ctrl+C），
  // 所以托盘里给一条说明项，让用户知道这个功能怎么用。
  if (process.platform === 'win32') {
    template.push(
      { type: 'separator' },
      { label: '划词翻译：选中文字后连按两次 Ctrl+C', enabled: false },
      // 截图翻译有热键，所以是可点的。热键没注册上（被别的应用占了）就置灰并
      // 在标签里说明——不能让用户点了完全没反应还以为是程序坏了。
      {
        label: screenshotHotkeyLabel(),
        enabled: screenshotHotkeyRegistered,
        click: () => { void handleScreenshotTranslate(); },
      },
    );
  } else {
    template.push(
      { type: 'separator' },
      { label: '划词 / 截图翻译仅支持 Windows', enabled: false },
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: '退出 LinguaMate',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  );
  return Menu.buildFromTemplate(template);
}

// ══════════════════════════════════════════════════════════════════════
// 步骤 6A：划词翻译串接
//
// 计划 v2：划词**没有热键**。用户在任意应用里选中文字、连按两次 Ctrl+C，
// 常驻的剪贴板监听判定为「双复制」后才去读文本 → EN→CN 翻译 → 弹窗。
// UIAutomation 读选区只是备用通道，且 Chrome 上不可用。
//
// 硬约束（逐条对应计划「明确不做的事」）：
//  · 本节**不写剪贴板**——写的能力收在 popup-manager 内部，main.js 连方法都碰不到
//  · 捕获链路**不碰键盘**——监听的是剪贴板变更结果，不是按键事件
//  · 单次 Ctrl+C 完全静默：判定必须是「两次变更」，由 selection-capture 保证
//  · 划词文本只在内存中短暂存在，**绝不写日志/诊断文件/历史**
// ══════════════════════════════════════════════════════════════════════

const MAX_TRANSLATE_CHARS = 500;   // 与截图翻译一致，用户已拍板
const TRANSLATE_TIMEOUT_MS = 20000;

let selectionCapture = null;
// 每次划词/截图自增；只有等于当前值的请求才能更新弹窗。
// 没有它，先发后到的慢请求会覆盖掉后发先到的结果（计划验收项 10）。
//
// **划词和截图共用这一个计数器**，不是各有一个：弹窗是单例，同一时刻只可能
// 属于一次操作。分成两个计数器等于把「串结果」这个 bug 从划词内部挪到了
// 划词↔截图之间——用户划词还在等翻译时按下截图键，慢的划词结果照样盖掉新译文。
let popupOpId = 0;
let popupAbort = null;
// onCaptureStart 发起、但还没 await 完的那次建窗。
// 不记住它的话，handleSelectionCaptured 会再建一次窗：用户看到的是弹窗闪一下、
// 跳一下、重新定位（每次建窗还要多起一个 PowerShell 读前台矩形，~300ms）。
let pendingStartPopup = null;

function truncateForTranslate(text) {
  const s = String(text || '');
  if (s.length <= MAX_TRANSLATE_CHARS) return { body: s, truncated: false };
  return { body: s.slice(0, MAX_TRANSLATE_CHARS), truncated: true };
}

// 只记元数据：状态、长度、耗时、操作号。**永远不记原文和译文**——
// 计划「隐私与数据边界」：选区文本不得进日志、诊断文件、崩溃报告或历史。
// 开销是一次 length 和一个 Date.now()，没有它就只能靠猜来判断是哪一段坏了。
function logSelectionMeta(event, extra = {}) {
  if (!process.env.LINGUAMATE_DEBUG) return;
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[selection] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

// 连续「读不到」的压制时长。
//
// 起因：同一台机器上**别的软件也在写剪贴板**。实测一款语音输入法按一次右 Alt 会
// 分两轮写入（间隔 497–564ms），而划词的可触发区间是 [280ms, 1000ms]——正中间。
// 结果是每按一次右 Alt 就弹一次这块面板，盖住正在输入的字。
//
// 为什么不收紧触发窗口：**分不开**。用户自己双击 Ctrl+C 的实测间隔是 500/600ms
// （2026-09-28 复验，见 selection-capture.js 的注释），和输入法的 497–564ms 重叠。
// 任何阈值要么放过输入法、要么连自己的双击一起打死。所以压制点只能在**回应**，
// 不在判定。
//
// 默认 30s：实测右 Alt 的自然连按间隔约 14–32s，30s 能压掉大半连续触发。
// 觉得吵就调大（LINGUAMATE_UNREADABLE_COOLDOWN_MS=60000），调 0 即恢复旧行为。
// 成功翻译一次立刻解封——那是真信号，用户有权第一时间看到。
const UNREADABLE_COOLDOWN_MS = (() => {
  const raw = process.env.LINGUAMATE_UNREADABLE_COOLDOWN_MS;
  if (!raw) return 30000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 30000;
})();
// 上一次**弹出了**「无法读取」面板的时刻；0 = 还没弹过 / 已解封。
let lastUnreadableAt = 0;

// 双复制已确认、但两条通道都没拿到可用纯文本。
// **只提示 + 给一个 [截图翻译] 按钮，绝不自动截图**——截图必须由用户自己触发。
// 「此内容无法读取」重试多少次都是同一个结果，所以 retryable:false：
// 真正有用的出口是 [截图翻译]，那才是用户下一步该做的事。
function handleSelectionUnreadable(payload) {
  const reason = (payload && payload.reason) || 'unknown';
  const now = Date.now();
  if (lastUnreadableAt && now - lastUnreadableAt < UNREADABLE_COOLDOWN_MS) {
    // 连续读不到：只记元数据，不弹。同一块面板反复盖在正在输入的字上面，
    // 用户既看不出差别，也腾不出手去关它。**不静默**——记进日志，
    // 开着 LINGUAMATE_DEBUG 一眼就能看出被压掉了几次、间隔多少。
    logSelectionMeta('unreadable-suppressed', { reason, sinceMs: now - lastUnreadableAt });
    return;
  }
  lastUnreadableAt = now;
  logSelectionMeta('unreadable', { reason });
  if (!popupManager) return;
  popupManager.showTranslationPopup({
    mode: 'selection',
    // 说清楚这一次**是什么**：没有原文时用户无从判断是划词坏了，还是别的软件
    // 往剪贴板里写了非文本内容。原文位置本来就是灰字小字，正好放这句上下文。
    sourceText: '本次剪贴板变化中不含纯文本',
    translation: '',
    status: '无法读取',
    error: '此内容无法读取，可能复制的是图片，或应用未提供文字。',
    // 元数据，不是内容
    debugReason: reason,
    retryable: false,
    action: 'screenshot',
  });
}

function handleSelectionCaptured(payload) {
  const { body, truncated } = truncateForTranslate((payload && payload.text) || '');
  logSelectionMeta('captured', { source: (payload && payload.source) || 'clipboard', len: body.length });
  if (body) lastUnreadableAt = 0; // 成功一次就解封，别让压制盖住真正的划词
  if (!body) {
    handleSelectionUnreadable({ reason: 'empty-after-capture' });
    return;
  }
  void translateSelection(body, truncated);
}

// 弹窗点 [重试] / [截图翻译]。
//
// [重试] 划词分支**绝不重读剪贴板**。重读会拿到「此刻」的剪贴板，可能已经是
// 用户后来复制的别的东西——重试就会变成翻译另一段内容，界面上原文还是原来那段，
// 属于最恶劣的一类串结果。重试只把**内存里这一份**原文再发一次。
//
// [截图翻译] 只是转达一次点击。这里**不做任何补拍**——覆盖层由用户点了之后
// 才开，截图链路绝不在划词失败时自动启动。
function handlePopupRetry(payload) {
  if (payload && payload.mode === 'screenshot') {
    void handleScreenshotTranslate();
    return;
  }
  const { body } = truncateForTranslate((payload && payload.sourceText) || '');
  if (!body) return;
  void translateSelection(body, Boolean(payload && payload.truncated), { reusePopup: true });
}

/**
 * 把一段英文翻成中文并更新弹窗。
 *
 * @param {string} body      已截断的原文
 * @param {boolean} truncated
 * @param {{reusePopup?: boolean}} [opts] reusePopup=true 时**不建新窗口**，
 *        只把已有弹窗刷成「正在翻译…」——点 [重试] 时用。建新窗口会让窗口跳走，
 *        用户点一下「重试」却看到弹窗重新弹一次，体验上就是 bug。
 */
async function translateSelection(body, truncated, opts = {}) {
  if (!popupManager || !backendApp) return;

  const myOp = ++popupOpId;
  const startedAt = Date.now();
  if (popupAbort) popupAbort.abort();
  popupAbort = new AbortController();
  const controller = popupAbort;
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  logSelectionMeta('start', { op: myOp, len: body.length, truncated, reuse: Boolean(opts.reusePopup) });

  if (opts.reusePopup) {
    popupManager.update({ translation: '', status: '正在翻译…', error: '' });
  } else if (pendingStartPopup) {
    // 「正在读取…」那个窗口已经在了，等它建完就原地刷内容，不另起一个
    await pendingStartPopup;
    popupManager.update({ sourceText: body, translation: '', truncated, status: '正在翻译…', error: '' });
  } else {
    // 先弹骨架，翻译回来再 update——不要让用户对着空窗等
    await popupManager.showTranslationPopup({
      mode: 'selection',
      sourceText: body,
      translation: '',
      truncated,
      status: '正在翻译…',
    });
  }

  let result;
  try {
    const res = await fetch(`http://localhost:${backendApp.port}/v1/translate-en2zh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
      signal: controller.signal,
    });
    if (myOp !== popupOpId) return;          // 已有更新的操作，直接丢弃
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      result = { status: '翻译失败', error: describeHttpError(res.status, data) };
    } else if (typeof data.translation !== 'string' || !data.translation) {
      result = { status: '翻译失败', error: '翻译服务返回了空译文。' };
    } else {
      result = { status: '完成', translation: data.translation, error: '' };
    }
  } catch (error) {
    if (myOp !== popupOpId) return;
    // abort 有两个来源：超时我们自己触发的，和被新操作顶掉的。
    // 后者已经由上面的 id 检查处理，这里只可能是超时。
    result = controller.signal.aborted
      ? { status: '翻译超时', error: '翻译服务超过 20 秒未响应，可点「重试」再试一次。' }
      : { status: '翻译失败', error: `无法连接本地翻译服务：${error.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (myOp !== popupOpId) return;
  popupManager.update({
    translation: result.translation || '',
    status: result.status,
    error: result.error || '',
  });
  logSelectionMeta('done', {
    op: myOp, status: result.status, ms: Date.now() - startedAt,
    outLen: (result.translation || '').length,
  });
}

// 鉴权 / 配额 / 参数错误要给用户能分辨的说法，不能一律显示「翻译失败」
function describeHttpError(status, data) {
  const code = data && (data.code || data.error);
  if (status === 401 || status === 403) return '云端密钥未配置或无效，请检查 .env。';
  if (status === 429) return '调用配额已用尽，请稍后再试。';
  if (status === 400 || status === 413) return `请求被拒绝：${code || status}`;
  if (status >= 500) return `翻译服务异常（HTTP ${status}），可重试。`;
  return `翻译失败（HTTP ${status}${code ? ' ' + code : ''}）。`;
}

function startSelectionWatcher() {
  // 平台守卫：划词依赖 Windows 的剪贴板序号（GetClipboardSequenceNumber）
  if (process.platform !== 'win32') return null;
  if (selectionCapture) return selectionCapture;

  selectionCapture = createSelectionCapture({
    // 只读。整个划词链路没有任何写剪贴板的调用。
    readText: () => clipboard.readText(),
    // 备用通道：剪贴板里没有**新的**纯文本时，才用 UIA 读选区
    readSelection: readActiveSelection,
    onCaptureStart: () => {
      // 判定为双复制的瞬间就出声，不要静默等待——用户要看到「有反应了」
      if (!popupManager) return;
      // 这里返回的 Promise 存起来给 translateSelection 复用，避免一次划词建两个窗
      pendingStartPopup = popupManager.showTranslationPopup({
        mode: 'selection',
        sourceText: '',
        translation: '',
        status: '正在读取…',
      }).finally(() => { pendingStartPopup = null; });
    },
    onCaptured: handleSelectionCaptured,
    onUnreadable: handleSelectionUnreadable,
    onWatcherError: (error) => {
      // 只记错误本身，不记任何文本
      // eslint-disable-next-line no-console
      console.warn('[linguamate-desktop] clipboard watcher error:', error && error.message);
    },
    onSweep: (result) => {
      // 上一轮崩溃留下的孤儿监听目录。只记目录名和数量。
      // eslint-disable-next-line no-console
      console.log(
        `[linguamate-desktop] 已清理 ${result.removed.length} 个过期的 ${SCRIPT_DIR_PREFIX}* 临时目录`
        + (result.failed.length ? `（${result.failed.length} 个删不掉）` : ''),
      );
    },
  });
  // eslint-disable-next-line no-console
  console.log(`[linguamate-desktop] 划词监听已启动（双 Ctrl+C，窗口 ${selectionCapture.triggerWindowMs}ms）`);
  return selectionCapture;
}

function stopSelectionWatcher() {
  if (!selectionCapture) return;
  try { selectionCapture.stop(); } catch { /* 已经停了 */ }
  selectionCapture = null;
}

function buildTrayIcon() {
  const width = 16;
  const height = 16;
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = rowStart + 1 + x * 4;
      const t = (x + y) / 30;
      raw[i] = Math.round(199 - 30 * t);
      raw[i + 1] = Math.round(169 - 25 * t);
      raw[i + 2] = Math.round(255 - 20 * t);
      raw[i + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return nativeImage.createFromBuffer(Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = PNG_CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// ══════════════════════════════════════════════════════════════════════
// 步骤 6B：截图翻译串接
//
// 流程：用户显式触发（Ctrl+Shift+S / 托盘菜单 / 弹窗上的 [截图翻译]）
//   → 全屏覆盖层拖框 → **先关覆盖层再截屏**（步骤 5 的核心约束）
//   → /v1/ocr → 合并段落、截 500 字 → **一次** /v1/translate-en2zh → 弹窗
//
// 硬约束（逐条对应计划「明确不做的事」）：
//  · **绝不自动截图**。三个入口全都要用户自己触发。划词读不到内容时只在弹窗上
//    给一个 [截图翻译] 按钮，那条路径上绝不在背地里调 captureScreenRegion()。
//  · PNG **只在内存里**流转：不落盘、不进日志、不进弹窗。
//    screenshot-window 的 saveDebugShot 在生产路径上永远是 null。
//  · 本节不写剪贴板。截图和划词共用同一个弹窗，写的能力收在 popup-manager
//    内部，这里连方法都碰不到。
// ══════════════════════════════════════════════════════════════════════

// OCR 比翻译慢（图片载荷大、腾讯那边排队），给更长的时间窗。
const OCR_TIMEOUT_MS = 30000;

let screenshotHotkeyRegistered = false;
let screenshotAccelerator = DEFAULT_SCREENSHOT_SHORTCUT;
// 只留最近一张截图的 base64，供弹窗上的 [重试] 重发 OCR——用户不必重新框选。
// 生命周期：下一次截图开始时立刻清掉，进程退出时清掉。最多同时存在一张，
// 且**从不落盘、不进日志**。与弹窗持有原文是同一类：内存里短暂存在。
let lastScreenshotPng = null;

function screenshotHotkeyLabel() {
  const accel = String(screenshotAccelerator).replace(/CommandOrControl/g, 'Ctrl');
  return screenshotHotkeyRegistered
    ? `截图翻译（${accel}）`
    : `截图翻译（${accel}，快捷键被占用，请从菜单启动）`;
}

function logScreenshotMeta(event, extra = {}) {
  if (!process.env.LINGUAMATE_DEBUG) return;
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`);
  // eslint-disable-next-line no-console
  console.log(`[screenshot] ${event}${parts.length ? ' ' + parts.join(' ') : ''}`);
}

// 截图本身失败时的说法。分清「用户选错了」和「系统/服务出问题了」——
// 前者重试没用（同一张图），后者该重试。
function describeCaptureFailure(result) {
  switch (result && result.reason) {
    case 'too-large':
      return {
        status: '截图过大',
        error: `截图 ${Math.round((result.bytes || 0) / 1024)} KB 超过 ${Math.round((result.maxBytes || 0) / 1024)} KB 上限，请框选更小的区域。`,
        retryable: false,
      };
    case 'display-not-found':
      return { status: '截图失败', error: '没找到这块屏幕，无法截图。', retryable: false };
    case 'empty-crop':
      return { status: '截图失败', error: '选区太小，截不到内容，请重新框选。', retryable: false };
    case 'timeout':
      return { status: '截图超时', error: '60 秒内没有选区，覆盖层已关闭。可重新触发一次。', retryable: true };
    case 'capture-failed':
    default:
      return { status: '截图失败', error: '截屏时发生错误，可重试。', retryable: true };
  }
}

// OCR 失败的说法。腾讯的 providerCode 要能透出来：鉴权/配额和「图片里没字」
// 完全是两回事，混成一个「识别失败」用户就没法判断该不该改配置。
function describeOcrError(status, data) {
  const providerCode = data && data.providerCode;
  if (status === 503) return { status: '未配置', error: '腾讯云 OCR 尚未配置（缺 TENCENT_SECRET_ID / TENCENT_SECRET_KEY），请检查 .env。', retryable: false };
  if (status === 401 || status === 403) return { status: '鉴权失败', error: 'OCR 密钥无效或没有权限，请检查 .env。', retryable: false };
  if (status === 429) return { status: '配额用尽', error: 'OCR 调用配额已用尽，请稍后再试。', retryable: true };
  if (status === 413) return { status: '图片过大', error: (data && data.error) || '图片超过服务端上限。', retryable: false };
  if (status === 400) return { status: '请求被拒绝', error: (data && data.error) || '服务端拒绝了这个请求。', retryable: false };
  if (providerCode === 'FailedOperation.OcrFailed') {
    return { status: '识别失败', error: '腾讯云没能识别这张图，可重试或换一块更清晰的区域。', retryable: true };
  }
  // 图里确实没有文字时，腾讯返的是 **502 + ImageNoText**，不是「200 但段落为空」。
  // 不单列这一条，它会掉进下面的通用 5xx：弹窗显示「OCR 服务异常，可重试」——
  // 而可重试的是**同一张图**，重试一百次结果一样，用户只能一直点重试。
  // （端到端实测：框一块纯白区域，返回的就是 502 / FailedOperation.ImageNoText。）
  if (providerCode === 'FailedOperation.ImageNoText') {
    return {
      status: '未识别到文字',
      error: '这张图里没有识别到文字。可换一块文字更清晰的区域，或框得大一些。',
      retryable: false,
      // 换区域才有意义，重发同一张没有——给的是 [截图翻译]，不是 [重试]
      action: 'screenshot',
    };
  }
  if (status >= 500) return { status: '识别失败', error: `OCR 服务异常${providerCode ? `（${providerCode}）` : ''}，可重试。`, retryable: true };
  return { status: '识别失败', error: (data && data.error) || '识别失败。', retryable: true };
}

/**
 * 截图翻译的完整链路。**只能由用户显式触发**——热键、托盘菜单、或弹窗上的
 * [截图翻译] 按钮，三者都是人的一次点击。函数内部没有任何自动调用的路径。
 */
async function handleScreenshotTranslate() {
  if (!popupManager || !screenshotCapture || !backendApp) {
    logScreenshotMeta('skip', { reason: 'not-ready' });
    return;
  }
  const myOp = ++popupOpId;
  const startedAt = Date.now();
  logScreenshotMeta('start', { op: myOp });

  // 覆盖层要盖住整个屏幕。旧弹窗留着只会悬在遮罩上面（两者都 alwaysOnTop，
  // 谁在上面并不保证），所以先收掉，识别完成后再弹新的。
  popupManager.close();
  // 上一张图就此作废：内存里最多留一张，且必须属于「当前这次」。
  lastScreenshotPng = null;

  const shot = await screenshotCapture.captureScreenRegion();
  if (myOp !== popupOpId) return;                 // 期间用户又触发了别的操作
  // null = 用户取消（Esc / 右键）**或** 已经在截了（连按热键）。两种都不弹窗：
  // 取消时弹一个「已取消」纯属噪声；重复触发时屏幕上已经有一个覆盖层了。
  if (!shot) { logScreenshotMeta('cancelled', { op: myOp }); return; }

  if (shot.ok !== true) {
    const info = describeCaptureFailure(shot);
    logScreenshotMeta('capture-failed', { op: myOp, reason: shot.reason });
    await popupManager.showTranslationPopup({
      mode: 'screenshot',
      sourceText: '',
      translation: '',
      status: info.status,
      error: info.error,
      retryable: info.retryable,
      // 截图阶段就失败 → 手上根本没有图，「重试」只能重新框选
      action: 'screenshot',
    });
    return;
  }

  logScreenshotMeta('captured', {
    op: myOp, bytes: shot.bytes, rect: `${shot.rect.width}x${shot.rect.height}`,
  });
  lastScreenshotPng = shot.pngBase64;
  await runScreenshotOcr(shot.pngBase64, startedAt);
}

/**
 * OCR → 翻译 → 弹窗。单独拆出来是为了让 [重试] 能直接重发**同一张图**：
 * 服务端偶发失败时用户不必重新框选一遍。
 */
async function runScreenshotOcr(pngBase64, startedAt) {
  if (!popupManager || !backendApp) return;
  const myOp = ++popupOpId;

  // 先弹骨架，别让用户对着空窗等腾讯
  await popupManager.showTranslationPopup({
    mode: 'screenshot',
    sourceText: '',
    translation: '',
    status: '正在识别…',
  });
  if (myOp !== popupOpId) return;

  // 两段网络请求各自带超时，但共用同一个 op id：任何一步发现弹窗已经不归自己
  // 了就直接丢弃，绝不往弹窗上写。
  let controller = new AbortController();
  popupAbort = controller;
  let timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);

  let data;
  try {
    const res = await fetch(`http://localhost:${backendApp.port}/v1/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: pngBase64 }),
      signal: controller.signal,
    });
    data = await res.json().catch(() => ({}));
    if (myOp !== popupOpId) return;
    if (!res.ok) {
      const info = describeOcrError(res.status, data);
      // action 要一起透传：未识别到文字时给的是 [截图翻译]（换一块区域），
      // 不是 [重试]（重发同一张图，结果必然一样）。
      popupManager.update({
        status: info.status, error: info.error, retryable: info.retryable, action: info.action,
      });
      logScreenshotMeta('ocr-error', { op: myOp, http: res.status, provider: (data && data.providerCode) || '' });
      return;
    }
  } catch (error) {
    if (myOp !== popupOpId) return;
    const timedOut = controller.signal.aborted;
    const info = timedOut
      ? { status: '识别超时', error: 'OCR 服务超过 30 秒未响应，可点「重试」再试一次。', retryable: true }
      : { status: '识别失败', error: `无法连接本地识别服务：${error.message}`, retryable: true };
    popupManager.update({ status: info.status, error: info.error, retryable: info.retryable });
    logScreenshotMeta('ocr-failed', { op: myOp, timedOut, ms: Date.now() - startedAt });
    return;
  } finally {
    clearTimeout(timer);
  }

  // 段落合并成一段再翻：一次调用而不是每段一次。段数多的时候 N 次调用会把
  // 配额吃光，而且用户看到的也是 N 段译文拼在一起，不如整段翻一次。
  const paragraphs = Array.isArray(data.paragraphs) ? data.paragraphs : [];
  const ocrText = paragraphs
    .map((p) => String((p && p.text) || '').trim())
    .filter(Boolean)
    .join('\n\n');
  logScreenshotMeta('ocr', { op: myOp, paragraphs: paragraphs.length, chars: ocrText.length });

  if (!ocrText) {
    // 图里确实没有可读文字。重发同一张图没有意义，但「换一块区域」有意义。
    popupManager.update({
      status: '未识别到文字',
      error: '这张图里没有识别到文字。可换一块文字更清晰的区域，或框得大一些。',
      retryable: false,
      action: 'screenshot',
    });
    return;
  }

  const { body, truncated } = truncateForTranslate(ocrText);
  popupManager.update({
    sourceText: body,
    translation: '',
    truncated,
    status: '正在翻译…',
    error: '',
    retryable: false,
    action: '',
  });

  clearTimeout(timer);
  controller = new AbortController();
  popupAbort = controller;
  timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  let result;
  try {
    const res = await fetch(`http://localhost:${backendApp.port}/v1/translate-en2zh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
      signal: controller.signal,
    });
    if (myOp !== popupOpId) return;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      result = { status: '翻译失败', error: describeHttpError(res.status, json) };
    } else if (typeof json.translation !== 'string' || !json.translation) {
      result = { status: '翻译失败', error: '翻译服务返回了空译文。' };
    } else {
      result = { status: '完成', translation: json.translation, error: '' };
    }
  } catch (error) {
    if (myOp !== popupOpId) return;
    result = controller.signal.aborted
      ? { status: '翻译超时', error: '翻译服务超过 20 秒未响应，可点「重试」再试一次。' }
      : { status: '翻译失败', error: `无法连接本地翻译服务：${error.message}` };
  } finally {
    clearTimeout(timer);
  }

  if (myOp !== popupOpId) return;
  popupManager.update({
    translation: result.translation || '',
    status: result.status,
    error: result.error || '',
  });
  logScreenshotMeta('translate-done', {
    op: myOp, status: result.status, ms: Date.now() - startedAt,
    outLen: (result.translation || '').length,
  });
}

// 弹窗上的 [截图翻译] 按钮。**只转发这一次点击**——不读剪贴板、不复用选区、
// 不自动截图。要截图就得用户自己在这条链路上再点一下。
function handlePopupScreenshot() {
  void handleScreenshotTranslate();
}

async function bootstrap() {
  ensureAppDataDir();
  await startBackend();
  createFloater();
  popupManager = createPopupManager({
    BrowserWindow,
    screen,
    ipcMain,
    getCursorPoint: () => screen.getCursorScreenPoint(),
    logger: (tag, key, value) => {
      // 只记元数据，绝不记内容（§4.1 + 计划「隐私与数据边界」）
      if (process.env.LINGUAMATE_DEBUG) console.log(`[${tag}] ${key}=${value}`);
    },
    // [重试] 由弹窗渲染层点发，走主进程自己的 payload 重发，
    // 不重新读剪贴板（重读会翻译到用户后来复制的另一段内容）
    onRetry: handlePopupRetry,
    // [截图翻译]：划词读不到内容时的兜底。同样只是转发点击。
    onScreenshot: handlePopupScreenshot,
    // 刻意不传 writeClipboard：写剪贴板的能力由 popup-manager 自己持有，
    // 这样本文件连 clipboard 的写方法都碰不到（计划要求）。
  });

  // 截图覆盖层模块。平台守卫：覆盖层 + desktopCapturer 只在 Windows 上可用。
  if (process.platform === 'win32') {
    screenshotCapture = createScreenshotCapture({
      BrowserWindow,
      screen,
      ipcMain,
      desktopCapturer,
      getCursorPoint: () => screen.getCursorScreenPoint(),
      logger: (tag, key, value) => {
        if (process.env.LINGUAMATE_DEBUG) console.log(`[${tag}] ${key}=${value}`);
      },
      // 刻意不传 saveDebugShot：生产路径下截图**永不落盘**
    });
  }

  createTray();   // 必须在 popupManager 之后：托盘菜单要引用它
  startSelectionWatcher();

  const accelerator = process.env.LINGUAMATE_SHORTCUT || DEFAULT_SHORTCUT;
  registerShortcut(accelerator);

  // 追加截图热键。**顺序要紧**：必须排在 registerShortcut 之后——
  // registerShortcut 开头的 unregisterAll() 会把这里注册的东西清掉。
  if (screenshotCapture) {
    screenshotAccelerator = process.env.LINGUAMATE_SCREENSHOT_HOTKEY || DEFAULT_SCREENSHOT_SHORTCUT;
    const results = registerExtraShortcuts([
      { accelerator: screenshotAccelerator, handler: () => { void handleScreenshotTranslate(); }, label: '截图翻译' },
    ]);
    screenshotHotkeyRegistered = Boolean(results[0] && results[0].ok);
    if (!screenshotHotkeyRegistered) {
      // 失败只代表截图翻译这一个功能不可用，录音和划词完全不受影响
      tray?.setContextMenu(buildTrayMenu());
    }
  }

  showAndFocus();
  if (backendApp) {
    floater.webContents.once('did-finish-load', () => {
      floater.webContents.send('backend:ready', { port: backendApp.port });
    });
    // 不阻塞启动：后台调一次 /health 确认云端密钥是否齐全。
    checkBackendConfig(backendApp.port).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn('[linguamate-desktop] config check failed:', error.message);
    });
  }
}

async function checkBackendConfig(port) {
  // 调一次 /health，任一 provider configured=false 就触发气泡 + 给 renderer 发状态。
  const payload = await fetchHealthSummary(port);
  floater?.webContents.send('config:status', payload);
  if (!payload.configured && tray) {
    try {
      const display = typeof tray.displayBalloon === 'function';
      if (display) {
        tray.displayBalloon({
          title: 'LinguaMate 首次启动',
          content: payload.envPath
            ? `请把云端 .env 放到 ${payload.envPath}，然后从托盘菜单退出后再次启动。`
            : '请按 FIRST_RUN.md 说明配置云端 .env。',
          iconType: 'info',
        });
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[linguamate-desktop] tray balloon failed:', error.message);
    }
  }
}

ipcMain.on('window:hide', () => hideFloater());
ipcMain.handle('clipboard:write', (_event, text) => {
  if (typeof text !== 'string' || !text) return false;
  clipboard.writeText(text);
  return true;
});
ipcMain.handle('shell:openPath', async (_event, target) => {
  if (typeof target !== 'string' || !target) return false;
  // 在 asar 内时用 process.resourcesPath 把路径换到打包资源；这里只用绝对路径。
  const result = await shell.openPath(target);
  return result === '' ? true : result; // 空字符串表示成功；非空是错误消息
});
ipcMain.handle('config:getEnvPath', () => resolveAppDataEnvPath());

async function fetchHealthSummary(port) {
  // 独立的小工具：fetch /health 并归一化成 {configured, envPath, providers}，
  // 给 push（config:status）和 request-response（config:getStatus）两条路径共用。
  let health;
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = await res.json();
  } catch (error) {
    health = { providers: { tencentAsrConfigured: false, translationConfigured: false, cleanupConfigured: false } };
  }
  const providers = {
    asr: !!health.providers?.tencentAsrConfigured,
    translate: !!health.providers?.translationConfigured,
    cleanup: !!health.providers?.cleanupConfigured,
  };
  return {
    configured: Boolean(providers.asr && providers.translate && providers.cleanup),
    envPath: resolveAppDataEnvPath(),
    providers,
  };
}

ipcMain.handle('config:getStatus', async () => {
  if (!backendApp) return { configured: false, envPath: resolveAppDataEnvPath(), providers: { asr: false, translate: false, cleanup: false } };
  return fetchHealthSummary(backendApp.port);
});

app.on('before-quit', () => { stopBackend(); });
