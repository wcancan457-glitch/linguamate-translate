// 阶段 5 步骤 3：划词翻译的**主通道**——双 Ctrl+C → 剪贴板。
//
// 核心约束（逐条来自计划 v2 的「明确不做的事」）：
//   · 不拦截、不模拟、不吞掉用户的 Ctrl+C
//   · 绝不写剪贴板——本文件没有任何写剪贴板的调用，也没有引入一个
//   · 不监听并翻译每一次普通复制：单次复制必须完全静默
//   · 读到的文本不写日志、不写文件、不进历史
//
// 为什么用「剪贴板序号监听」而不是「轮询剪贴板内容」：
// 前者平时只知道「变了」，完全不知道内容是什么；后者要持续把用户剪贴板
// 文本读进内存。步骤 0 已实测双 Ctrl+C 一定会让序号继续递增，所以前者够用。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 去抖的职责**只有一个**：把同一次复制自己引发的多次序号递增合并成一次落定事件。
// 「这是不是第二次复制」由触发窗口判断——两者不得混用（计划风险表原文）。
//
// 250–300ms 是**用户 2026-09-28 拍板的值**，并已用真实手势复验
// （用户实际双击间隔 500ms / 600ms，两次都成功触发）。
//
// 代价要说清楚：去抖 280ms 意味着**间隔小于 280ms 的两次复制不会触发**。
// 推导很简单——第一次变更在 t=0，去抖在 t=280 落定并上膛；若第二次变更早于
// t=280 到达，它会把去抖计时器**重置**，两次被合并成一次落定事件，于是不触发。
// 也就是说可触发区间是 [280ms, 1000ms]。
//
// 节奏极快的人（<280ms）会觉得划词"偶尔不灵"。缩短去抖能覆盖这部分人，
// 代价是更依赖「一次复制 = 一个事件」这个前提（富文本来源的复制会分多次递增）。
//
// **不要靠收紧 TRIGGER_WINDOW_MS 来解决误触发。** 2026-10-04 实测：本机一款语音
// 输入法按一次右 Alt 会分两轮写剪贴板（间隔 497/523/559/564ms），落在区间正中，
// 于是每按一次右 Alt 就误触发一次。但**用户自己双击 Ctrl+C 的实测间隔是
// 500/600ms**，两组数值重叠——任何窗口都分不开。收窄只会让划词彻底失灵，
// 而右 Alt 一次都不弹。误触发的压制放在 main.js 的 handleSelectionUnreadable，
// 那里有完整的实测记录。
const DEBOUNCE_MS = 280;
const TRIGGER_WINDOW_MS = 1000;
const WATCHER_POLL_MS = 50;
const WATCHER_RESTART_MS = 1000;

// 监听脚本目录的命名前缀，以及「多久算过期」的阈值。
//
// 为什么需要扫一遍：进程被 SIGKILL（taskkill /F、断电、任务管理器结束任务）时，
// 任何进程内代码都跑不到，cleanupScript() 也就没机会执行，%TEMP% 里会留下孤儿目录。
// 本机实测一轮测试就积了 9 个。优雅退出（托盘 → 退出）会走 will-quit → stop() →
// 清理，是干净的；但崩溃/强杀这条路必须由**下一次启动**来兜底。
//
// 阈值取 1 小时而不是 0：dev 模式与打包版的 userData 路径不同
//（%APPDATA%\linguamate-desktop vs %APPDATA%\LinguaMate），单实例锁拦不住它们同时跑，
// 两个实例的监听目录会并存。按 mtime 判「明显比本次启动早得多」才不会误删另一个
// 活着的实例的目录。1 小时对孤儿目录来说等得起——它只是占几 KB。
const SCRIPT_DIR_PREFIX = 'linguamate-clip-';
const STALE_TMP_MS = 60 * 60 * 1000;

// 常驻监听脚本：只循环取剪贴板**序号**，变了就把序号吐出来。
// 全程不碰剪贴板内容——这是本方案隐私边界的全部意义所在。
// ASCII-only：Windows PowerShell 5.1 按 ANSI/GBK 读无 BOM 的 .ps1。
const WATCHER_SCRIPT = `param([int]$PollMs = 50)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace LinguaMate -Name Clip -MemberDefinition @'
[DllImport("user32.dll")]
public static extern uint GetClipboardSequenceNumber();
'@
[Console]::Out.WriteLine('LMCLIP READY')
[Console]::Out.Flush()
$seq = [LinguaMate.Clip]::GetClipboardSequenceNumber()
while ($true) {
  $now = [LinguaMate.Clip]::GetClipboardSequenceNumber()
  if ($now -ne $seq) {
    $seq = $now
    [Console]::Out.WriteLine("LMCLIP CHANGE $seq")
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds $PollMs
}
`;

// ------------------------------------------------------- 过期临时目录清扫

