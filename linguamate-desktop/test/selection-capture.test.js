const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSelectionCapture,
  createDoubleCopyDetector,
  createClipboardSequenceWatcher,
  sweepStaleScriptDirs,
  DEBOUNCE_MS,
  TRIGGER_WINDOW_MS,
  SCRIPT_DIR_PREFIX,
  STALE_TMP_MS,
} = require('../src/selection-capture');
const { parseReaderOutput } = require('../src/selection-reader');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 用一个不会真的 spawn PowerShell 的假子进程，把状态机和进程管理分开测。
function fakeSpawn(lines) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  child.emitLines = (text) => child.stdout.emit('data', text);
  child.command = lines;
  return child;
}

// 非 Windows 时 watcher 必须直接报错而不是假装在工作。
const unixSpawn = () => { throw new Error('不应被调用'); };

// ================================================================ 检测状态机

test('单次复制绝不触发：只落定一次事件时没有任何回调', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
  detector.notifyChange();
  await tick(DEBOUNCE_MS + 80);
  assert.equal(fired, 0, '一次复制必须静默');
  assert.equal(detector.isArmed(), true, '应处于已上膛状态，等待第二次');
  detector.dispose();
});

test('连续两次复制在窗口内触发', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
  detector.notifyChange();
  await tick(DEBOUNCE_MS + 60);
  detector.notifyChange();
  await tick(DEBOUNCE_MS + 60);
  assert.equal(fired, 1);
  detector.dispose();
});

test('一次 Ctrl+C 造成的 7-8 次序号递增只算一次复制（去抖生效）', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
  // 模拟 Windows 依次写入多种剪贴板格式：20ms 一次，共 8 次
  for (let i = 0; i < 8; i += 1) {
    detector.notifyChange();
    await tick(20);
  }
  await tick(DEBOUNCE_MS + 100);
  assert.equal(fired, 0, '同一次复制的多次序号递增必须被合并，不能误判成双复制');
  detector.dispose();
});

test('回归：可触发的双复制间隔区间是 [去抖, 触发窗口]，边界由两个常量推导', async () => {
  // 这是一个**刻画测试**：它锁住当前真实行为，而不是表达偏好。
  //
  // 机制：第一次变更在 t=0，去抖在 t=DEBOUNCE_MS 落定并上膛（窗口到
  // t=DEBOUNCE_MS+TRIGGER_WINDOW_MS）。第二次变更在 t=G：
  //   · G < DEBOUNCE_MS → 它落在第一次的去抖窗口内，计时器被重置，
  //     两次合并成**一个**落定事件 → 不触发
  //   · G <= TRIGGER_WINDOW_MS → 第二次落在窗口内 → 触发
  //   · G > TRIGGER_WINDOW_MS → 是两次无关的普通复制 → 不触发
  //
  // 250–300ms 的去抖是用户 2026-09-28 拍板的值（真实手势复验：用户自己的
  // 双击间隔是 500/600ms，两次都成功）。因此 <280ms 的快节奏**不会**触发，
  // 这是一个已知且被接受的边界，不是 bug。收紧它属于用户的决定。
  for (const gap of [TRIGGER_WINDOW_MS - 100, TRIGGER_WINDOW_MS - 300, 500, 600, 800]) {
    let fired = 0;
    const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
    detector.notifyChange();
    await tick(gap);
    detector.notifyChange();
    await tick(DEBOUNCE_MS + 80);
    assert.equal(fired, 1, `间隔 ${gap}ms（用户实测手势 500/600ms 落在这一带）必须触发`);
    detector.dispose();
  }
});

test('回归：快于去抖窗口的两次复制不触发——这是已知边界，不是漏判', async () => {
  // 每个间隔都要**新建**一个 detector：上一个用完之后状态机还处于已上膛状态，
  // 不重置的话第二对会直接触发，测出来的就不是这个边界了。
  for (const gap of [100, 150, 200, 250]) {
    let fired = 0;
    const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
    detector.notifyChange();
    await tick(gap);
    detector.notifyChange();
    await tick(DEBOUNCE_MS + 80);
    assert.equal(fired, 0, `间隔 ${gap}ms < 去抖 ${DEBOUNCE_MS}ms：应被合并成一次复制（用户拍板的取舍）`);
    detector.dispose();
  }
});

