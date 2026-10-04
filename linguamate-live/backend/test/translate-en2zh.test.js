const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ---------------------------------------------------------------------------
// 测试替身：先于 require(server) 布置，保证本文件永远碰不到真实服务。
// dotenv 不会覆盖已存在的 process.env，所以即使本机 backend/.env 里有真实
// 配置，本测试看到的也只是下面这些假值。outbound 桩进一步保证：任何指向
// 真实域名的请求都会让测试直接失败，而不是悄悄打到一个付费 API 上。
// ---------------------------------------------------------------------------
const STUB_BASE_URL = 'https://stub.invalid';
const STUB_BEARER = 'test-key-not-a-real-secret';
process.env.TRANSLATION_BASE_URL = STUB_BASE_URL;
process.env.TRANSLATION_API_KEY = STUB_BEARER;
process.env.TRANSLATION_MODEL = 'test-model';

const { createApp } = require('../src/server');

const STUB_TRANSLATION = '敏捷的棕色狐狸跳过了那只懒狗。';
const outbound = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  outbound.push({ url: target, auth: String(init.headers?.Authorization || ''), body: init.body ? String(init.body) : '' });
  if (!target.startsWith(STUB_BASE_URL)) throw new Error(`测试桩拦截了非预期的出网请求：${target}`);
  if (init.method !== 'POST') throw new Error(`测试桩未预期的请求方法：${init.method}`);
  return new Response(JSON.stringify({ choices: [{ message: { content: STUB_TRANSLATION } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

after(() => { globalThis.fetch = realFetch; });

// 走 node:http 而不是 fetch，避免和上面的出网桩互相干扰。
let app;
let port;

function post(path, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 保留 raw 供断言使用 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

before(async () => {
  app = createApp({ port: 0, allowedOrigin: 'http://localhost' });
  await new Promise((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  port = app.httpServer.address().port;
});

after(async () => { if (app) await app.close(); });

// ---------------------------------------------------------------- 正常路径 ---

test('en2zh：英文原文返回 200、非空中文译文，并原样回显 source', async () => {
  const source = 'The quick brown fox jumps over the lazy dog.';
  const res = await post('/v1/translate-en2zh', { text: source });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['source', 'translation']);
  assert.equal(res.json.source, source);
  assert.equal(res.json.translation, STUB_TRANSLATION);
  assert.ok(res.json.translation.trim().length > 0);
});

test('en2zh：发给模型的是 EN→CN 指令，user 消息就是原文', async () => {
  const source = 'Deployment finished successfully.';
  outbound.length = 0;
  await post('/v1/translate-en2zh', { text: source });
  assert.equal(outbound.length, 1);
  const call = outbound[0];
  assert.equal(call.url, `${STUB_BASE_URL}/chat/completions`);
  const sent = JSON.parse(call.body);
  assert.equal(sent.messages[1].content, source);
  assert.match(sent.messages[0].content, /中文/);
  assert.equal(sent.messages[0].content.includes('English'), false);
});

test('en2zh：首尾空白被裁剪后再回显 source', async () => {
  const res = await post('/v1/translate-en2zh', { text: '   Hello world.   ' });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'Hello world.');
});

// ------------------------------------------------------------ 参数校验路径 ---

test('en2zh：空串 / 纯空白 / 缺失 / 非字符串 一律 400，且完全不发出网请求', async () => {
  for (const payload of [{}, { text: '' }, { text: '   ' }, { text: 123 }, { text: null }, { text: ['a'] }]) {
    const before = outbound.length;
    const res = await post('/v1/translate-en2zh', payload);
    assert.equal(res.status, 400, `payload ${JSON.stringify(payload)} 应返回 400，实际 ${res.status}`);
    assert.equal(typeof res.json.error, 'string');
    assert.equal(outbound.length, before, '参数非法时不得调用翻译服务');
  }
});

test('en2zh：超过 2000 字符返回 413，且完全不发出网请求', async () => {
  const before = outbound.length;
  const res = await post('/v1/translate-en2zh', { text: 'a'.repeat(2001) });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /2000/);
  assert.equal(outbound.length, before, '超长时不得调用翻译服务');
});

test('en2zh：恰好 2000 字符是合法边界，返回 200', async () => {
  const res = await post('/v1/translate-en2zh', { text: 'a'.repeat(2000) });
  assert.equal(res.status, 200);
});

// ------------------------------------------------------------ 配置与安全 ---

test('en2zh：翻译服务未配置时返回 503', async () => {
  // 键名必须写全——用 base/key/model 这类简写会让 Object.assign 还原成
  // 三个不存在的环境变量，后面的测试就会莫名其妙地吃到 503。
  const saved = {
    TRANSLATION_BASE_URL: process.env.TRANSLATION_BASE_URL,
    TRANSLATION_API_KEY: process.env.TRANSLATION_API_KEY,
    TRANSLATION_MODEL: process.env.TRANSLATION_MODEL,
  };
  delete process.env.TRANSLATION_BASE_URL;
  delete process.env.TRANSLATION_API_KEY;
  delete process.env.TRANSLATION_MODEL;
  try {
    const before = outbound.length;
    const res = await post('/v1/translate-en2zh', { text: 'anything' });
    assert.equal(res.status, 503);
    assert.equal(outbound.length, before);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('en2zh：响应体与错误信息都不含 API key（CLAUDE_HANDOFF §4.1 第 3 条）', async () => {
  const ok = await post('/v1/translate-en2zh', { text: 'Hello world.' });
  const bad = await post('/v1/translate-en2zh', {});
  const tooLong = await post('/v1/translate-en2zh', { text: 'a'.repeat(2001) });
  for (const res of [ok, bad, tooLong]) {
    assert.equal(res.raw.includes(STUB_BEARER), false);
    assert.equal(res.raw.includes('Bearer'), false);
  }
  // 假 key 只出现在出网请求的 Authorization 头里，且不会被打进任何返回值
  assert.ok(outbound.every((c) => !c.auth || c.auth === `Bearer ${STUB_BEARER}`));
});

// ---------------------------------------------------------------- 回归保护 ---

test('回归：既有 /v1/translate（CN→EN 录音链路）契约未被本次改动影响', async () => {
  const res = await post('/v1/translate', { text: '今天天气不错。' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['source', 'translation']);
  assert.equal(res.json.source, '今天天气不错。');

  const empty = await post('/v1/translate', { text: '' });
  assert.equal(empty.status, 400);
  const tooLong = await post('/v1/translate', { text: 'a'.repeat(2001) });
  assert.equal(tooLong.status, 413);
});

test('回归：未知路径仍是 404，新端点没有吞掉静态资源路由', async () => {
  const res = await post('/v1/translate-en2zh-not-a-route', { text: 'x' });
  assert.equal(res.status, 404);
});
