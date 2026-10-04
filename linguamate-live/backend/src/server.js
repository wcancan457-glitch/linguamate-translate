const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

function resolveDotenvPath() {
  // 优先级：桌面端显式注入 > 生产 APPDATA > 项目本地 dev fallback。
  // 阶段 4：让同一份后端既能 dev 模式跑（desktop main.js 注入 backend/.env），
  // 也能在 NSIS 安装后跑（desktop main.js 不注入，让这里 fallback 到 APPDATA）。
  if (process.env.LINGUAMATE_DOTENV_PATH) return process.env.LINGUAMATE_DOTENV_PATH;
  const appdata = process.env.APPDATA;
  if (appdata) {
    const prodEnv = path.join(appdata, 'LinguaMate', '.env');
    try {
      if (fs.existsSync(prodEnv)) return prodEnv;
    } catch { /* 路径异常时静默回退到 dev fallback */ }
  }
  return path.resolve(__dirname, '..', '.env');
}

require('dotenv').config({ path: resolveDotenvPath() });

const DEFAULT_TENCENT_TTS_VOICE = 502001; // 英文女声（默认；TENCENT_TTS_VOICE 可覆盖）
const TENCENT_TTS_HOST = 'tts.tencentcloudapi.com';
const TENCENT_TTS_REGION = 'ap-guangzhou';
const TENCENT_TTS_VERSION = '2019-08-23';
const TENCENT_TTS_SERVICE = 'tts';
const MAX_TENCENT_TTS_CHARS = 150; // 腾讯云基础版单次最多 150 字符（中文按 1 字 = 1 字符计；英文按 1 字母 = 1 字符），超长需要切片。
// 阶段 5 步骤 2：腾讯云 GeneralBasicOCR。
const TENCENT_OCR_HOST = 'ocr.tencentcloudapi.com';
const TENCENT_OCR_REGION = 'ap-guangzhou';
const TENCENT_OCR_VERSION = '2018-11-19';
const TENCENT_OCR_SERVICE = 'ocr';
const MAX_OCR_IMAGE_BYTES = 3 * 1024 * 1024; // 腾讯云单图上限，按**解码后**的真实字节算
// base64 会把体积放大约 4/3，再加 JSON 开销，所以请求体上限必须高于图片上限。
// 这里取 6MB：既能容下 3MB 图片，也能容下略超一点的前端压缩结果。
const MAX_OCR_REQUEST_BYTES = 6 * 1024 * 1024;
const DEFAULT_JSON_BODY_BYTES = 32 * 1024; // 其余端点维持原有 32KB 上限
const DEFAULT_PORT = 8787;
const DEFAULT_PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

const hasTencentCredentials = () => Boolean(
  process.env.TENCENT_APP_ID && process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY,
);
const hasTranslationCredentials = () => Boolean(
  process.env.TRANSLATION_BASE_URL && process.env.TRANSLATION_API_KEY && process.env.TRANSLATION_MODEL,
);
const hasCleanupCredentials = () => Boolean(
  process.env.TRANSLATION_BASE_URL && process.env.TRANSLATION_API_KEY && process.env.CLEANUP_MODEL,
);
const hasTtsCredentials = () => Boolean(
  process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY,
);
// OCR 与 TTS 一样只需要 CAM 的 SecretId/SecretKey，不需要 TENCENT_APP_ID。
const hasOcrCredentials = hasTtsCredentials;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
function hmacSha256(key, input) {
  return crypto.createHmac('sha256', key).update(input, 'utf8').digest();
}