test('回归：间隔超过触发窗口的两次复制仍然不能触发（去抖与窗口不得混用）', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
  detector.notifyChange();
  await tick(TRIGGER_WINDOW_MS + 200);
  detector.notifyChange();
  await tick(DEBOUNCE_MS + 80);
  assert.equal(fired, 0, '相隔太久的两次是两次无关的普通复制，必须静默');
  detector.dispose();
});

test('两个时间常量不得互为倍数（混用会让状态机出现判不到的空档）', () => {
  assert.equal(DEBOUNCE_MS, 280, '去抖 250-300ms：用户 2026-09-28 拍板并用真实手势复验过');
  assert.equal(TRIGGER_WINDOW_MS, 1000, '触发窗口由用户定为 1000ms');
  // 状态机要能区分两个分支，触发窗口必须明显宽于去抖
  assert.ok(
    TRIGGER_WINDOW_MS - DEBOUNCE_MS > 500,
    '触发窗口减去去抖必须留出足够宽的可触发区间，否则等于把触发窗口作废',
  );
});

test('同一次复制的多次递增后紧跟一次真复制 → 恰好触发一次', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({ onTrigger: () => { fired += 1; } });
  for (let i = 0; i < 8; i += 1) { detector.notifyChange(); await tick(15); }
  await tick(DEBOUNCE_MS + 100);
  assert.equal(fired, 0);
  for (let i = 0; i < 8; i += 1) { detector.notifyChange(); await tick(15); }
  await tick(DEBOUNCE_MS + 100);
  assert.equal(fired, 1, '真实双击复制只应触发一次');
  detector.dispose();
});

test('间隔超过触发窗口的两次复制不触发（是两次无关的普通复制）', async () => {
  let fired = 0;
  // 用小窗口把测试跑得快：去抖 10ms、窗口 40ms。
  const detector = createDoubleCopyDetector({
    onTrigger: () => { fired += 1; },
    debounceMs: 10,
    triggerWindowMs: 40,
  });
  detector.notifyChange();
  await tick(20);   // t=10ms 落定、上膛，窗口到 t=50ms 关闭
  await tick(60);   // t=80ms，窗口早已关闭
  detector.notifyChange();
  await tick(40);   // t=90ms 再次落定，只是重新上膛
  assert.equal(fired, 0, '窗口外的两次复制不得触发');
  detector.dispose();
});

test('触发后重新回到待命，需要新的一对才会再次触发', async () => {
  let fired = 0;
  const detector = createDoubleCopyDetector({
    onTrigger: () => { fired += 1; },
    debounceMs: 10,
    triggerWindowMs: 200,
  });
  tinyPair(detector);
  await tick(60);
  assert.equal(fired, 1);
  assert.equal(detector.isArmed(), false, '触发后不应仍处于上膛状态');
  tinyPair(detector);
  await tick(60);
  assert.equal(fired, 2);
  detector.dispose();
});

function tinyPair(detector) {
  detector.notifyChange();
  setTimeout(() => detector.notifyChange(), 20);
}

// ================================================================== 监听器

test('监听器：解析 READY 与 CHANGE 行', async () => {
  const seen = [];
  let ready = false;
  const child = fakeSpawn();
  const watcher = createClipboardSequenceWatcher({
    onChange: (seq) => seen.push(seq),
    onReady: () => { ready = true; },
    spawnFn: () => child,
  });
  child.emitLines('LMCLIP READY\n');
  child.emitLines('LMCLIP CHANGE 3001\nLMCLIP CHANGE 30');
  await tick(20);
  assert.equal(ready, true);
  assert.deepEqual(seen, [3001], '没有换行结尾的半行必须留在缓冲里');
  child.emitLines('09\n'); // 补完那一行
  await tick(20);
  assert.deepEqual(seen, [3001, 3009], '半行补完后应合并成完整的一行');
  watcher.stop();
  assert.equal(child.killed, true);
});

