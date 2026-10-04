// 阶段 5 步骤 3：划词翻译的**备用通道**——用 UI Automation 读前台窗口的选区。
//
// 它只在一件事上被调用：双 Ctrl+C 已经确认、但剪贴板里没有可用的纯文本
// （复制的是图片、剪贴板被清空、或应用没提供 CF_UNICODETEXT）。
//
// 步骤 0 实测的覆盖边界（不要当成「已支持应用」清单）：
//   · Notepad  可读
//   · Edge      可读（默认设置即暴露 490 节点）
//   · Chrome    **不可读**——只暴露 4 节点空壳，停在 Chrome Legacy Window；
//               默认轮询、事件订阅、--force-renderer-accessibility 三种方式均失败
//   · WPS       未测（本步骤不依赖它）
// 所以这条通道是「部分覆盖的补充」，不是主路线。

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const READER_TIMEOUT_MS = 3000;

// 计划原本要求脚本把选区文本写进 UTF-8 临时文件（为了绕开 PowerShell stdout 的
// 中文乱码），但同一份计划又要求「临时文件只写元数据、不写读到的文本」——
// 这两条互相矛盾：只写元数据的话调用方根本拿不到文本。
// 这里两边都满足：文本以 base64 走 stdout。base64 是纯 ASCII，乱码问题消失，
// 而用户选中的内容自始至终没有落过盘。脚本本身也只落盘在 mkdtemp 目录里，
// 每次调用独立创建、用完即删。
//
// ASCII-only 这条规矩是真机踩出来的，不是洁癖：PowerShell 5.1 读无 BOM 的 .ps1
// 会按 ANSI/GBK 解释，乱码字节会吞掉行尾换行，把下一行并进注释——
// 表现是某段代码「莫名其妙没执行」，且退出码 0、stderr 全空。
//
// 扫描根是**当前有键盘焦点的那个控件**（FocusedElement），不是整棵窗口树。
// 为什么不能扫整棵树：静态文本控件（状态栏、标签页标题、缩放比例）会向 UIA
// 报告一个「看起来合法」的选区。实测在画图里全选图片后，状态栏的缩放比例
// "100%" 会被当成用户的选区抓回来当翻译输入——触发逻辑完全正确，读到的
// 内容完全错误。
//
// 用户真在选文字时，那段文字必然在**有焦点的控件**里，状态栏不在焦点上。
// 焦点控件不属于当前前台进程时直接判失败（focus-elsewhere），
// **绝不退回全窗口扫描**——那条路正是上面这个 bug。
const READER_SCRIPT = `param([int]$TimeoutMs = 2500)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace LinguaMate -Name Clip -MemberDefinition @'
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@

$AE = [System.Windows.Automation.AutomationElement]
$TP = [System.Windows.Automation.TextPattern]
$CV = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)

function Emit([string]$status, [string]$b64, [string]$app) {
  $clean = ($app -replace '[\t\r\n]', ' ')
  [Console]::Out.WriteLine("LMR\`t$status\`t$b64\`t$clean")
  [Console]::Out.Flush()
}

try {
  $h = [LinguaMate.Clip]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { Emit 'no-foreground' '' ''; exit 0 }
  $pid_ = 0
  [void][LinguaMate.Clip]::GetWindowThreadProcessId($h, [ref]$pid_)
  $app = ''
  try { $app = [string](Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch {}
  if ($pid_ -le 0) { Emit 'no-foreground' '' $app; exit 0 }

  $focus = $null
  try { $focus = $AE::FocusedElement } catch { $focus = $null }
  if ($null -eq $focus) { Emit 'no-focus' '' $app; exit 0 }
  if ($focus.Current.ProcessId -ne [int]$pid_) { Emit 'focus-elsewhere' '' $app; exit 0 }

  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($focus)
  $visited = 0
  $MaxNodes = 1200
  while ($queue.Count -gt 0 -and $visited -lt $MaxNodes) {
    if ((Get-Date) -ge $deadline) { Emit 'timeout' '' $app; exit 0 }
    $node = $queue.Dequeue()
    $visited++
    try {
      $pat = $node.GetCurrentPattern($TP::Pattern)
      if ($null -ne $pat) {
        $sel = $pat.GetSelection()
        if ($null -ne $sel -and $sel.Count -gt 0) {
          $sb = New-Object System.Text.StringBuilder
          foreach ($rg in $sel) { [void]$sb.Append($rg.GetText(-1)) }
          $t = [string]$sb.ToString()
          if ($t.Trim().Length -gt 0) {
            $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))
            Emit 'ok' $b64 $app
            exit 0
          }
        }
      }
    } catch { }
    $sibs = 0
    try { $child = $CV.GetFirstChild($node) } catch { $child = $null }
    while ($null -ne $child -and $sibs -lt 60) {
      $queue.Enqueue($child)
      $sibs++
      try { $child = $CV.GetNextSibling($child) } catch { $child = $null }
    }
  }
  Emit 'no-selection' '' $app
} catch {
  Emit ('error:' + $_.Exception.GetType().Name) '' ''
}
`;

function parseReaderOutput(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('LMR')) continue;
    // 顺序是 status / b64 / app：base64 字符集里不可能有制表符，
    // 所以前两段永远是安全的，只有末段（应用名）可能被制表符切开。
    const parts = line.split('\t');
    const status = parts[1] || '';
    const b64 = parts[2] || '';
    if (status !== 'ok' || !b64) return { status, text: null };
    try {
      return { status, text: Buffer.from(b64, 'base64').toString('utf8') };
    } catch {
      return { status: 'decode-failed', text: null };
    }
  }
  return { status: 'no-output', text: null };
}

/**
 * 读一次前台窗口的选区。
 *
 * 任何异常都吞掉返回 null：这条通道是锦上添花，绝不能因为它把主进程带崩。
 * 读到的文本只在内存里存在，不写日志、不落盘、不进历史。
 *
 * @returns {Promise<{text: string, app: string} | null>}
 */
function readActiveSelection(options = {}) {
  const {
    timeout = READER_TIMEOUT_MS,
    platform = process.platform,
    execFileFn = execFile,
    fsImpl = fs,
  } = options;

  if (platform !== 'win32') return Promise.resolve(null);

  // 先把脚本落盘，再启动子进程；**清理必须挂在回调上，不能用 finally**。
  // `return new Promise(...)` 写在 try 里时，finally 会在返回 Promise 的那一刻
  // 立刻执行——目录会在 PowerShell 还没读到脚本之前就被删掉，
  // 子进程报「-File 的参数不是实际文件路径」，整条备用通道静默失效。
  let scriptDir = null;
  let scriptPath;
  try {
    scriptDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'linguamate-uia-'));
    scriptPath = path.join(scriptDir, 'read-selection.ps1');
    fsImpl.writeFileSync(scriptPath, READER_SCRIPT, 'utf8');
  } catch {
    cleanup();
    return Promise.resolve(null);
  }

  function cleanup() {
    if (!scriptDir) return;
    try { fsImpl.rmSync(scriptDir, { recursive: true, force: true }); } catch { /* 残留不影响正确性 */ }
    scriptDir = null;
  }

  return new Promise((resolve) => {
    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    try {
      execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TimeoutMs', '2500'],
        { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error && !stdout) { finish(null); return; }
          const parsed = parseReaderOutput(stdout || '');
          finish(parsed.text ? { text: parsed.text } : null);
        },
      );
    } catch {
      finish(null);
    }
  });
}

module.exports = { readActiveSelection, parseReaderOutput, READER_TIMEOUT_MS };