// 腾讯云 v3 签名（TC3-HMAC-SHA256）：见 https://cloud.tencent.com/document/api/1729/101843
// 复用 TENCENT_SECRET_ID / SECRET_KEY（同 ASR 凭据）。
function signTencentCloudV3({ action, payload, secretId, secretKey, host, region, service, version }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    timestamp,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function splitTtsChunks(text, maxChars) {
  // 优先按句号 / 问号 / 感叹号切；剩余部分按 maxChars 硬切。
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      if ((current + sentence).length > maxChars) {
        if (current) chunks.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    } else {
      // 单句超过 maxChars，硬切
      if (current) { chunks.push(current); current = ''; }
      for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function ttsTencent(text, voice) {
  if (!hasTtsCredentials()) {
    throw Object.assign(new Error('腾讯云 TTS 尚未配置（缺 TENCENT_SECRET_ID / TENCENT_SECRET_KEY）。'), { code: 503 });
  }
  const voiceType = Number(voice || process.env.TENCENT_TTS_VOICE || DEFAULT_TENCENT_TTS_VOICE);
  const chunks = splitTtsChunks(text, MAX_TENCENT_TTS_CHARS);
  const buffers = [];
  for (const chunk of chunks) {
    const payload = JSON.stringify({ Text: chunk, VoiceType: voiceType, Codec: 'mp3', SampleRate: 16000, Volume: 0, Speed: 0, SessionId: crypto.randomBytes(16).toString('hex') });
    const { timestamp, authorization } = signTencentCloudV3({
      action: 'TextToVoice',
      payload,
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
      host: TENCENT_TTS_HOST,
      region: TENCENT_TTS_REGION,
      service: TENCENT_TTS_SERVICE,
      version: TENCENT_TTS_VERSION,
    });
    const responseText = await new Promise((resolve, reject) => {
      const req = https.request({
        host: TENCENT_TTS_HOST,
        port: 443,
        path: '/',
        method: 'POST',
        headers: {
          'Authorization': authorization,
          'Content-Type': 'application/json; charset=utf-8',
          'Host': TENCENT_TTS_HOST,
          'X-TC-Action': 'TextToVoice',
          'X-TC-Version': TENCENT_TTS_VERSION,
          'X-TC-Region': TENCENT_TTS_REGION,
          'X-TC-Timestamp': String(timestamp),
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.write(payload, 'utf8');
      req.end();
    });
    if (responseText.statusCode !== 200) {
      throw Object.assign(new Error(`腾讯云 TTS HTTP ${responseText.statusCode}`), { code: responseText.statusCode === 200 ? 502 : responseText.statusCode });
    }
    let parsed;
    try { parsed = JSON.parse(responseText.body); } catch { parsed = { Response: { Audio: '', Error: { Message: responseText.body.slice(0, 200) } } }; }
    if (parsed.Response?.Error) {
      throw Object.assign(new Error(parsed.Response.Error.Message || '腾讯云 TTS 返回错误。'), { code: 502 });
    }
    const audioBase64 = parsed.Response?.Audio;
    if (!audioBase64) throw Object.assign(new Error('腾讯云 TTS 返回为空。'), { code: 502 });
    buffers.push(Buffer.from(audioBase64, 'base64'));
  }
  return Buffer.concat(buffers);
}

function setCors(response, allowedOrigin) {
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function serveStaticFile(request, response, publicDir) {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, filename);
  if (!target.startsWith(`${publicDir}${path.sep}`) && target !== path.join(publicDir, 'index.html')) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  };
  fs.readFile(target, (error, content) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(target)] || 'application/octet-stream' });
    response.end(content);
  });
}

// 阶段 5 步骤 2：上限改为可传入的**字节**数，并按字节累加。
// 原实现用字符串长度判断且超限时 request.destroy()——那会让客户端收到连接重置
// 而不是 413，前端无法区分「请求太大」和「服务挂了」。现在超限只 reject(413)，
// 同时继续把请求流读干净，客户端就能正常收到 JSON 错误。
// 其余端点不传第二个参数，默认仍是 32KB，行为不变。
function readJson(request, maxBytes = DEFAULT_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return; // 已超限：继续消费但丢弃，保证客户端能完整收到 413
      bytes += chunk.length;
      if (bytes > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`请求体超过 ${Math.floor(maxBytes / 1024)} KB 上限。`), { code: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('请求体必须是 JSON。'), { code: 400 })); }
    });
    request.on('error', (error) => { if (!rejected) reject(error); });
  });
}

