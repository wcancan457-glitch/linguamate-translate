// 阶段 3 renderer：阶段 2 链路（麦克风 → 腾讯 ASR → /v1/clean → /v1/translate）
// + 中文/英文复制 + 英文朗读/停止。不显示原始 ASR；不与远端直接通信；只通过
// 主进程 IPC 切录音状态、写剪贴板。TTS 由 renderer 自己调 speechSynthesis。
const $ = (s) => document.querySelector(s);

const status = $('#status');
const zh = $('#zh');
const en = $('#en');
const recordBtn = $('#record-toggle');
const recordLabel = $('#record-label');
const hideBtn = $('#hide');
const copyZhBtn = $('#copy-zh');
const translateZhBtn = $('#translate-zh');
const copyEnBtn = $('#copy-en');
const speakBtn = $('#speak-en');
const speakIconPlay = $('#speak-icon-play');
const speakIconStop = $('#speak-icon-stop');
const speakLabel = $('#speak-en-label');
const speakAudioEl = $('#speak-audio');
let speakBlobUrl = null;

// 阶段 2：腾讯 ASR 自身按 500ms 静默切 final segment，每个 final 直接成 turn。
// 不再做 600ms 客户端合并，避免用户连续说话时 turnTimer 一直被 reset、后面的话
// 永远 flush 不出去的 bug。

let backendPort = null;
let audioContext = null;
let stream = null;
let processor = null;
let pcmPump = null;
let pcmPending = new Uint8Array(0);
let asrSocket = null;
let asrReady = false;
// 本次录音有没有拿到过 final transcript。session_end 无条件会到，哪怕一个字都没识别到；
// 没有这个标志就分不清「识别完了」和「什么都没听见」，而这两者要给用户完全不同的反馈。
let asrTranscriptSeen = false;
// session_end 到底有没有到。onclose 是兜底判断的依据：它必须能区分
// 「服务端正常收尾（session_end 已经报过了）」和「连接被掐断（onclose 先到）」，
// 否则 onclose 会把 session_end 刚给出的准确提示覆盖成更难懂的「连接中断」。
let asrSessionEnded = false;
let endRequested = false;
let endSent = false;
let sessionCloseTimer = null;
let isRecording = false;
let contentEpoch = 0;
let nextTurnId = 0;
let nextCleanTurnId = 0;
let nextEnglishTurnId = 0;
const completedCleanTurns = new Map();
const completedEnglishTurns = new Map();
let cleanChineseSegments = [];
let englishSegments = [];
let isSpeaking = false;
let suppressUserInputEcho = false;
let configStatus = null;
let recordingStartedAt = 0;
let recordingTimer = null;
let zhSpinner = null;
let enSpinner = null;
let busyStatusTimeout = null;
let isManualTranslating = false;

// 后端 /v1/translate 对 text.length > 2000 直接返 413。自己先拦，省一次往返，
// 也省得把后端的报错原文当成界面文案显示。
const MANUAL_TRANSLATE_MAX_CHARS = 2000;

function formatDuration(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startRecordingTimer() {
  recordingStartedAt = Date.now();
  stopRecordingTimer();
  // 250ms 刷新一次，时间精度到秒；录音时长视觉上连续滚动。
  recordingTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    setStatus(`正在聆听 · ${formatDuration(elapsed)}`);
  }, 250);
}

function stopRecordingTimer() {
  if (recordingTimer) clearInterval(recordingTimer);
  recordingTimer = null;
}

function attachSpinner(textarea) {
  if (!textarea) return null;
  const row = textarea.parentNode;
  const existing = row.querySelector('.spinner');
  if (existing) return existing;
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.innerHTML = '<i></i><i></i><i></i>';
  // spinner 用 absolute 居中，不参与 flex 布局；appendChild 到 row 末尾避免影响其它 flex 子元素。
  row.appendChild(spinner);
  return spinner;
}

