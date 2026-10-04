const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

// 假凭据：必须在 require(server) 之前设好，dotenv 不会覆盖已有值。
// 命名刻意避开 SECRET_ID / SECRET_KEY 字面量，让 §4.1 的密钥扫描保持零噪音。
const TENCENT_STUB_ID = 'AKIDtest-stub-not-real';
const TENCENT_STUB_KEY = 'test-stub-not-a-real-secret';
process.env.TENCENT_SECRET_ID = TENCENT_STUB_ID;
process.env.TENCENT_SECRET_KEY = TENCENT_STUB_KEY;

const { createApp, groupOcrDetections, mapOcrParagraphs } = require('../src/server');

// 一张 1x1 PNG 的 base64，解码后 8 字节，足以通过「非空」检查。
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');
// JPEG 头，用于验证非 PNG 格式也能通过图片头校验。
const TINY_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a';
const MB = 1024 * 1024;

/** 造一个带真实 PNG 文件头、长度为 totalBytes 的假图（只测体积限制，腾讯是桩）。 */
function fakePngOfSize(totalBytes) {
  return Buffer.concat([PNG_BYTES, Buffer.alloc(Math.max(0, totalBytes - PNG_BYTES.length))]).toString('base64');
}

const realHttpsRequest = https.request;
let ocrCalls = [];

/** 把 https.request 换成一个只认固定响应的替身，并记录收到的请求。 */
function stubTencentOcr(body, statusCode = 200) {
  https.request = (options, callback) => {
    const call = { options, payload: null };
    ocrCalls.push(call);
    const req = {
      on() { return req; },
      write(chunk) { call.payload = String(chunk); },
      end() {
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = statusCode;
          callback(res);
          setImmediate(() => res.emit('data', Buffer.from(body, 'utf8')));
          setImmediate(() => res.emit('end'));
        });
      },
    };
    return req;
  };
}

function tencentOk(detections) {
  return JSON.stringify({ Response: { RequestId: 'stub', TextDetections: detections } });
}

beforeEach(() => { ocrCalls = []; });
after(() => { https.request = realHttpsRequest; });

let app;
let port;

function postRaw(path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 留给断言看原文 */ }
        resolve({ status: res.statusCode, json, raw: text });
      });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function post(path, payload) {
  return postRaw(path, JSON.stringify(payload));
}

before(async () => {
  app = createApp({ port: 0, allowedOrigin: 'http://localhost' });
  await new Promise((resolve) => app.httpServer.listen(0, '127.0.0.1', resolve));
  port = app.httpServer.address().port;
});

after(async () => { if (app) await app.close(); });

// ============================================================ 段落分组（单测）

test('分组：腾讯给了段落号时按 ParagNo 合并，而不是一行一段', () => {
  const detections = [
    { DetectedText: 'The first line of para one', Confidence: 98, AdvancedInfo: JSON.stringify({ Parag: { ParagNo: 0 } }) },
    { DetectedText: 'and its second line', Confidence: 91, AdvancedInfo: JSON.stringify({ Parag: { ParagNo: 0 } }) },
    { DetectedText: 'A separate paragraph', Confidence: 99, AdvancedInfo: JSON.stringify({ Parag: { ParagNo: 1 } }) },
  ];
  const paragraphs = mapOcrParagraphs(detections);
  assert.equal(paragraphs.length, 2, '两行同段 + 一段独立 = 2 个段落，不是 3 行 = 3 段');
  assert.equal(paragraphs[0].text, 'The first line of para one\nand its second line');
  assert.equal(paragraphs[1].text, 'A separate paragraph');
});

test('分组：段落号可以乱序，但段落顺序按首次出现保持', () => {
  const paragraphs = mapOcrParagraphs([
    { DetectedText: 'B second', Confidence: 90, AdvancedInfo: JSON.stringify({ Parag: { ParagNo: 1 } }) },
    { DetectedText: 'A first', Confidence: 90, AdvancedInfo: JSON.stringify({ Parag: { ParagNo: 0 } }) },
  ]);
  assert.deepEqual(paragraphs.map((p) => p.text), ['B second', 'A first']);
});