test('监听器：脚本必须落盘且是纯 ASCII（PowerShell 5.1 按 GBK 读无 BOM 文件）', () => {
  const child = fakeSpawn();
  let written = null;
  const watcher = createClipboardSequenceWatcher({
    onChange: () => {},
    spawnFn: (_cmd, args) => {
      written = args[args.indexOf('-File') + 1];
      return child;
    },
  });
  assert.ok(written && fs.existsSync(written), '脚本应已落盘');
  const body = fs.readFileSync(written, 'utf8');
  assert.equal(/[^\x00-\x7F]/.test(body), false, '脚本里不能有非 ASCII 字符');
  assert.match(body, /GetClipboardSequenceNumber/);
  assert.equal(/writeText|SetClipboardData|writeText\s*\(/.test(body), false, '监听脚本绝不能碰剪贴板内容');
  watcher.stop();
  assert.equal(fs.existsSync(path.dirname(written)), false, 'stop 后临时目录必须已删除');
});

test('监听器：非 Windows 直接报错，不 spawn 任何东西', () => {
  let errored = null;
  createClipboardSequenceWatcher({ onChange: () => {}, onError: (e) => { errored = e; }, platform: 'darwin', spawnFn: unixSpawn });
  assert.ok(errored, '非 Windows 必须明确报错');
  assert.match(errored.message, /Windows/);
});

test('监听器：子进程意外退出后自动重启', async () => {
  const children = [];
  const errors = [];
  const watcher = createClipboardSequenceWatcher({
    onChange: () => {},
    onError: (e) => errors.push(e),
    spawnFn: () => { const c = fakeSpawn(); children.push(c); return c; },
  });
  assert.equal(children.length, 1);
  children[0].emit('exit', 1);
  await tick(1300);
  assert.equal(children.length, 2, '退出的监听进程必须被拉起来');
  assert.ok(errors.length >= 1, '必须报告过一次退出');
  watcher.stop();
});

// ================================================================== 主入口

// 端到端驱动：把 fake 子进程接到 createSelectionCapture 上，
// 再从「监听器吐出一行 CHANGE」一路走到回调，测的是真实接线而非内部捷径。
function wireCapture(overrides = {}) {
  const events = [];
  const child = fakeSpawn();
  const capture = createSelectionCapture({
    readText: () => '  hello world  ',
    onCaptureStart: () => events.push({ type: 'start' }),
    onCaptured: (p) => events.push({ type: 'captured', source: p.source, text: p.text }),
    onUnreadable: (p) => events.push({ type: 'unreadable', reason: p.reason }),
    onWatcherError: () => {},
    platform: 'win32',
    debounceMs: 20,
    triggerWindowMs: 500,
    spawnFn: () => child,
    ...overrides,
  });
  // 一次 Ctrl+C 在 Windows 上会连续写多种剪贴板格式，序号连跳 7-8 次。
  const copyOnce = () => {
    for (let i = 0; i < 8; i += 1) child.emitLines('LMCLIP CHANGE 3001\n');
  };
  return { capture, child, events, copyOnce };
}

test('主入口：单次复制全程静默——无 start、无 captured、无 unreadable', async () => {
  const { capture, child, events, copyOnce } = wireCapture();
  copyOnce();
  await tick(150);
  assert.deepEqual(events, [], '一次普通复制必须完全没有副作用');
  capture.stop();
});

test('主入口：双复制后先 start 再 captured，且顺序正确（UI 不能沉默等待）', async () => {
  const { capture, child, events, copyOnce } = wireCapture();
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(120);
  assert.deepEqual(events.map((e) => e.type), ['start', 'captured']);
  assert.equal(events[1].source, 'clipboard');
  assert.equal(events[1].text, 'hello world', '必须裁掉首尾空白');
  capture.stop();
});

test('主入口：剪贴板为空时回退到 UIA 备用通道', async () => {
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => '   ',
    readSelection: async () => ({ text: 'from uia' }),
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  assert.deepEqual(events.map((e) => e.type), ['start', 'captured']);
  assert.equal(events[1].source, 'uia', '剪贴板无纯文本时应走备用通道');
  capture.stop();
});

test('主入口：两条通道都拿不到时判 unreadable，绝不翻译旧剪贴板', async () => {
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => '',
    readSelection: async () => null,
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  // 门控：没有内容就**一次骨架都不建**。BADCASE-001 的现场就是这块骨架——
  // 语音输入法写位图被判成双复制后，先摆出来再撤掉，撤不掉时就永远停着。
  assert.deepEqual(events.map((e) => e.type), ['unreadable']);
  assert.equal(events[0].reason, 'no-plain-text');
  assert.equal(events.some((e) => e.type === 'captured'), false, '任何情况下都不得回退去翻译旧内容');
  assert.equal(events.some((e) => e.type === 'start'), false, '空内容时不得建骨架');
  capture.stop();
});

test('门控：剪贴板没有纯文本时全程不建骨架（语音输入法场景）', async () => {
  // 位图写入会把纯文本格式一起清掉，所以 readText() 必然是空。
  // 真正要防的是「先出声再撤回」——撤回成功也是一次闪烁，撤不掉就是死面板。
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => '',
    readSelection: async () => null,
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(200);
  assert.equal(events.filter((e) => e.type === 'start').length, 0, '不得出现任何「正在读取…」骨架');
  capture.stop();
});

test('门控：UIA 给出内容时，骨架在它**之后**才建，不会闪一下又撤掉', async () => {
  let uiaDone = false;
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => '',
    readSelection: async () => { uiaDone = true; return { text: 'from uia' }; },
    onCaptureStart: () => events.push({ type: 'start', uiaDone }),
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  assert.deepEqual(events.map((e) => e.type), ['start', 'captured']);
  assert.equal(events[0].uiaDone, true, '建骨架时内容必须已经在手，不能是先摆一个「正在读取…」再等 300ms');
  capture.stop();
});

test('门控：备用通道自己也抛异常时判 unreadable，同样不建骨架', async () => {
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => '',
    readSelection: async () => { throw new Error('uia exploded'); },
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  assert.deepEqual(events.map((e) => e.type), ['unreadable']);
  capture.stop();
});

test('主入口：readText 抛异常时不得崩，走备用通道', async () => {
  const { capture, child, events, copyOnce } = wireCapture({
    readText: () => { throw new Error('clipboard busy'); },
    readSelection: async () => ({ text: 'recovered' }),
  });
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  assert.deepEqual(events.map((e) => e.type), ['start', 'captured']);
  assert.equal(events[1].text, 'recovered');
  capture.stop();
});

test('主入口：每对复制只回调一次 start，不会连发', async () => {
  const { capture, child, events, copyOnce } = wireCapture();
  copyOnce();
  await tick(60);
  child.emitLines('LMCLIP CHANGE 3009\n');
  await tick(150);
  const afterFirst = events.length;
  // 第三次变更不足以再构成一对
  child.emitLines('LMCLIP CHANGE 3017\n');
  await tick(150);
  assert.equal(events.length, afterFirst, '触发后的单次变更不得再次触发');
  capture.stop();
});

test('主入口：模块里没有任何写剪贴板的调用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-capture.js'), 'utf8');
  assert.equal(/\bwriteText\b|\bwriteHTML\b|clipboard\.write|SetClipboardData|set-clipboard/i.test(src), false);
});