function detachSpinner(spinner) {
  if (spinner?.parentNode) spinner.parentNode.removeChild(spinner);
}

function showZhSpinner() { if (!zhSpinner) zhSpinner = attachSpinner(zh); }
function hideZhSpinner() { detachSpinner(zhSpinner); zhSpinner = null; }
function showEnSpinner() { if (!enSpinner) enSpinner = attachSpinner(en); }
function hideEnSpinner() { detachSpinner(enSpinner); enSpinner = null; }

// 各阶段 placeholder 跟状态匹配，避免 spinner 在中央 + placeholder 灰字视觉重复。
// translating 时 zh 已经有实际内容（clean 返回了），所以 zh.placeholder 空字符串即可。
const PLACEHOLDERS = {
  idle: { zh: '（录音，或直接输入中文）', en: 'English translation will appear here.' },
  recording: { zh: '聆听中…', en: 'Listening…' },
  cleaning: { zh: '正在整理中文…', en: 'Waiting for Chinese draft…' },
  translating: { zh: '', en: '正在翻译英文…' },
};

function setUiPlaceholders(state) {
  const p = PLACEHOLDERS[state] || PLACEHOLDERS.idle;
  zh.placeholder = p.zh ?? '';
  en.placeholder = p.en ?? '';
}

hideBtn.addEventListener('click', () => window.linguamate?.hideWindow?.('header-button'));
recordBtn.addEventListener('click', () => toggleRecording());
copyZhBtn.addEventListener('click', () => copyText(zh.value, '中文'));
translateZhBtn.addEventListener('click', () => void translateManual());
copyEnBtn.addEventListener('click', () => copyText(en.value, '英文'));
speakBtn.addEventListener('click', () => (isSpeaking ? stopSpeaking() : startSpeaking()));
status.addEventListener('click', () => openConfigTarget());

// 用户编辑时同步 segments；后端再写回时短暂压制 input 事件，避免编辑被覆盖。
zh.addEventListener('input', () => {
  if (suppressUserInputEcho) return;
  cleanChineseSegments = zh.value ? [zh.value] : [];
});
// Ctrl+Enter 提交；不绑裸 Enter —— 这是个可以粘贴多行的翻译框，Enter 该是换行。
zh.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  void translateManual();
});
en.addEventListener('input', () => {
  if (suppressUserInputEcho) return;
  englishSegments = en.value ? [en.value] : [];
});

if (window.linguamate) {
  window.linguamate.onBackendReady(async ({ port }) => {
    backendPort = port;
    setStatus(`后端已就绪。按 Ctrl+Shift+L 说话，或直接在上方输入中文后按 Ctrl+Enter 翻译。`);
    updateSpeakButton();
    // 主动拉一次配置状态，避免 push 模型（main → renderer）的 race condition。
    try {
      const status = await window.linguamate.getConfigStatus?.();
      if (status) {
        configStatus = status;
        applyConfigStatus();
      }
    } catch (error) {
      // 拉失败时保持默认（不显示未配置），录音按钮本身已经能用。
    }
  });
  window.linguamate.onRecordingState(({ active }) => {
    applyRecordingState(Boolean(active));
  });
  window.linguamate.onShortcutStatus((payload) => {
    if (payload.type === 'failed') {
      setStatus(`快捷键注册失败：${payload.reason || '未知原因'}（${payload.accelerator}）`);
      document.body.classList.add('is-error');
    } else if (payload.type === 'registered' && !backendPort) {
      setStatus(`后端启动中…（${payload.accelerator}）`);
    }
  });
  window.linguamate.onConfigStatus((payload) => {
    configStatus = payload || { configured: null, envPath: null };
    applyConfigStatus();
  });
} else {
  setStatus('preload 未加载');
  document.body.classList.add('is-error');
}

function setStatus(text) {
  status.textContent = text;
}