test('分组：没有 AdvancedInfo 时按版面分行，行距小的合成一段', () => {
  const line = (text, top) => ({
    DetectedText: text, Confidence: 95,
    Polygon: [{ X: 10, Y: top }, { X: 400, Y: top }, { X: 400, Y: top + 20 }, { X: 10, Y: top + 20 }],
  });
  const paragraphs = mapOcrParagraphs([line('line one', 100), line('line two', 122), line('far away', 400)]);
  assert.equal(paragraphs.length, 2, '紧邻的两行应合成一段，400px 后的那行另起一段');
  assert.equal(paragraphs[0].text, 'line one\nline two');
  assert.equal(paragraphs[1].text, 'far away');
});

test('分组：新一行跳回左边距视为新的一栏，不并入上一段', () => {
  const box = (text, left, top) => ({
    DetectedText: text, Confidence: 95,
    Polygon: [{ X: left, Y: top }, { X: left + 200, Y: top }, { X: left + 200, Y: top + 20 }, { X: left, Y: top + 20 }],
  });
  const paragraphs = mapOcrParagraphs([box('left column', 300, 100), box('right below', 10, 122)]);
  assert.equal(paragraphs.length, 2);
});

test('映射：段落置信度取各行最小值，location 取并集包围盒', () => {
  const paragraphs = mapOcrParagraphs([
    {
      DetectedText: 'first', Confidence: 97,
      Polygon: [{ X: 100, Y: 10 }, { X: 300, Y: 10 }, { X: 300, Y: 30 }, { X: 100, Y: 30 }],
    },
    {
      DetectedText: 'second', Confidence: 72,
      Polygon: [{ X: 80, Y: 32 }, { X: 320, Y: 32 }, { X: 320, Y: 52 }, { X: 80, Y: 52 }],
    },
  ]);
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].confidence, 72, '应取最小值 72，而不是平均 84.5');
  assert.deepEqual(paragraphs[0].location, { left: 80, top: 10, right: 320, bottom: 52 });
});

test('映射：空文本与缺 Polygon 的条目不会产出空段落', () => {
  assert.deepEqual(mapOcrParagraphs([]), []);
  assert.deepEqual(mapOcrParagraphs([{ DetectedText: '   ', Confidence: 90 }]), []);
  const noBox = mapOcrParagraphs([{ DetectedText: 'still readable', Confidence: 88 }]);
  assert.equal(noBox.length, 1);
  assert.equal(noBox[0].location, null, '没有 Polygon 时 location 必须是 null，不能编造坐标');
});

test('映射：AdvancedInfo 不是合法 JSON 时退回版面分行，不抛异常', () => {
  const paragraphs = mapOcrParagraphs([
    { DetectedText: 'a', Confidence: 90, AdvancedInfo: '{not json', Polygon: [{ X: 0, Y: 0 }, { X: 10, Y: 0 }, { X: 10, Y: 20 }, { X: 0, Y: 20 }] },
    { DetectedText: 'b', Confidence: 90, Polygon: [{ X: 0, Y: 22 }, { X: 10, Y: 22 }, { X: 10, Y: 42 }, { X: 0, Y: 42 }] },
  ]);
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].text, 'a\nb');
});