/**
 * 清掉上一次（或上上次）异常退出留下的孤儿监听目录。
 *
 * 只删 mtime 早于 staleMs 的：见上面 SCRIPT_DIR_PREFIX 处的说明——dev 与打包版
 * 可以同时运行，按「老到不可能还在用」来判定才不会误伤活实例。
 *
 * 全部吞异常：清扫是卫生工作，永远不该让划词功能因为一个删不掉的目录而启动失败。
 *
 * @param {object} [options]
 * @param {string} [options.tmpDir]
 * @param {string} [options.prefix]
 * @param {number} [options.staleMs]
 * @param {number} [options.now]
 * @returns {{ removed: string[], kept: string[], failed: string[] }}
 */
function sweepStaleScriptDirs(options = {}) {
  const {
    tmpDir = os.tmpdir(),
    prefix = SCRIPT_DIR_PREFIX,
    staleMs = STALE_TMP_MS,
    now = Date.now(),
  } = options;

  const removed = [];
  const kept = [];
  const failed = [];
  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { removed, kept, failed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const full = path.join(tmpDir, entry.name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      failed.push(entry.name);
      continue;
    }
    if (now - mtimeMs < staleMs) {
      // 可能是**另一个正在运行的实例**（dev + 打包版并存），或者本次刚建的。
      kept.push(entry.name);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      failed.push(entry.name);
    }
  }
  return { removed, kept, failed };
}

// ---------------------------------------------------------------- 检测状态机

/**
 * 双复制检测的纯状态机：原始变更 → 去抖 → 落定的复制事件 → 窗口内第二次 → 触发。
 * 不碰 Electron、不碰子进程，因此可以完全用假时钟单测。
 *
 * @param {object} options
 * @param {() => void} options.onTrigger 第二次落定事件到达窗口内时调用
 * @param {number} [options.debounceMs]
 * @param {number} [options.triggerWindowMs]
 */
function createDoubleCopyDetector(options = {}) {
  const {
    onTrigger,
    debounceMs = DEBOUNCE_MS,
    triggerWindowMs = TRIGGER_WINDOW_MS,
  } = options;

  let debounceTimer = null;
  let windowTimer = null;

  // 一次落定的复制事件。只有在「已上膛」时才构成第二次，才触发。
  function onSettled() {
    if (windowTimer) {
      clearTimeout(windowTimer);
      windowTimer = null;
      onTrigger();
      return;
    }
    windowTimer = setTimeout(() => { windowTimer = null; }, triggerWindowMs);
  }

  // 原始变更。任何一次变更都只是重置去抖计时器，**不产生任何副作用**。
  function notifyChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onSettled();
    }, debounceMs);
  }

  function reset() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (windowTimer) clearTimeout(windowTimer);
    debounceTimer = null;
    windowTimer = null;
  }

  return {
    notifyChange,
    reset,
    isArmed: () => windowTimer !== null,
    dispose: reset,
  };
}

// ------------------------------------------------------------ 序号监听子进程

/**
 * 常驻 PowerShell 子进程，只循环上报 GetClipboardSequenceNumber() 的**变化**，
 * 读不到、也传不出任何剪贴板内容。
 *
 * 脚本走 -File 落盘而不是 -Command 内联：内联是本项目踩过中文乱码的坑。
 */
function createClipboardSequenceWatcher(options = {}) {
  const {
    onChange,
    onReady,
    onError,
    onSweep,
    pollMs = WATCHER_POLL_MS,
    platform = process.platform,
    spawnFn = spawn,
    sweep = true,
    staleTmpMs = STALE_TMP_MS,
    sweepTmpDir = os.tmpdir(),
  } = options;

  let child = null;
  let scriptDir = null;
  let stopped = false;
  let stdoutBuffer = '';
  let restartTimer = null;
  let swept = false;

  function cleanupScript() {
    if (!scriptDir) return;
    try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* 临时目录残留不影响正确性 */ }
    scriptDir = null;
  }

  // 只在首次 start() 跑一次。重启时上一轮目录已被 cleanupScript() 收走，
  // 再扫一遍既没意义也会和「另一个实例正在建的目录」抢时间。
  function sweepOnce() {
    if (!sweep || swept) return;
    swept = true;
    try {
      const result = sweepStaleScriptDirs({ tmpDir: sweepTmpDir, staleMs: staleTmpMs });
      if (result.removed.length || result.failed.length) {
        // 只报目录名和数量，不涉及任何剪贴板/选区内容。
        onSweep?.(result);
      }
    } catch {
      // 清扫失败绝不能连累监听启动。
    }
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === 'LMCLIP READY') { onReady?.(); return; }
    if (trimmed.startsWith('LMCLIP CHANGE ')) {
      const seq = Number(trimmed.slice('LMCLIP CHANGE '.length));
      onChange?.(Number.isFinite(seq) ? seq : null);
    }
  }

  function start() {
    if (stopped) return;
    if (platform !== 'win32') {
      onError?.(new Error('划词主通道目前只支持 Windows。'));
      return;
    }
    try {
      sweepOnce();
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), SCRIPT_DIR_PREFIX));
      const scriptPath = path.join(scriptDir, 'watch.ps1');
      fs.writeFileSync(scriptPath, WATCHER_SCRIPT, 'utf8');

      child = spawnFn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-PollMs', String(pollMs),
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      cleanupScript();
      onError?.(error);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        handleLine(stdoutBuffer.slice(0, index));
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        index = stdoutBuffer.indexOf('\n');
      }
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { onError?.(error); });
    child.on('exit', (code) => {
      child = null;
      cleanupScript();
      if (stopped) return;
      onError?.(new Error(`剪贴板监听进程已退出（code=${code}）${stderr ? '：' + stderr.slice(0, 200) : ''}`));
      // 常驻进程可能因系统休眠、策略更新等原因被杀，安静地拉起来即可。
      restartTimer = setTimeout(start, WATCHER_RESTART_MS);
      if (restartTimer.unref) restartTimer.unref();
    });
  }

  function stop() {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (child) {
      try { child.kill(); } catch { /* 已经退出了 */ }
      child = null;
    }
    cleanupScript();
  }

  start();
  return { stop, isRunning: () => child !== null };
}

