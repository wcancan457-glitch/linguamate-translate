const $ = (selector) => document.querySelector(selector);
const provider = $('#provider');
const recordButton = $('#record');
const status = $('#status');
const dot = $('#dot');
const chinese = $('#chinese');
const english = $('#english');
const draft = $('#draft');
const translating = $('#translating');

let listening = false;
let recognition;
let asrSocket;
let audioContext;
let stream;
let processor;
let pcmPump;
let pcmPending = new Uint8Array(0);
let endRequested = false;
let endSent = false;
let sessionCloseTimer;
let asrReady = false;
let cleanChineseSegments = [];
let englishSegments = [];
let pendingTurnSegments = [];
let turnTimer;
let contentEpoch = 0;
const TURN_IDLE_MS = 600;
let nextTurnId = 0;
let nextCleanTurnId = 0;
let nextEnglishTurnId = 0;
let completedCleanTurns = new Map();
let completedEnglishTurns = new Map();

function describeAudioError(error) {
  if (error?.name === 'NotAllowedError' || /permission|denied/i.test(error?.message || '')) {
    return '麦克风权限被拒绝。请在 Windows 开启“麦克风访问”，然后用 Chrome 或 Edge 打开本页并允许麦克风。';
  }
  if (error?.name === 'NotFoundError') return '没有检测到可用麦克风，请检查设备连接。';
  if (!navigator.mediaDevices?.getUserMedia) return '当前浏览器不支持麦克风采集，请用 Chrome 或 Edge 打开本页。';
  return error?.message || '无法启动麦克风。';
}

function setStatus(message, active = false) {
  status.textContent = message;
  dot.classList.toggle('active', active);
}

function render() {
  chinese.value = cleanChineseSegments.join('');
  english.value = englishSegments.join('\n');
}

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

async function translateFinal(text, epoch = contentEpoch, turnId) {
  translating.textContent = '正在生成英文翻译…';
  try {
    const response = await fetch('/v1/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (epoch !== contentEpoch) return;
    completeEnglishTurn(turnId, payload.translation);
  } catch (error) {
    if (epoch !== contentEpoch) return;
    completeEnglishTurn(turnId, '');
    translating.textContent = error.message || '翻译暂不可用，请检查 .env 配置。';
  } finally {
    setTimeout(() => { if (epoch === contentEpoch) translating.textContent = ''; }, 3500);
  }
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

async function cleanAndTranslate(text, turnId, epoch) {
  translating.textContent = '正在生成净化稿…';
  try {
    const response = await fetch('/v1/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error);
    if (epoch !== contentEpoch) return;
    const cleaned = normalizeCleanupText(payload.cleaned);
    if (!hasMeaningfulText(cleaned)) throw new Error('净化结果没有实际内容。');
    completeCleanTurn(turnId, cleaned);
    draft.textContent = '';
    translateFinal(cleaned, epoch, turnId);
  } catch (error) {
    if (epoch !== contentEpoch) return;
    completeCleanTurn(turnId, text);
    draft.textContent = '';
    translating.textContent = `净化稿暂不可用，已按原文翻译：${error.message || '请检查模型配置。'}`;
    translateFinal(text, epoch, turnId);
  }
}

function queueTurnProcessing(text) {
  const cleanableText = normalizeCleanupText(text);
  if (!hasMeaningfulText(cleanableText)) {
    draft.textContent = '';
    return;
  }
  const epoch = contentEpoch;
  const turnId = nextTurnId;
  nextTurnId += 1;
  cleanAndTranslate(cleanableText, turnId, epoch);
}

function flushPendingTurn() {
  clearTimeout(turnTimer);
  const turnText = pendingTurnSegments.join('');
  pendingTurnSegments = [];
  if (!hasMeaningfulText(turnText)) return;
  queueTurnProcessing(turnText);
}

function receiveFinalSegment(text) {
  const normalized = removePlaceholderMarkers(text);
  if (!hasMeaningfulText(normalized)) return;
  draft.textContent = '正在整理这句话…';
  pendingTurnSegments.push(normalized);
  clearTimeout(turnTimer);
  turnTimer = setTimeout(flushPendingTurn, TURN_IDLE_MS);
}

function startBrowserRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) throw new Error('请在 Chrome 或 Edge 中使用浏览器演示模式。');
  recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) receiveFinalSegment(text); else interim += text;
    }
    if (interim) draft.textContent = '正在识别…';
  };
  recognition.onerror = (event) => setStatus(`识别错误：${event.error}`, false);
  recognition.onend = () => { if (listening) recognition.start(); };
  recognition.start();
}