test('主入口：读到的文本不写日志——源码里不得出现 console 与文本同现', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-capture.js'), 'utf8');
  const consoleCalls = src.match(/console\.\w+\([^)]*(text|clipboard)[^)]*\)/gi) || [];
  assert.deepEqual(consoleCalls, [], '不得把读到的文本送进 console');
});

// 门控之后，「读到内容」和「判定为双复制」不再是同一时刻，两条测试各自只能覆盖一半：
// 上面证明 selection-capture 不乱出声，这里证明 main.js 不会替它乱收尾。
test('主入口：压制分支不得再关弹窗（它属于别的操作，不是划词留下的骨架）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // 只看 handleSelectionUnreadable 的函数体，别处关弹窗是合理的
  const start = src.indexOf('function handleSelectionUnreadable');
  assert.notEqual(start, -1, 'handleSelectionUnreadable 必须还在');
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, '必须能定位到函数结尾');
  // 先剥掉行注释：这个函数里正好有一大段解释「为什么这里**不要** close()」的注释，
  // 不剥掉的话测试会匹配到注释本身，然后对着自己的说明文字报错。
  const body = src.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /popupManager\.close\(\)/.test(body),
    false,
    '走到 unreadable 说明一次骨架都没建过；这里 close() 会把用户正在看的截图译文误关掉',
  );
});