function applyConfigStatus() {
  if (!configStatus) return;
  if (configStatus.configured === true) {
    document.body.classList.remove('is-unconfigured');
    status.removeAttribute('data-clickable');
    return;
  }
  document.body.classList.add('is-unconfigured');
  status.setAttribute('data-clickable', 'true');
  status.title = '点击打开配置文件夹';
  const envPath = configStatus.envPath || '%APPDATA%\\LinguaMate';
  setStatus(`未配置云端密钥：把 .env 放到 ${envPath}（点这里打开该文件夹）`);
}

function openConfigTarget() {
  if (!configStatus || configStatus.configured !== false) return;
  const envFile = configStatus.envPath || window.linguamate?.getEnvPath?.();
  if (!envFile) return;
  // configStatus.envPath 是 .env 文件路径；要打开资源管理器看到 .env + FIRST_RUN.md，
  // 必须传文件夹路径。shell.openPath 对不存在文件会返回非空错误字符串，截掉文件名。
  const envDir = envFile.replace(/[\\/][^\\/]+$/, '');
  window.linguamate?.openPath?.(envDir).then((result) => {
    if (result && result !== true) setStatus(`无法打开配置文件夹：${result}`);
  }).catch((error) => setStatus(`打开配置文件夹失败：${error?.message || '未知错误'}`));
}

function render() {
  suppressUserInputEcho = true;
  zh.value = cleanChineseSegments.join('') || '';
  en.value = englishSegments.join('\n') || '';
  suppressUserInputEcho = false;
}

function applyRecordingState(active) {
  isRecording = active;
  document.body.classList.toggle('is-active', active);
  if (active) {
    recordLabel.textContent = '停止说话';
    recordBtn.classList.add('on');
    // 第二次开始录音：清空前一次的对话内容 + 取消任何挂起的状态切换。
    // contentEpoch 自增会让上一次未返回的 clean / translate fetch 跳过更新。
    if (busyStatusTimeout) { clearTimeout(busyStatusTimeout); busyStatusTimeout = null; }
    hideZhSpinner();
    hideEnSpinner();
    cleanChineseSegments = [];
    englishSegments = [];
    completedCleanTurns.clear();
    completedEnglishTurns.clear();
    nextCleanTurnId = 0;
    nextEnglishTurnId = 0;
    nextTurnId = 0;
    contentEpoch += 1;
    render();
    setStatus('正在聆听 · 00:00');
    setUiPlaceholders('recording');
    startRecordingTimer();
    // 录音时停掉 TTS，避免声音回灌到麦克风
    if (isSpeaking) stopSpeaking();
    startCapture();
    updateSpeakButton();
  } else {
    recordLabel.textContent = '开始说话';
    recordBtn.classList.remove('on');
    stopRecordingTimer();
    // 停止时清掉所有 spinner + 取消任何挂起的状态切换 timeout。
    if (busyStatusTimeout) { clearTimeout(busyStatusTimeout); busyStatusTimeout = null; }
    hideZhSpinner();
    hideEnSpinner();
    // 注意：placeholder 不强制切回 idle——如果用户正在 cleaning / translating 时按停，
    // 让后台请求完成时再切，避免 placeholder 在用户眼前跳来跳去。
    if (asrSocket && asrSocket.readyState === WebSocket.OPEN) {
      setStatus('正在完成本段识别…');
    } else {
      setStatus('录音已停止。按 Ctrl+Shift+L 重新开始。');
    }
    stopCapture();
    updateSpeakButton();
  }
  updateTranslateButton();
}

function toggleRecording() {
  applyRecordingState(!isRecording);
}

function updateSpeakButton() {
  // 录音时禁用朗读按钮
  speakBtn.disabled = isRecording;
  speakBtn.classList.toggle('playing', isSpeaking);
  speakLabel.textContent = isSpeaking ? '停止' : '朗读';
  speakIconPlay.style.display = isSpeaking ? 'none' : '';
  speakIconStop.style.display = isSpeaking ? '' : 'none';
}