async function startTencentRecognition() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集，请用 Chrome 或 Edge 打开本页。');
  stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true } });
  asrSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/asr/tencent`);
  asrSocket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'ready') {
      asrReady = true;
      setStatus('腾讯云正在实时识别', true);
    }
    if (message.type === 'error') setStatus(message.message, false);
    if (message.type === 'transcript') {
      if (message.isFinal) receiveFinalSegment(message.text); else if (message.text) draft.textContent = '正在识别…';
    }
    if (message.type === 'session_end') {
      flushPendingTurn();
      setStatus('本段识别已完成', false);
    }
  };
  asrSocket.onerror = () => setStatus('实时识别连接失败，请检查后端是否正在运行。', false);
  asrSocket.onclose = () => {
    clearTimeout(sessionCloseTimer);
    flushPendingTurn();
    if (!listening && endSent) setStatus('本段识别已完成', false);
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
  setStatus('正在完成本段识别…', true);
  sessionCloseTimer = setTimeout(() => asrSocket?.close(), 5000);
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

async function start() {
  try {
    listening = true;
    endRequested = false;
    endSent = false;
    asrReady = false;
    pcmPending = new Uint8Array(0);
    recordButton.classList.add('is-recording');
    recordButton.querySelector('span').textContent = '停止录音';
    setStatus('正在聆听…', true);
    if (provider.value === 'browser') startBrowserRecognition(); else await startTencentRecognition();
  } catch (error) {
    listening = false;
    recordButton.classList.remove('is-recording');
    recordButton.querySelector('span').textContent = '开始说话';
    setStatus(describeAudioError(error), false);
  }
}

function stop() {
  listening = false;
  recognition?.stop();
  processor?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  if (asrSocket?.readyState === WebSocket.OPEN) endRequested = true;
  else asrSocket?.close();
  clearInterval(pcmPump);
  if (endRequested) pcmPump = setInterval(pumpPcm, 40);
  recordButton.classList.remove('is-recording');
  recordButton.querySelector('span').textContent = '开始说话';
  if (!endRequested) flushPendingTurn();
  if (!endRequested) setStatus('已停止', false);
}

recordButton.addEventListener('click', () => listening ? stop() : start());
$('#clear').addEventListener('click', () => {
  contentEpoch += 1;
  clearTimeout(turnTimer);
  pendingTurnSegments = [];
  completedCleanTurns = new Map();
  completedEnglishTurns = new Map();
  nextTurnId = 0;
  nextCleanTurnId = 0;
  nextEnglishTurnId = 0;
  cleanChineseSegments = [];
  englishSegments = [];
  draft.textContent = '';
  translating.textContent = '';
  render();
});
chinese.addEventListener('input', () => { cleanChineseSegments = chinese.value ? [chinese.value] : []; });
english.addEventListener('input', () => { englishSegments = english.value ? [english.value] : []; });

async function copyText(text, label) {
  if (!text.trim()) {
    setStatus(`暂无${label}可复制`, false);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  setStatus(`${label}已复制`, false);
}

$('#copy-chinese').addEventListener('click', () => copyText(chinese.value, '中文'));
$('#copy-english').addEventListener('click', () => copyText(english.value, '英文'));
render();