test('groupOcrDetections 返回的行数守恒：一个元素不会凭空消失或重复', () => {
  const detections = [
    { DetectedText: '1', Confidence: 1, AdvancedInfo: '{"Parag":{"ParagNo":0}}' },
    { DetectedText: '2', Confidence: 1, AdvancedInfo: '{"Parag":{"ParagNo":0}}' },
    { DetectedText: '3', Confidence: 1, AdvancedInfo: '{"Parag":{"ParagNo":1}}' },
  ];
  // 两个分支必须返回同一种形状，否则 mapOcrParagraphs 取 .items 时会崩
  for (const group of groupOcrDetections(detections)) {
    assert.ok(Array.isArray(group.items), '每个分组都必须是带 items 的对象');
    assert.equal(typeof group.left, 'number');
  }
  const total = groupOcrDetections(detections).reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, detections.length);
});

// ================================================================ 端点契约

test('ocr：合法图片返回 200，段落结构正确，且真的调了腾讯', async () => {
  stubTencentOcr(tencentOk([
    { DetectedText: 'Hello world', Confidence: 99, AdvancedInfo: '{"Parag":{"ParagNo":0}}' },
  ]));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json), ['paragraphs']);
  assert.equal(res.json.paragraphs.length, 1);
  assert.equal(res.json.paragraphs[0].text, 'Hello world');
  assert.equal(res.json.paragraphs[0].confidence, 99);
  assert.equal(ocrCalls.length, 1);
  assert.equal(ocrCalls[0].options.headers['X-TC-Action'], 'GeneralBasicOCR');
  assert.equal(ocrCalls[0].options.headers.Host, 'ocr.tencentcloudapi.com');
});

test('ocr：签名正确使用 TC3-HMAC-SHA256，key 只出现在 Authorization 头里', async () => {
  stubTencentOcr(tencentOk([{ DetectedText: 'x', Confidence: 90 }]));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  const auth = ocrCalls[0].options.headers.Authorization;
  assert.match(auth, /^TC3-HMAC-SHA256 Credential=/);
  assert.ok(auth.includes(TENCENT_STUB_ID));
  assert.equal(res.raw.includes(TENCENT_STUB_KEY), false);
  assert.equal(res.raw.includes('TC3-HMAC'), false);
});

test('ocr：图片识别不到任何文字时返回 200 + 空 paragraphs（不是错误）', async () => {
  stubTencentOcr(tencentOk([]));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { paragraphs: [] });
});

test('ocr：空 / 缺失 / 非字符串 / 解码后为空 一律 400，且不调腾讯', async () => {
  stubTencentOcr(tencentOk([{ DetectedText: 'should not be called', Confidence: 99 }]));
  const cases = [{}, { imageBase64: '' }, { imageBase64: '   ' }, { imageBase64: 123 }, { imageBase64: null }, { imageBase64: '!!!!not-base64!!!!' }];
  for (const payload of cases) {
    const res = await post('/v1/ocr', payload);
    assert.equal(res.status, 400, `${JSON.stringify(payload)} 应返回 400，实际 ${res.status}`);
  }
  assert.equal(ocrCalls.length, 0, '参数非法时不得调用腾讯云');
});

test('ocr：解码后超过 3MB 返回 413，且不调腾讯', async () => {
  stubTencentOcr(tencentOk([]));
  const oversize = fakePngOfSize(4 * MB); // base64 后约 5.33MB，仍在 6MB 请求上限内
  const res = await post('/v1/ocr', { imageBase64: oversize });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /超过 3 MB 上限/);
  assert.equal(ocrCalls.length, 0);
});

test('ocr：请求体超过 6MB 返回 413，且连接不断——紧接着的请求仍能正常服务', async () => {
  stubTencentOcr(tencentOk([{ DetectedText: 'still working', Confidence: 95 }]));
  const huge = fakePngOfSize(5 * MB); // base64 后约 6.67MB，超过 6MB 请求上限
  const res = await post('/v1/ocr', { imageBase64: huge });
  assert.equal(res.status, 413, '必须返回 JSON 413，而不是把连接 destroy 掉');
  assert.equal(typeof res.json.error, 'string');

  const after = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(after.status, 200, '413 之后进程必须继续正常服务');
  assert.equal(after.json.paragraphs[0].text, 'still working');
});