async function translateFinalSentence(text) {
  if (!hasTranslationCredentials()) {
    throw Object.assign(new Error('翻译服务尚未配置。请填写 TRANSLATION_* 环境变量。'), { code: 503 });
  }
  const baseUrl = process.env.TRANSLATION_BASE_URL.replace(/\/$/, '');
  const model = process.env.TRANSLATION_MODEL;
  const apiResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TRANSLATION_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      messages: [
        { role: 'system', content: 'Translate the complete spoken Chinese input into natural, conversational English. Translate every source sentence and preserve every explicit subject, ownership, object, product noun, proper noun, and number. Never drop a phrase just because it sounds incomplete in isolation. If the source mentions a PPT or presentation, keep that noun in English; do not replace it with an ungrounded “it”. Preserve the speaker’s tone and intended meaning. Return only the English translation.' },
        { role: 'user', content: text },
      ],
    }),
  });
  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) throw Object.assign(new Error(payload.error?.message || '翻译模型调用失败。'), { code: 502 });
  const translation = payload.choices?.[0]?.message?.content?.trim();
  if (!translation) throw Object.assign(new Error('翻译模型没有返回可用文本。'), { code: 502 });
  return translation;
}

async function translateEnglishToChinese(text) {
  // 阶段 5 步骤 1：划词/截图翻译的 EN→CN 方向。
  // 与 translateFinalSentence 同构但**独立实现**——刻意不抽公共函数，
  // 以免改动 CN→EN 这条已在用的录音链路。
  if (!hasTranslationCredentials()) {
    throw Object.assign(new Error('翻译服务尚未配置。请填写 TRANSLATION_* 环境变量。'), { code: 503 });
  }
  const baseUrl = process.env.TRANSLATION_BASE_URL.replace(/\/$/, '');
  const model = process.env.TRANSLATION_MODEL;
  const apiResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TRANSLATION_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      messages: [
        {
          role: 'system',
          content: '把用户给出的英文翻译成自然、准确、连贯的中文。必须译出全部内容，保留所有专有名词、产品名、人名、编号、数字和代码标识符，不要因为某句话脱离上下文就不译。只输出中文译文本身：不要解释、不要复述原文、不要添加原文没有的信息、不要使用引号包裹全文。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) throw Object.assign(new Error(payload.error?.message || '翻译模型调用失败。'), { code: 502 });
  const translation = payload.choices?.[0]?.message?.content?.trim();
  if (!translation) throw Object.assign(new Error('翻译模型没有返回可用文本。'), { code: 502 });
  return translation;
}

async function cleanFinalSentence(text) {
  if (!hasCleanupCredentials()) {
    throw Object.assign(new Error('语言净化模型尚未配置。请在 .env 填写 CLEANUP_MODEL（需为通用对话模型，而非翻译模型）。'), { code: 503 });
  }
  const modelInput = normalizeCleanupText(text);
  if (!modelInput) throw Object.assign(new Error('这段内容只有口头填充词，无需生成净化稿。'), { code: 422 });
  const baseUrl = process.env.TRANSLATION_BASE_URL.replace(/\/$/, '');
  const apiResponse = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.TRANSLATION_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.CLEANUP_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是中文口语转写净化器。用户输入是一整段同一话轮的 ASR 转写，可能有错词，但你不能猜测或纠正事实。输入中的独立“嗯、啊、呃、额”等口头填充词已经由程序预处理；如仍出现，请删除。仅删除无语义的口头填充词、紧邻的无意义重复和明显的自我重启。必须保留原意、人名、专有名词、数字、时间、否定词、语气与句子顺序。不要扩写、总结、翻译、重排、补写或解释。绝不能输出“（空）”“（无内容）”“empty”等占位文字；如果输入没有实际内容，只返回空字符串。若无法确定某个词是否有意义，必须保留。只返回净化后的中文文本。',
        },
        { role: 'user', content: modelInput },
      ],
    }),
  });
  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) throw Object.assign(new Error(payload.error?.message || '语言净化模型调用失败。'), { code: 502 });
  const cleaned = normalizeCleanupText(payload.choices?.[0]?.message?.content || '');
  if (!cleaned) throw Object.assign(new Error('语言净化模型没有返回可用文本。'), { code: 502 });
  return cleaned;
}