// ---------- 净化 + 翻译的有序回填（与 public/app.js 同算法） ----------
function removePlaceholderMarkers(text) {
  return text.replace(/[（(]\s*(?:空|无内容|empty|null|none)\s*[）)]/giu, '').replace(/\s{2,}/gu, ' ').trim();
}

function removeStandaloneFillers(text) {
  let result = text;
  for (let round = 0; round < 3; round += 1) {
    const next = result.replace(/(^|[，。！？、；：\s])(?:嗯+|嗯哼|啊+|呃+|额+|唔+|噢+)(?=[，。！？、；：\s]|$)/gu, '$1');
    if (next === result) break;
    result = next;
  }
  return result
    .replace(/^[，。！？、；：\s]+/gu, '')
    .replace(/[，、；：\s]+$/gu, '')
    .replace(/([。！？])\1+/gu, '$1');
}

function normalizeCleanupText(text) {
  return removeStandaloneFillers(removePlaceholderMarkers(text)).trim();
}

function hasMeaningfulText(text) {
  return removePlaceholderMarkers(text).replace(/[\s，。！？、,.!?;；:：-]/gu, '').length > 0;
}

function flushCompletedTurns() {
  let changed = false;
  while (completedCleanTurns.has(nextCleanTurnId)) {
    cleanChineseSegments.push(completedCleanTurns.get(nextCleanTurnId));
    completedCleanTurns.delete(nextCleanTurnId);
    nextCleanTurnId += 1;
    changed = true;
  }
  while (completedEnglishTurns.has(nextEnglishTurnId)) {
    englishSegments.push(completedEnglishTurns.get(nextEnglishTurnId));
    completedEnglishTurns.delete(nextEnglishTurnId);
    nextEnglishTurnId += 1;
    changed = true;
  }
  if (changed) render();
}

function completeCleanTurn(turnId, text) {
  completedCleanTurns.set(turnId, text);
  flushCompletedTurns();
}

function completeEnglishTurn(turnId, text) {
  completedEnglishTurns.set(turnId, text);
  flushCompletedTurns();
}

// 程序写 .value **不触发** input 事件，所以 englishSegments 不会自己跟上。不显式同步
// 的话，下一次 render()（任一 ASR 段落 flush、或 applyRecordingState 开新文档）会把手
// 动的译文无声抹掉——不报错、不提示，就是「明明翻译了，怎么说话之后又没了」。
function setEnglish(text) {
  const value = text || '';
  en.value = value;
  englishSegments = value ? [value] : [];
}

function updateTranslateButton() {
  // 录音期间置灰：applyRecordingState(true) 会清空两个框，「打了一半被清掉」是最糟的
  // 一种失败——用户还没察觉就丢了。宁可按钮点不动，也不要这种。
  translateZhBtn.disabled = isRecording || isManualTranslating;
}

