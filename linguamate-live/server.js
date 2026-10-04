require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const hasTencentCredentials = () => Boolean(
  process.env.TENCENT_APP_ID && process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY,
);

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/translate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text || !text.trim()) return sendJson(res, 400, { error: '缺少需要翻译的中文文字。' });
        const translation = await translate(text.trim());
        sendJson(res, 200, { translation });
      } catch (error) {
        sendJson(res, 502, { error: error.message || '翻译服务暂时不可用。' });
      }
    });
    return;
  }

  const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const target = path.resolve(PUBLIC_DIR, `.${urlPath}`);
  if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(target, (error, data) => {
    if (error) return sendText(res, 404, 'Not found');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
});

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function translate(text) {
  const baseUrl = (process.env.TRANSLATION_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.TRANSLATION_API_KEY;
  const model = process.env.TRANSLATION_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('请先在 .env 配置 TRANSLATION_BASE_URL、TRANSLATION_API_KEY 和 TRANSLATION_MODEL。');
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You translate spoken Chinese into natural English. Preserve names, numbers, and intent. Return only the English translation.' },
        { role: 'user', content: text },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || '翻译模型调用失败。');
  const translation = payload.choices?.[0]?.message?.content?.trim();
  if (!translation) throw new Error('翻译模型没有返回文字。');
  return translation;
}

function buildTencentUrl() {
  const appId = process.env.TENCENT_APP_ID;
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({
    engine_model_type: process.env.TENCENT_ASR_MODEL || '16k_zh_large',
    expired: String(timestamp + 3600),
    nonce: String(Math.floor(Math.random() * 1_000_000_000)),
    secretid: secretId,
    timestamp: String(timestamp),
    voice_format: '1',
    voice_id: crypto.randomBytes(8).toString('hex'),
  });
  const host = 'asr.cloud.tencent.com';
  const pathname = `/asr/v2/${appId}`;
  const signSource = `GET${host}${pathname}?${params.toString()}`;
  const signature = crypto.createHmac('sha1', secretKey).update(signSource).digest('base64');
  params.set('signature', signature);
  return `wss://${host}${pathname}?${params.toString()}`;
}

const wss = new WebSocketServer({ server, path: '/asr' });
wss.on('connection', (client) => {
  if (!hasTencentCredentials()) {
    client.send(JSON.stringify({ type: 'error', message: '腾讯云凭证尚未配置。请先填写 .env。' }));
    client.close();
    return;
  }

  const asr = new WebSocket(buildTencentUrl());
  asr.on('open', () => client.send(JSON.stringify({ type: 'ready' })));
  asr.on('message', (raw) => {
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch { return; }
    const result = payload.result || {};
    const text = result.voice_text_str || result.text || payload.voice_text_str || payload.text || '';
    const final = result.slice_type === 2 || result.slice_type === 3 || payload.final === true;
    client.send(JSON.stringify({ type: 'result', text, final, raw: payload }));
  });
  asr.on('error', () => client.send(JSON.stringify({ type: 'error', message: '腾讯云 ASR 连接失败，请检查 .env 与服务开通状态。' })));
  asr.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(); });

  client.on('message', (audio) => { if (asr.readyState === WebSocket.OPEN) asr.send(audio); });
  client.on('close', () => { if (asr.readyState === WebSocket.OPEN || asr.readyState === WebSocket.CONNECTING) asr.close(); });
});

server.listen(PORT, () => console.log(`LinguaMate Live 已启动：http://localhost:${PORT}`));