function removePlaceholderMarkers(text) {
  return text.replace(/[（(]\s*(?:空|无内容|empty|null|none)\s*[）)]/giu, '').replace(/\s{2,}/gu, ' ');
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

function createTencentAsrUrl() {
  const timestamp = Math.floor(Date.now() / 1000);
  const host = 'asr.cloud.tencent.com';
  const pathname = `/asr/v2/${process.env.TENCENT_APP_ID}`;
  const values = {
    engine_model_type: process.env.TENCENT_ASR_MODEL || '16k_zh_large',
    expired: String(timestamp + 3600),
    needvad: '1',
    nonce: String(crypto.randomInt(1, 1_000_000_000)),
    secretid: process.env.TENCENT_SECRET_ID,
    timestamp: String(timestamp),
    voice_format: '1',
    voice_id: crypto.randomBytes(8).toString('hex'),
    vad_silence_time: '500',
  };
  const params = new URLSearchParams(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)));
  const source = `${host}${pathname}?${params.toString()}`;
  const signature = crypto.createHmac('sha1', process.env.TENCENT_SECRET_KEY).update(source).digest('base64');
  params.set('signature', signature);
  return `wss://${host}${pathname}?${params.toString()}`;
}

function mapTencentResult(payload) {
  if (Number(payload.code) !== 0) {
    return { type: 'error', message: `腾讯云 ASR 错误 ${payload.code}：${payload.message || '未知错误'}` };
  }
  if (payload.final === 1) return { type: 'session_end' };
  const result = payload.result || {};
  const text = result.voice_text_str || result.text || payload.voice_text_str || payload.text || '';
  const sliceType = result.slice_type ?? payload.slice_type;
  return { type: 'transcript', text, isFinal: sliceType === 2 || sliceType === 3 || payload.final === true };
}

// 腾讯在鉴权/配额失败时也走 200 + Error，前端必须能区分：这类错误重试没有意义，
// 要提示用户去检查配置；而限流类错误是应该重试的。绝不在这里一律兜底成「没识别到」。
const OCR_NON_RETRYABLE_PROVIDER_CODES = new Set([
  'AuthFailure', 'AuthFailure.SecretIdNotFound', 'AuthFailure.SecretNotFound',
  'AuthFailure.SignatureFailure', 'AuthFailure.UnauthorizedOperation',
  'UnauthorizedOperation', 'FailedOperation.ServiceIsolate', 'FailedOperation.UserHasNoPrivilege',
  // 服务未开通。真实调用时由腾讯返回，重试一万次也不会变好，只能去控制台开通。
  // 这条是打真实接口才暴露的——桩测试里没造这个码。
  'FailedOperation.UnOpenError',
  // 图片本身有问题，改参数重试也没用。
  'FailedOperation.ImageDecodeError', 'FailedOperation.ImageSizeError',
  'FailedOperation.UnsupportedImageFormat',
]);

// 腾讯在开启 IsWords 时把段落号放在 AdvancedInfo 里，而它是一个 **JSON 字符串**。
// Node 的 base64 解码很宽松：'!!!!not-base64!!!!' 会解出 6 个垃圾字节而不报错。
// 只判「解码后非空」的话，垃圾会被当成图片发给腾讯，白花一次调用还换回一个看不懂的 502。
// 所以再校验文件头，确认确实是一张腾讯支持的图片。
const OCR_IMAGE_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff],       // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x42, 0x4d],             // BMP
  [0x49, 0x49, 0x2a, 0x00], // TIFF (little-endian)
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF (big-endian)
];