// 手动输入中文 → 翻译。方向和录音链路一致（CN→EN），所以复用 /v1/translate，
// 不需要新端点、不需要新密钥、不需要改后端。
async function translateManual() {
  if (isRecording || isManualTranslating) return;
  if (!backendPort) {
    setStatus('后端尚未就绪，请稍候再试。');
    return;
  }
  const text = zh.value.trim();
  if (!text) {
    // 中文框是源、英文框是译文：源空了译文一并清，维持「英文永远是中文的译文」这个
    // 不变式。否则用户删完中文还没打上新的，英文还挂着上一句，看着像 bug。
    if (en.value) {
      setEnglish('');
      setStatus('已清空');
    } else {
      setStatus('中文为空，无可翻译内容');
    }
    return;
  }
  if (text.length > MANUAL_TRANSLATE_MAX_CHARS) {
    setStatus(`中文 ${text.length} 字，超过单次 ${MANUAL_TRANSLATE_MAX_CHARS} 字上限，请分段翻译。`);
    return;
  }
  // 刻意不过 /v1/clean：净化是为 ASR 的口水话设计的（删「嗯」「那个」），而用户手打的
  // 就是他要的原话。静默改写违反本项目「绝不修改用户输入」这条底线，直接送 translate。
  const epoch = contentEpoch;
  isManualTranslating = true;
  updateTranslateButton();
  showEnSpinner();
  setUiPlaceholders('translating');
  setStatus('正在翻译英文…');
  try {
    const response = await fetch(`http://localhost:${backendPort}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    // 期间可能已经开了一轮新录音（contentEpoch 自增），那时两个框已被清空、归到新文档，
    // 把这次的译文写回去会污染它——和 translateFinal 用同一套丢弃规则。
    if (epoch !== contentEpoch) return;
    setEnglish(payload.translation);
    setStatus('已完成');
  } catch (error) {
    if (epoch !== contentEpoch) return;
    setStatus(`翻译失败：${error?.message || '未知错误'}`);
  } finally {
    hideEnSpinner();
    isManualTranslating = false;
    // 录音中途开始的话，别把 placeholder 从「聆听中…」硬拽回 idle。
    if (!isRecording) setUiPlaceholders('idle');
    updateTranslateButton();
  }
}

async function translateFinal(text, epoch, turnId) {
  try {
    const response = await fetch(`http://localhost:${backendPort}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (epoch !== contentEpoch) return;
    completeEnglishTurn(turnId, payload.translation);
    hideEnSpinner();
    setUiPlaceholders('idle');
    setStatus('已完成');
  } catch (error) {
    hideEnSpinner();
    if (epoch !== contentEpoch) return;
    completeEnglishTurn(turnId, '');
    setUiPlaceholders('idle');
    setStatus(`翻译失败：${error?.message || '未知错误'}`);
  }
}

async function cleanAndTranslate(text, turnId, epoch) {
  showZhSpinner();
  setUiPlaceholders('cleaning');
  setStatus('正在整理中文…');
  try {
    const response = await fetch(`http://localhost:${backendPort}/v1/clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (epoch !== contentEpoch) return;
    const cleaned = normalizeCleanupText(payload.cleaned);
    if (!hasMeaningfulText(cleaned)) throw new Error('净化结果没有实际内容。');
    completeCleanTurn(turnId, cleaned);
    hideZhSpinner();
    showEnSpinner();
    setUiPlaceholders('translating');
    setStatus('正在翻译英文…');
    translateFinal(cleaned, epoch, turnId);
  } catch (error) {
    hideZhSpinner();
    if (epoch !== contentEpoch) return;
    // 净化失败也尝试翻译原文本，但 spinner 已经清掉；只在最末端的 translate 重新挂 spinner。
    showEnSpinner();
    setUiPlaceholders('translating');
    setStatus('正在翻译英文…');
    completeCleanTurn(turnId, text);
    translateFinal(text, epoch, turnId);
  }
}

function queueTurnProcessing(text) {
  const cleanable = normalizeCleanupText(text);
  if (!hasMeaningfulText(cleanable)) return;
  const epoch = contentEpoch;
  const turnId = nextTurnId;
  nextTurnId += 1;
  cleanAndTranslate(cleanable, turnId, epoch);
}

function receiveFinalSegment(text) {
  const normalized = removePlaceholderMarkers(text);
  if (!hasMeaningfulText(normalized)) return;
  queueTurnProcessing(normalized);
}

// ---------- 录音 + WS ----------
function describeAudioError(error) {
  if (error?.name === 'NotAllowedError' || /permission|denied/i.test(error?.message || '')) {
    return '麦克风权限被拒绝。Windows 设置 → 隐私 → 麦克风 → 打开后重试。';
  }
  if (error?.name === 'NotFoundError') return '没有检测到可用麦克风，请检查设备连接。';
  if (!navigator.mediaDevices?.getUserMedia) return '当前环境不支持麦克风采集。';
  return error?.message || '无法启动麦克风。';
}

async function startCapture() {
  if (!backendPort) {
    setStatus('后端尚未就绪，请稍候再试。');
    applyRecordingState(false);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('当前环境不支持 getUserMedia。');
    applyRecordingState(false);
    return;
  }
  try {
    contentEpoch += 1;
    pcmPending = new Uint8Array(0);
    endRequested = false;
    endSent = false;
    asrReady = false;
    asrTranscriptSeen = false;
    asrSessionEnded = false;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
    });
    asrSocket = new WebSocket(`ws://localhost:${backendPort}/v1/asr/tencent`);
    asrSocket.binaryType = 'arraybuffer';
    asrSocket.onmessage = ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'ready') {
        asrReady = true;
        // 状态栏保持"正在聆听 · mm:ss"，计时器持续跑。
      } else if (message.type === 'error') {
        setStatus(message.message || '腾讯云 ASR 错误');
      } else if (message.type === 'transcript' && message.isFinal) {
        asrTranscriptSeen = true;
        // 5 段流程：1 正在聆听（计时器） → 2 已收到语音，正在识别（短暂） → 3 正在整理中文
        // → 4 正在翻译英文 → 5 已完成。250ms 过渡让用户视觉上看到第 2 段。
        stopRecordingTimer();
        setStatus('已收到语音，正在识别…');
        if (busyStatusTimeout) clearTimeout(busyStatusTimeout);
        busyStatusTimeout = setTimeout(() => {
          busyStatusTimeout = null;
          receiveFinalSegment(message.text);
        }, 250);
      } else if (message.type === 'session_end') {
        asrSessionEnded = true;
        if (asrTranscriptSeen) {
          setStatus('本段识别已完成');
        } else {
          // 一个 final 都没拿到。这时**不能说"已完成"**——那是假话，用户会以为链路坏了。
          // 而且 applyRecordingState(false) 刻意不复位 placeholder（设计上是"等后台请求回来
          // 再切"），可这里根本没有后台请求，于是占位符会永远停在「聆听中…/Listening…」，
          // 配上空的两个框，看起来就像录音功能整个失效了。必须在这里复位。
          if (!isRecording) setUiPlaceholders('idle');
          setStatus('没有听到内容，请检查麦克风后重试。');
        }
      }
    };
    asrSocket.onerror = () => setStatus('ASR 连接失败，请检查后端是否运行。');
    asrSocket.onclose = () => {
      clearTimeout(sessionCloseTimer);
      sessionCloseTimer = null;
      // 不主动 setStatus：录音停止的 status 由 applyRecordingState(false) 接管，
      // "已完成" / "本段识别已完成" 由 onmessage 'session_end' 接管，onclose 不该覆盖。
      // 但 session_end 根本没到的情况要兜底（连接被掐断、超时）：前面那些提示一个都不会
      // 执行，占位符会永远停在「聆听中…」，配上空框，界面看起来就像录音功能整个坏了。
      if (!asrSessionEnded && !isRecording) {
        setUiPlaceholders('idle');
        setStatus('录音连接中断，请重试。');
      }
    };
    audioContext = new AudioContext();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      enqueuePcm(toPcm16k(input, audioContext.sampleRate));
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
    pcmPump = setInterval(pumpPcm, 40);
  } catch (error) {
    setStatus(describeAudioError(error));
    applyRecordingState(false);
  }
}