test('ocr：非法 base64 / 非图片内容返回 400，不浪费腾讯调用', async () => {
  stubTencentOcr(tencentOk([{ DetectedText: 'must not be reached', Confidence: 99 }]));
  // Node 的 base64 解码很宽松，这串会解出 6 个垃圾字节而不是报错——必须被图片头校验挡下
  const garbage = await post('/v1/ocr', { imageBase64: '!!!!not-base64!!!!' });
  assert.equal(garbage.status, 400);
  assert.match(garbage.json.error, /不是可识别的图片/);

  const textFile = Buffer.from('this is definitely not an image', 'utf8').toString('base64');
  const notImage = await post('/v1/ocr', { imageBase64: textFile });
  assert.equal(notImage.status, 400);

  assert.equal(ocrCalls.length, 0, '非法内容不得调用腾讯云');
});

test('ocr：非 PNG 格式（JPEG）同样通过图片头校验', async () => {
  stubTencentOcr(tencentOk([{ DetectedText: 'from a jpeg', Confidence: 93 }]));
  const res = await post('/v1/ocr', { imageBase64: TINY_JPEG_BASE64 });
  assert.equal(res.status, 200, '不能只放行 PNG');
  assert.equal(res.json.paragraphs[0].text, 'from a jpeg');
});

test('ocr：腾讯返回鉴权错误时带出 providerCode，且 retryable=false', async () => {
  stubTencentOcr(JSON.stringify({ Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: '签名错误' } } }));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 502);
  assert.equal(res.json.providerCode, 'AuthFailure.SignatureFailure');
  assert.equal(res.json.retryable, false, '鉴权失败不是重试能解决的，前端必须显式提示');
});

test('ocr：腾讯限流时带出 providerCode，retryable=true', async () => {
  stubTencentOcr(JSON.stringify({ Response: { Error: { Code: 'Throttling', Message: '请求过于频繁' } } }));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 502);
  assert.equal(res.json.providerCode, 'Throttling');
  assert.equal(res.json.retryable, true);
});

test('ocr：服务未开通时 retryable=false（真实调用暴露的码，桩测试原本漏了）', async () => {
  stubTencentOcr(JSON.stringify({ Response: { Error: { Code: 'FailedOperation.UnOpenError', Message: '服务未开通，请前往控制台开通相应服务' } } }));
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 502);
  assert.equal(res.json.providerCode, 'FailedOperation.UnOpenError');
  assert.equal(res.json.retryable, false, '服务没开通，重试一万次也没用');
  assert.match(res.json.error, /控制台/);
});

test('ocr：图片本身有问题时 retryable=false', async () => {
  for (const code of ['FailedOperation.ImageDecodeError', 'FailedOperation.ImageSizeError', 'FailedOperation.UnsupportedImageFormat']) {
    stubTencentOcr(JSON.stringify({ Response: { Error: { Code: code, Message: '图片有问题' } } }));
    const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
    assert.equal(res.json.providerCode, code);
    assert.equal(res.json.retryable, false, `${code} 应判为不可重试`);
  }
});

test('ocr：腾讯返回非 JSON 时报 502 而不是崩掉', async () => {
  stubTencentOcr('<html>gateway error</html>');
  const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(res.status, 502);
  assert.equal(res.json.providerCode, 'MalformedResponse');
});

test('ocr：未配置腾讯凭据时返回 503，且不发出网请求', async () => {
  stubTencentOcr(tencentOk([]));
  const savedId = process.env.TENCENT_SECRET_ID;
  const savedKey = process.env.TENCENT_SECRET_KEY;
  delete process.env.TENCENT_SECRET_ID;
  delete process.env.TENCENT_SECRET_KEY;
  try {
    const res = await post('/v1/ocr', { imageBase64: TINY_PNG_BASE64 });
    assert.equal(res.status, 503);
    assert.equal(ocrCalls.length, 0);
  } finally {
    process.env.TENCENT_SECRET_ID = savedId;
    process.env.TENCENT_SECRET_KEY = savedKey;
  }
});