// ------------------------------------------------------------------ 主入口

function readEnvInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * 划词捕获：双 Ctrl+C 主通道 + UIA 备用通道。
 *
 * @param {object} options
 * @param {() => string} options.readText 读剪贴板（Electron clipboard.readText），只读
 * @param {() => Promise<{text: string}|null>} [options.readSelection] 备用通道
 * @param {() => void} options.onCaptureStart 判定为双复制时**立刻**调用，让 UI 显示「正在读取复制文本…」
 * @param {(payload: {text: string, source: string}) => void} options.onCaptured
 * @param {(payload: {reason: string}) => void} options.onUnreadable
 */
function createSelectionCapture(options = {}) {
  const {
    readText,
    readSelection,
    onCaptureStart,
    onCaptured,
    onUnreadable,
    onWatcherError,
    onSweep,
    debounceMs = DEBOUNCE_MS,
    triggerWindowMs = readEnvInt('LINGUAMATE_CLIP_TRIGGER_WINDOW_MS', TRIGGER_WINDOW_MS),
    pollMs = WATCHER_POLL_MS,
    platform = process.platform,
    spawnFn = spawn,
    staleTmpMs = readEnvInt('LINGUAMATE_CLIP_STALE_TMP_MS', STALE_TMP_MS),
  } = options;

  const detector = createDoubleCopyDetector({
    onTrigger: () => { void handleTrigger(); },
    debounceMs,
    triggerWindowMs,
  });
  const watcher = createClipboardSequenceWatcher({
    onChange: () => detector.notifyChange(),
    onError: (error) => onWatcherError?.(error),
    onSweep,
    pollMs,
    platform,
    spawnFn,
    staleTmpMs,
  });

  async function handleTrigger() {
    // 先通知 UI，再去读——绝不让用户对着一个沉默的界面等。
    onCaptureStart?.();

    // 每次触发都**当场重读**，绝不复用上一次读到的内容。
    // 读到空的一律判失败：宁可什么都不做，也不能回退去翻译旧剪贴板。
    let text = '';
    try {
      text = String(readText?.() ?? '');
    } catch {
      text = '';
    }
    if (text.trim()) {
      onCaptured?.({ text: text.trim(), source: 'clipboard' });
      return;
    }

    // 主通道拿不到纯文本（复制的是图片、剪贴板被清空、或应用禁用了纯文本格式），
    // 才轮到备用通道。这里同样绝不触发截图。
    let fallback = null;
    try {
      fallback = await readSelection?.();
    } catch {
      fallback = null;
    }
    const fallbackText = fallback && typeof fallback.text === 'string' ? fallback.text.trim() : '';
    if (fallbackText) {
      onCaptured?.({ text: fallbackText, source: 'uia' });
      return;
    }
    onUnreadable?.({ reason: 'no-plain-text' });
  }

  return {
    stop() {
      detector.dispose();
      watcher.stop();
    },
    isWatching: () => watcher.isRunning(),
    triggerWindowMs,
    debounceMs,
  };
}
module.exports = {
  createSelectionCapture,
  createDoubleCopyDetector,
  createClipboardSequenceWatcher,
  sweepStaleScriptDirs,
  DEBOUNCE_MS,
  TRIGGER_WINDOW_MS,
  WATCHER_POLL_MS,
  SCRIPT_DIR_PREFIX,
  STALE_TMP_MS,
};