function stopCapture() {
  try { processor?.disconnect(); } catch {}
  try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
  try { audioContext?.close(); } catch {}
  processor = null;
  stream = null;
  if (audioContext) audioContext = null;
  if (asrSocket && asrSocket.readyState === WebSocket.OPEN) {
    endRequested = true;
  } else if (asrSocket) {
    asrSocket.close();
    asrSocket = null;
  }
  if (pcmPump) clearInterval(pcmPump);
  pcmPump = null;
  if (endRequested) {
    pcmPump = setInterval(pumpPcm, 40);
  }
}

function enqueuePcm(buffer) {
  const chunk = new Uint8Array(buffer);
  const merged = new Uint8Array(pcmPending.length + chunk.length);
  merged.set(pcmPending);
  merged.set(chunk, pcmPending.length);
  pcmPending = merged;
}

function pumpPcm() {
  if (!asrReady || !asrSocket || asrSocket.readyState !== WebSocket.OPEN) return;
  if (pcmPending.length >= 1280) {
    asrSocket.send(pcmPending.slice(0, 1280));
    pcmPending = pcmPending.slice(1280);
    return;
  }
  if (!endRequested || endSent) return;
  if (pcmPending.length) {
    const finalFrame = new Uint8Array(1280);
    finalFrame.set(pcmPending);
    asrSocket.send(finalFrame);
    pcmPending = new Uint8Array(0);
    return;
  }
  endSent = true;
  asrSocket.send(JSON.stringify({ type: 'end' }));
  setStatus('正在完成本段识别…');
  sessionCloseTimer = setTimeout(() => {
    if (asrSocket && asrSocket.readyState === WebSocket.OPEN) asrSocket.close();
    asrSocket = null;
    // 不 setStatus：applyRecordingState(false) 已经设了"录音已停止…"，不要再覆盖。
  }, 8000);
}