function looksLikeImage(buffer) {
  if (buffer.length < 4) return false;
  if (buffer.length >= 12
    && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return OCR_IMAGE_SIGNATURES.some((magic) => magic.every((byte, index) => buffer[index] === byte));
}

function readOcrParagNo(detection) {
  let info = detection?.AdvancedInfo;
  if (!info) return null;
  if (typeof info === 'string') {
    try { info = JSON.parse(info); } catch { return null; }
  }
  // 腾讯的 AdvancedInfo 实际长这样：{"Parag":{"ParagNo":1}}——Parag 是**对象**。
  // 早期按数组写（Parag[0].ParagNo），Array.isArray 恒为 false，段号永远读不出来，
  // 于是每张图都被压成一段，「按段落逐段翻译」等于没做。两种形状都收下。
  const parag = info?.Parag;
  if (!parag) return null;
  const first = Array.isArray(parag) ? parag[0] : parag;
  const no = Number(first?.ParagNo);
  return Number.isFinite(no) ? no : null;
}

function readOcrBox(detection) {
  const polygon = detection?.Polygon;
  if (!Array.isArray(polygon) || !polygon.length) return null;
  const xs = [];
  const ys = [];
  for (const point of polygon) {
    const x = Number(point?.X);
    const y = Number(point?.Y);
    if (Number.isFinite(x)) xs.push(x);
    if (Number.isFinite(y)) ys.push(y);
  }
  if (!xs.length || !ys.length) return null;
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

const OCR_LAYOUT = {
  verticalGapRatio: 0.8,   // 相邻行垂直间距超过行高的这个倍数 → 断成新段落
  leftJumpRatio: 1.0,      // 新一行若突然跳回更靠左的位置 → 视为新的一栏/新段落
  fallbackLineHeight: 20,  // Polygon 缺失时的兜底行高
};

// 两个分组分支必须返回同一种形状，否则 mapOcrParagraphs 取 group.items 时
// 会在其中一条分支上崩掉（曾经真的崩过：异常一路冒到路由变成 502）。
function makeOcrGroup(items) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    const box = readOcrBox(item);
    if (!box) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  return { items, left, top, right, bottom };
}

// 计划里明确要求：不能把每一行都叫作一个段落。
// 有段落号就按段落号分；没有就按版面分行——同一段落的相邻行垂直间距很小，
// 且新行不会突然跳回左边距。
function groupOcrDetections(detections) {
  if (!detections.length) return [];
  const numbers = detections.map(readOcrParagNo);
  if (numbers.every((no) => no !== null)) {
    const groups = [];
    const seen = new Map();
    detections.forEach((detection, index) => {
      const key = numbers[index];
      if (!seen.has(key)) { seen.set(key, groups.length); groups.push([]); }
      groups[seen.get(key)].push(detection);
    });
    return groups.map(makeOcrGroup);
  }
  const groups = [];
  let current = null;
  for (const detection of detections) {
    const box = readOcrBox(detection);
    const lineHeight = box ? (box.bottom - box.top) : OCR_LAYOUT.fallbackLineHeight;
    const continues = current !== null
      && box !== null
      && (box.top - current.bottom) <= lineHeight * OCR_LAYOUT.verticalGapRatio
      && box.left >= current.left - lineHeight * OCR_LAYOUT.leftJumpRatio;
    if (continues) {
      current.items.push(detection);
      current.left = Math.min(current.left, box.left);
      current.top = Math.min(current.top, box.top);
      current.right = Math.max(current.right, box.right);
      current.bottom = Math.max(current.bottom, box.bottom);
    } else {
      current = box
        ? { items: [detection], left: box.left, top: box.top, right: box.right, bottom: box.bottom }
        : { items: [detection], left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      groups.push(current.items);
    }
  }
  return groups.map(makeOcrGroup);
}

function mapOcrParagraphs(detections) {
  const paragraphs = [];
  for (const group of groupOcrDetections(detections)) {
    const lines = group.items
      .map((d) => ({ text: String(d?.DetectedText ?? '').trim(), confidence: Number(d?.Confidence) }))
      .filter((line) => line.text.length > 0);
    if (!lines.length) continue;
    const confidences = lines.map((l) => l.confidence).filter(Number.isFinite);
    paragraphs.push({
      // 换行保留原始版面，换行对后续翻译没有坏处，去掉反而会粘词
      text: lines.map((l) => l.text).join('\n'),
      // 段落置信度取各行最小值：宁可报低，也不要把模糊行报成可读
      confidence: confidences.length ? Math.min(...confidences) : 0,
      location: Number.isFinite(group.left)
        ? { left: Math.round(group.left), top: Math.round(group.top), right: Math.round(group.right), bottom: Math.round(group.bottom) }
        : null,
    });
  }
  return paragraphs;
}

async function tencentOcr(imageBase64) {
  if (!hasOcrCredentials()) {
    throw Object.assign(new Error('腾讯云 OCR 尚未配置（缺 TENCENT_SECRET_ID / TENCENT_SECRET_KEY）。'), { code: 503 });
  }
  // PdfPageNumber 是**从 1 开始**的页码，传 0 越界会让腾讯直接回
  // FailedOperation.OcrFailed（而不是参数错误），非 PDF 时干脆不发这个字段。
  // 2026-09-29 实测：带 PdfPageNumber:0 必失败(2/2)，去掉后同一张图 conf=100。
  // IsWords 必须开：AdvancedInfo.Parag 只在这个开关打开时才返回，而段号就靠它。
  const payload = JSON.stringify({ ImageBase64: imageBase64, LanguageType: 'auto', IsPdf: false, IsWords: true });
  const { timestamp, authorization } = signTencentCloudV3({
    action: 'GeneralBasicOCR',
    payload,
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
    host: TENCENT_OCR_HOST,
    region: TENCENT_OCR_REGION,
    service: TENCENT_OCR_SERVICE,
    version: TENCENT_OCR_VERSION,
  });
  const responseText = await new Promise((resolve, reject) => {
    const req = https.request({
      host: TENCENT_OCR_HOST,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: TENCENT_OCR_HOST,
        'X-TC-Action': 'GeneralBasicOCR',
        'X-TC-Version': TENCENT_OCR_VERSION,
        'X-TC-Region': TENCENT_OCR_REGION,
        'X-TC-Timestamp': String(timestamp),
        'Content-Length': Buffer.byteLength(payload, 'utf8'),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload, 'utf8');
    req.end();
  });
  if (responseText.statusCode !== 200) {
    throw Object.assign(new Error(`腾讯云 OCR HTTP ${responseText.statusCode}`), { code: 502, providerCode: `HTTP_${responseText.statusCode}` });
  }
  let parsed;
  try { parsed = JSON.parse(responseText.body); } catch { parsed = null; }
  const providerError = parsed?.Response?.Error;
  if (providerError) {
    const providerCode = String(providerError.Code || 'Unknown');
    throw Object.assign(
      new Error(providerError.Message || '腾讯云 OCR 返回错误。'),
      { code: 502, providerCode, isProviderConfigError: OCR_NON_RETRYABLE_PROVIDER_CODES.has(providerCode) },
    );
  }
  if (!parsed || !Array.isArray(parsed.Response?.TextDetections)) {
    throw Object.assign(new Error('腾讯云 OCR 未返回可用的识别结果。'), { code: 502, providerCode: 'MalformedResponse' });
  }
  return mapOcrParagraphs(parsed.Response.TextDetections);
}

function createApp(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const allowedOrigin = options.allowedOrigin ?? process.env.ALLOWED_ORIGIN ?? '*';
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;

  const httpServer = http.createServer(async (request, response) => {
    setCors(response, allowedOrigin);
    if (request.method === 'OPTIONS') return response.writeHead(204).end();

    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, {
        ok: true,
        service: 'linguamate-live-backend',
        providers: {
          tencentAsrConfigured: hasTencentCredentials(),
          translationConfigured: hasTranslationCredentials(),
          cleanupConfigured: hasCleanupCredentials(),
        },
      });
    }

    if (request.method === 'POST' && request.url === '/v1/translate') {
      try {
        const { text } = await readJson(request);
        if (typeof text !== 'string' || !text.trim()) return sendJson(response, 400, { error: 'text 必须是非空字符串。' });
        if (text.length > 2000) return sendJson(response, 413, { error: '单次翻译最多 2000 个字符。' });
        const translation = await translateFinalSentence(text.trim());
        return sendJson(response, 200, { source: text.trim(), translation });
      } catch (error) {
        const code = error.code || 502;
        return sendJson(response, code, { error: error.message || '翻译服务不可用。' });
      }
    }

    if (request.method === 'POST' && request.url === '/v1/translate-en2zh') {
      try {
        const { text } = await readJson(request);
        if (typeof text !== 'string' || !text.trim()) return sendJson(response, 400, { error: 'text 必须是非空字符串。' });
        if (text.length > 2000) return sendJson(response, 413, { error: '单次翻译最多 2000 个字符。' });
        const translation = await translateEnglishToChinese(text.trim());
        return sendJson(response, 200, { source: text.trim(), translation });
      } catch (error) {
        const code = error.code || 502;
        return sendJson(response, code, { error: error.message || '翻译服务不可用。' });
      }
    }

    if (request.method === 'POST' && request.url === '/v1/clean') {
      try {
        const { text } = await readJson(request);
        if (typeof text !== 'string' || !text.trim()) return sendJson(response, 400, { error: 'text 必须是非空字符串。' });
        if (text.length > 2000) return sendJson(response, 413, { error: '单次净化最多 2000 个字符。' });
        const cleaned = await cleanFinalSentence(text.trim());
        return sendJson(response, 200, { source: text.trim(), cleaned });
      } catch (error) {
        const code = error.code || 502;
        return sendJson(response, code, { error: error.message || '语言净化服务不可用。' });
      }
    }

    if (request.method === 'POST' && request.url === '/v1/tts') {
      try {
        const { text, voice } = await readJson(request);
        if (typeof text !== 'string' || !text.trim()) return sendJson(response, 400, { error: 'text 必须是非空字符串。' });
        if (text.length > 2000) return sendJson(response, 413, { error: '单次朗读最多 2000 个字符。' });
        const audio = await ttsTencent(text.trim(), voice);
        response.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
        });
        response.end(audio);
        return;
      } catch (error) {
        const code = error.code || 502;
        return sendJson(response, code, { error: error.message || '语音合成服务不可用。' });
      }
    }

    if (request.method === 'POST' && request.url === '/v1/ocr') {
      try {
        // 用 6MB 而不是默认 32KB：base64 图片会远超原来的上限。
        const { imageBase64 } = await readJson(request, MAX_OCR_REQUEST_BYTES);
        if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
          return sendJson(response, 400, { error: 'imageBase64 必须是非空字符串。' });
        }
        const compact = imageBase64.trim();
        // 3MB 是对**解码后的图片字节**的限制，不是对 base64 字符串长度的限制。
        const image = Buffer.from(compact, 'base64');
        if (image.length === 0) {
          return sendJson(response, 400, { error: 'imageBase64 解码后为空，请传 base64 编码的 PNG/JPG。' });
        }
        if (!looksLikeImage(image)) {
          return sendJson(response, 400, { error: 'imageBase64 解码后不是可识别的图片（支持 PNG/JPEG/GIF/BMP/TIFF/WEBP）。' });
        }
        if (image.length > MAX_OCR_IMAGE_BYTES) {
          return sendJson(response, 413, {
            error: `图片 ${(image.length / 1024 / 1024).toFixed(2)} MB，超过 ${MAX_OCR_IMAGE_BYTES / 1024 / 1024} MB 上限。`,
          });
        }
        const paragraphs = await tencentOcr(compact);
        return sendJson(response, 200, { paragraphs });
      } catch (error) {
        const code = error.code || 502;
        const payload = { error: error.message || 'OCR 服务不可用。' };
        // 把腾讯的错误码带给前端：鉴权/配额失败必须显式提示，
        // 不能和「图片里没识别到文字」共用一个兜底。
        if (error.providerCode) {
          payload.providerCode = error.providerCode;
          payload.retryable = !error.isProviderConfigError;
        }
        return sendJson(response, code, payload);
      }
    }

    if (request.method === 'GET') return serveStaticFile(request, response, publicDir);
    return sendJson(response, 404, { error: 'Not found' });
  });

  const wsServer = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, `http://${request.headers.host}`).pathname !== '/v1/asr/tencent') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (client) => wsServer.emit('connection', client, request));
  });

  wsServer.on('connection', (client) => {
    if (!hasTencentCredentials()) {
      client.send(JSON.stringify({ type: 'error', message: '腾讯云 ASR 尚未配置。请填写 TENCENT_* 环境变量。' }));
      client.close(1011, 'Provider not configured');
      return;
    }

    const provider = new WebSocket(createTencentAsrUrl());
    let handshakeComplete = false;
    const handshakeTimer = setTimeout(() => {
      if (!handshakeComplete && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', message: '腾讯云 ASR 握手超时，请重试。' }));
        provider.close();
      }
    }, 10_000);
    provider.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (!handshakeComplete) {
          clearTimeout(handshakeTimer);
          if (Number(payload.code) !== 0) {
            client.send(JSON.stringify(mapTencentResult(payload)));
            provider.close();
            return;
          }
          handshakeComplete = true;
          client.send(JSON.stringify({ type: 'ready' }));
          return;
        }
        const mapped = mapTencentResult(payload);
        client.send(JSON.stringify(mapped));
        if (mapped.type === 'session_end') setTimeout(() => client.close(1000, 'Recognition complete'), 100);
      }
      catch { client.send(JSON.stringify({ type: 'error', message: '收到无法解析的 ASR 响应。' })); }
    });
    provider.on('error', () => client.send(JSON.stringify({ type: 'error', message: '腾讯云 ASR 连接失败，请检查服务开通状态和环境变量。' })));
    provider.on('close', () => {
      clearTimeout(handshakeTimer);
      if (client.readyState === WebSocket.OPEN) client.close();
    });

    client.on('message', (data, isBinary) => {
      if (!handshakeComplete || provider.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        provider.send(data, { binary: true });
        return;
      }
      try {
        const control = JSON.parse(data.toString());
        if (control.type === 'end') provider.send(JSON.stringify({ type: 'end' }));
      } catch {
        client.send(JSON.stringify({ type: 'error', message: '无法识别的客户端控制消息。' }));
      }
    });
    client.on('close', () => { if (provider.readyState === WebSocket.OPEN || provider.readyState === WebSocket.CONNECTING) provider.close(); });
  });

  async function close() {
    for (const client of wsServer.clients) {
      try { client.close(1001, 'server closing'); } catch {}
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { httpServer, wsServer, close, port };
}

function startServer(options = {}) {
  const app = createApp(options);
  return new Promise((resolve, reject) => {
    app.httpServer.once('error', reject);
    app.httpServer.listen(app.port, () => {
      console.log(`LinguaMate backend running at http://localhost:${app.port}`);
      resolve(app);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[linguamate-live-backend] failed to start:', error);
    process.exit(1);
  });
}

// 导出分组/映射函数是为了让段落逻辑能被直接单测——它比 HTTP 往返更容易构造
// 各种腾讯返回形状（带段落号、不带、多行同段、缺 Polygon）。
module.exports = { createApp, startServer, groupOcrDetections, mapOcrParagraphs };