// ================================================================= 回归保护

test('回归：readJson 的 32KB 默认上限对既有端点依然生效', async () => {
  const res = await post('/v1/translate-en2zh', { text: 'a'.repeat(40 * 1024) });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /32 KB/);
});

test('回归：既有四个端点契约未被本次改动影响', async () => {
  const en2zh = await post('/v1/translate-en2zh', { text: '' });
  assert.equal(en2zh.status, 400);
  const cn2en = await post('/v1/translate', { text: '' });
  assert.equal(cn2en.status, 400);
  const clean = await post('/v1/clean', { text: '' });
  assert.equal(clean.status, 400);
  const tts = await post('/v1/tts', { text: '' });
  assert.equal(tts.status, 400);
  const notFound = await post('/v1/ocr-not-a-route', { imageBase64: TINY_PNG_BASE64 });
  assert.equal(notFound.status, 404);
});

// ================================================================= 2026-09-29 线上排查

test('回归：段落号读的是腾讯真实的对象形状 {Parag:{ParagNo}}，不是数组', () => {
  // 真实响应（2026-09-29 直连 ocr.tencentcloudapi.com 抓的原文）：
  //   {"Parag":{"ParagNo":1}}
  // 早期代码按数组取 Parag[0].ParagNo，Array.isArray 恒为 false，
  // 于是段号永远读不出来，每张图都被压成一段，「按段落逐段翻译」等于没做。
  const paragraphs = mapOcrParagraphs([
    { DetectedText: 'Deployment Guide', Confidence: 99, AdvancedInfo: '{"Parag":{"ParagNo":1}}' },
    { DetectedText: 'This document explains how to deploy the', Confidence: 99, AdvancedInfo: '{"Parag":{"ParagNo":2}}' },
    { DetectedText: 'service on a production cluster.', Confidence: 99, AdvancedInfo: '{"Parag":{"ParagNo":2}}' },
  ]);
  assert.equal(paragraphs.length, 2, '标题自成一段，两行正文合成一段');
  assert.equal(paragraphs[0].text, 'Deployment Guide');
  assert.equal(paragraphs[1].text, 'This document explains how to deploy the\nservice on a production cluster.');
});

test('回归：对象形状和数组形状都能解析（两种都在线上出现过）', () => {
  const both = [
    { DetectedText: 'obj shape', Confidence: 90, AdvancedInfo: '{"Parag":{"ParagNo":1}}' },
    { DetectedText: 'arr shape', Confidence: 90, AdvancedInfo: '{"Parag":[{"ParagNo":1}]}' },
    { DetectedText: 'plain object', Confidence: 90, AdvancedInfo: { Parag: { ParagNo: 1 } } },
  ];
  const paragraphs = mapOcrParagraphs(both);
  assert.equal(paragraphs.length, 1, '三种写法都应解析出同一个 ParagNo=1，合成一段');
  assert.equal(paragraphs[0].text, 'obj shape\narr shape\nplain object');
});

test('回归：发给腾讯的载荷不含 PdfPageNumber', () => {
  // PdfPageNumber 从 1 开始数页，传 0 越界会让腾讯回 FailedOperation.OcrFailed
  // （而不是参数错误），2026-09-29 实测带 0 必失败 10/10、去掉后 conf=100。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const payloadLine = src.split('\n').find((l) => l.includes('ImageBase64: imageBase64'));
  assert.ok(payloadLine, '应能找到构造载荷的那一行');
  assert.equal(/PdfPageNumber/.test(payloadLine), false, '非 PDF 场景不得发 PdfPageNumber');
  assert.match(payloadLine, /IsWords: true/, '必须开 IsWords，否则拿不到 AdvancedInfo 里的段号');
});