function toPcm16k(input, sourceRate) {
  const ratio = sourceRate / 16000;
  const output = new Int16Array(Math.ceil(input.length / ratio));
  for (let i = 0; i < output.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

// ---------- 复制 ----------
async function copyText(text, label) {
  if (!text || !text.trim()) {
    setStatus(`暂无${label}内容可复制`);
    return;
  }
  try {
    const ok = await window.linguamate?.copyToClipboard?.(text);
    if (ok === false) throw new Error('主进程拒绝写入剪贴板');
    setStatus(`${label}已复制（${text.length} 字）`);
  } catch (error) {
    setStatus(`复制失败：${error?.message || '未知错误'}`);
  }
}

// ---------- 英文朗读 / 停止（阶段 5：腾讯云 TTS） ----------
async function startSpeaking() {
  const text = en.value;
  if (!text || !text.trim()) {
    setStatus('暂无英文内容可朗读');
    return;
  }
  if (!backendPort) {
    setStatus('后端尚未就绪，请稍候再试。');
    return;
  }
  // 先停掉任何正在播放的语音，避免叠加
  stopSpeaking();
  setStatus('正在合成语音…');
  try {
    const response = await fetch(`http://localhost:${backendPort}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim() }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    if (speakBlobUrl) URL.revokeObjectURL(speakBlobUrl);
    speakBlobUrl = URL.createObjectURL(blob);
    speakAudioEl.src = speakBlobUrl;
    isSpeaking = true;
    updateSpeakButton();
    setStatus('正在朗读英文…');
    speakAudioEl.play().catch((error) => {
      isSpeaking = false;
      updateSpeakButton();
      setStatus(`朗读失败：${error?.message || '未知错误'}`);
    });
  } catch (error) {
    isSpeaking = false;
    updateSpeakButton();
    setStatus(`朗读失败：${error?.message || '未知错误'}`);
  }
}

function stopSpeaking() {
  try { speakAudioEl.pause(); } catch {}
  try { speakAudioEl.removeAttribute('src'); } catch {}
  try { speakAudioEl.load(); } catch {}
  if (speakBlobUrl) {
    try { URL.revokeObjectURL(speakBlobUrl); } catch {}
    speakBlobUrl = null;
  }
  if (isSpeaking) {
    isSpeaking = false;
    updateSpeakButton();
    setStatus('已停止朗读');
  }
}

// audio 元素自然结束 / 错误 → 自动复位
speakAudioEl.addEventListener('ended', () => {
  isSpeaking = false;
  updateSpeakButton();
  setStatus('朗读结束');
});
speakAudioEl.addEventListener('error', () => {
  isSpeaking = false;
  updateSpeakButton();
  setStatus('朗读失败：音频播放错误');
});

setUiPlaceholders('idle');
render();
updateSpeakButton();
updateTranslateButton();