test('主入口：骨架只在确认有内容后才建（onCaptureStart 必须晚于 readText）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-capture.js'), 'utf8');
  const fnStart = src.indexOf('async function handleTrigger');
  assert.notEqual(fnStart, -1, 'handleTrigger 必须还在');
  const body = src.slice(fnStart, src.indexOf('\n  return {', fnStart));
  const firstStartCall = body.indexOf('onCaptureStart?.()');
  const readTextCall = body.indexOf('readText?.()');
  assert.notEqual(readTextCall, -1, '必须先读剪贴板');
  assert.notEqual(firstStartCall, -1, '必须有建骨架的分支');
  assert.ok(readTextCall < firstStartCall, 'readText 必须排在第一次 onCaptureStart 之前');
});

// ============================================================ 备用通道解析

test('备用通道：解析 ok + base64（中文往返无损）', () => {
  const original = '敏捷的棕色狐狸跳过了那只懒狗。';
  const b64 = Buffer.from(original, 'utf8').toString('base64');
  const parsed = parseReaderOutput(`LMR\tok\t${b64}\tnotepad`);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.text, original, 'base64 往返必须逐字一致');
});

test('备用通道：各失败状态都能解析出来且不误判成成功', () => {
  assert.equal(parseReaderOutput('LMR\tno-selection\t\tnotepad').text, null);
  assert.equal(parseReaderOutput('LMR\ttimeout\t\tchrome').text, null);
  assert.equal(parseReaderOutput('LMR\tno-foreground\t\t').text, null);
  assert.equal(parseReaderOutput('LMR\terror:MethodException\t\t').status, 'error:MethodException');
  assert.equal(parseReaderOutput('').status, 'no-output');
  assert.equal(parseReaderOutput('garbage line').status, 'no-output');
});

// 回归：状态栏/标签页这类静态文本控件会向 UIA 报告一个「看起来合法」的选区。
// 实测在画图里全选图片后，缩放比例 "100%" 被当成用户选区抓了回来当翻译输入。
// 修法是只扫有键盘焦点的控件子树，且焦点不在前台进程时直接判失败。
test('备用通道：只扫焦点子树（回归：状态栏 100% 被当作用户选区）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-reader.js'), 'utf8');
  assert.match(src, /FocusedElement/, '必须以 FocusedElement 为扫描根');
  assert.match(src, /focus-elsewhere/, '焦点不在前台进程时要有专门的失败状态');
  // 旧的 bug 路径：按 ProcessId 捞整棵窗口树再 BFS，第一个自报选区的节点就返回。
  assert.equal(
    /RootElement\s*\.\s*FindAll/.test(src),
    false,
    '不得再按 ProcessId 扫整棵窗口树——状态栏就是从这条路混进来的',
  );
  assert.equal(/TreeScope\]::Children/.test(src), false, '不得再枚举顶层窗口');
});

test('备用通道：焦点丢失/跑到别的进程时判失败，不返回任何文本', () => {
  assert.equal(parseReaderOutput('LMR\tfocus-elsewhere\t\tchrome').text, null);
  assert.equal(parseReaderOutput('LMR\tno-focus\t\tnotepad').text, null);
  assert.equal(parseReaderOutput('LMR\tfocus-elsewhere\t\tchrome').status, 'focus-elsewhere');
});

test('备用通道：应用名里带制表符也不会污染 status/base64', () => {
  const b64 = Buffer.from('x', 'utf8').toString('base64');
  const parsed = parseReaderOutput(`LMR\tok\t${b64}\tsome\tapp\tname`);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.text, 'x');
});

test('备用通道：非 Windows 直接返回 null，不 spawn PowerShell', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const result = await readActiveSelection({ platform: 'darwin', execFileFn: unixSpawn });
  assert.equal(result, null);
});

test('备用通道：临时目录用完即删', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('linguamate-uia-')).length;
  await readActiveSelection({ execFileFn: (_c, _a, _o, cb) => cb(null, 'LMR\tno-selection\t\tnotepad', '') });
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('linguamate-uia-')).length;
  assert.equal(after, before, 'linguamate-uia-* 临时目录不得残留');
});

test('备用通道：脚本必须在子进程启动时仍然存在（回归：finally 提前删目录）', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  // 这个 bug 真实发生过：cleanup 挂在 finally 上，导致 `return new Promise` 时
  // 目录立刻被删，PowerShell 报「-File 的参数不是实际文件路径」，
  // 整条备用通道静默返回 null。同步回调的假 execFileFn 抓不到它——
  // 必须断言**启动那一刻**文件还在。
  let existedAtSpawn = null;
  let scriptPathSeen = null;
  await readActiveSelection({
    execFileFn: (_cmd, args, _opts, cb) => {
      scriptPathSeen = args[args.indexOf('-File') + 1];
      existedAtSpawn = fs.existsSync(scriptPathSeen);
      // 模拟 PowerShell 异步启动后再回调
      setTimeout(() => cb(null, 'LMR\tok\t' + Buffer.from('x', 'utf8').toString('base64') + '\tnotepad', ''), 30);
    },
  });
  assert.equal(existedAtSpawn, true, '子进程启动时脚本必须已经落盘且未被删除');
  assert.equal(fs.existsSync(scriptPathSeen), false, '回调之后目录必须被清理');
});

test('备用通道：execFileFn 同步抛异常时也要清理目录并返回 null', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('linguamate-uia-')).length;
  const result = await readActiveSelection({
    execFileFn: () => { throw new Error('boom'); },
  });
  assert.equal(result, null);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('linguamate-uia-')).length;
  assert.equal(after, before, '抛异常也必须清理临时目录');
});

test('备用通道：写脚本失败（磁盘满/无权限）时返回 null 且不留目录', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const result = await readActiveSelection({
    fsImpl: { mkdtempSync: () => { throw new Error('EACCES'); } },
  });
  assert.equal(result, null);
});

test('备用通道：PowerShell 起不来时返回 null 而不是抛异常', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const result = await readActiveSelection({
    execFileFn: (_c, _a, _o, cb) => cb(new Error('spawn powershell.exe ENOENT'), '', ''),
  });
  assert.equal(result, null);
});

test('备用通道：PowerShell 报策略拦截时同样返回 null', async () => {
  const { readActiveSelection } = require('../src/selection-reader');
  const result = await readActiveSelection({
    execFileFn: (_c, _a, _o, cb) => cb(new Error('running scripts is disabled on this system'), '', ''),
  });
  assert.equal(result, null);
});

test('备用通道：脚本是纯 ASCII 且不写任何临时数据文件', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'selection-reader.js'), 'utf8');
  assert.equal(/WriteAllText|Out-File|Set-Content|Add-Content|\[IO\.File\]/.test(src), false, '脚本不得把读到的文本写到文件');
  assert.match(src, /ToBase64String/, '文本只应以 base64 走 stdout');
});

test('默认值符合用户已拍板的决定', () => {
  assert.equal(DEBOUNCE_MS, 280, '去抖窗口 250-300ms');
  assert.equal(TRIGGER_WINDOW_MS, 1000, '触发窗口由用户定为 1000ms');
  assert.equal(SCRIPT_DIR_PREFIX, 'linguamate-clip-', '清扫前缀必须和 mkdtemp 用的前缀一致');
  assert.equal(STALE_TMP_MS, 60 * 60 * 1000, '默认阈值 1 小时：dev 与打包版可并存，不能扫到活实例');
});

// ========================================================== 过期临时目录清扫

// 造一批「上次崩溃留下的孤儿目录」，并把 mtime 拨到过去。
function seedDirs(root, specs) {
  const created = [];
  for (const spec of specs) {
    const full = path.join(root, spec.name);
    if (spec.dir !== false) {
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, 'watch.ps1'), '# stub');
    } else {
      fs.writeFileSync(full, '# not a dir');
    }
    if (spec.ageMs > 0) {
      const past = new Date(Date.now() - spec.ageMs);
      fs.utimesSync(full, past, past);
    }
    created.push(spec.name);
  }
  return created;
}

function sweepFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sweep-test-'));
  try {
    const seed = seedDirs(root, options.seed || []);
    const result = sweepStaleScriptDirs({ tmpDir: root, staleMs: 60000, ...options.sweep });
    const survivors = fs.readdirSync(root).sort();
    return { seed, result, survivors };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('清扫：只删过期的孤儿目录，活实例的目录和无关目录一律不动', () => {
  const { result, survivors } = sweepFixture({
    seed: [
      { name: 'linguamate-clip-OLD1', ageMs: 3 * 60 * 60 * 1000 },
      { name: 'linguamate-clip-OLD2', ageMs: 26 * 60 * 60 * 1000 },
      { name: 'linguamate-clip-FRESH', ageMs: 0 },          // 可能是另一个正在跑的实例
      { name: 'linguamate-clip-EDGE', ageMs: 59 * 1000 },   // 刚好卡在阈值内
      { name: 'other-app-temp-OLD', ageMs: 3 * 60 * 60 * 1000 }, // 别人的目录
      { name: 'linguamate-clip-OLD-file', ageMs: 3 * 60 * 60 * 1000, dir: false }, // 同名文件不是目录
    ],
  });
  assert.deepEqual(result.removed.sort(), ['linguamate-clip-OLD1', 'linguamate-clip-OLD2']);
  assert.deepEqual(result.kept.sort(), ['linguamate-clip-EDGE', 'linguamate-clip-FRESH']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(survivors, [
    'linguamate-clip-EDGE',
    'linguamate-clip-FRESH',
    'linguamate-clip-OLD-file',
    'other-app-temp-OLD',
  ], '被删的两个目录必须真的从磁盘上消失，其余原封不动');
});

test('清扫：阈值可调——把 staleMs 调小就能立刻收掉刚才那两个「活」目录', () => {
  const { result, survivors } = sweepFixture({
    seed: [
      { name: 'linguamate-clip-OLD1', ageMs: 3 * 60 * 60 * 1000 },
      { name: 'linguamate-clip-FRESH', ageMs: 0 },
    ],
    sweep: { staleMs: 1, now: Date.now() + 5000 },
  });
  assert.deepEqual(result.removed.sort(), ['linguamate-clip-FRESH', 'linguamate-clip-OLD1']);
  assert.deepEqual(survivors, []);
});

test('清扫：目录读不到时安静返回空结果，不抛异常', () => {
  const result = sweepStaleScriptDirs({ tmpDir: path.join(os.tmpdir(), 'lm-does-not-exist-' + Date.now()) });
  assert.deepEqual(result, { removed: [], kept: [], failed: [] });
});

test('清扫：监听器启动时自动执行一次，且只在首次执行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sweep-watcher-'));
  const staleA = path.join(root, 'linguamate-clip-STALE-A');
  const staleB = path.join(root, 'linguamate-clip-STALE-B');
  const fresh = path.join(root, 'linguamate-clip-FRESH');
  for (const dir of [staleA, staleB, fresh]) fs.mkdirSync(dir, { recursive: true });
  const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(staleA, past, past);

  const sweeps = [];
  const children = [];
  const watcher = createClipboardSequenceWatcher({
    onChange: () => {},
    onSweep: (r) => sweeps.push(r),
    sweepTmpDir: root,
    staleTmpMs: 60000,
    spawnFn: () => { const c = fakeSpawn(); children.push(c); return c; },
  });
  assert.equal(fs.existsSync(staleA), false, '启动时该清掉过期目录');
  assert.equal(fs.existsSync(fresh), true, '新目录不能被误删');
  assert.equal(sweeps.length, 1);
  assert.deepEqual(sweeps[0].removed, ['linguamate-clip-STALE-A']);

  // 子进程崩溃重启时不该再扫一遍：上一轮目录已被 stop/exit 收走。
  const pastB = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(staleB, pastB, pastB);
  children[0].emit('exit', 1);
  await tick(1300);
  assert.equal(children.length, 2, '监听器应已重启');
  assert.equal(sweeps.length, 1, '清扫每次启动只做一次');
  assert.equal(fs.existsSync(staleB), true, '重启那一轮不再清扫');

  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('清扫：sweep:false 可显式关闭，且关闭时不会误报', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-sweep-off-'));
  const stale = path.join(root, 'linguamate-clip-KEEP');
  fs.mkdirSync(stale, { recursive: true });
  const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
  fs.utimesSync(stale, past, past);
  let swept = 0;
  const watcher = createClipboardSequenceWatcher({
    onChange: () => {},
    onSweep: () => { swept += 1; },
    sweep: false,
    sweepTmpDir: root,
    spawnFn: () => fakeSpawn(),
  });
  assert.equal(fs.existsSync(stale), true);
  assert.equal(swept, 0);
  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
