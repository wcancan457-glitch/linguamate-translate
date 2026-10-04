// 生成阶段 4 installer icon：256×256 紫色径向背景 + 中央白色 L 形。
// 与 src/main.js 的 buildTrayIcon 用同一套手写 PNG 套路（不引图像库）。
// 跑一次：`node build/scripts/gen-icon.js`

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256;
const H = 256;
const CENTER_X = W / 2;
const CENTER_Y = H / 2;
const MAX_R = Math.hypot(W, H) / 2;

// 径向渐变：内浅 (#a78fff) → 外深 (#241a3a)
function bgColor(t) {
  const r1 = 0xa7, g1 = 0x8f, b1 = 0xff;
  const r2 = 0x24, g2 = 0x1a, b2 = 0x3a;
  return [
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
    255,
  ];
}

// L 形覆盖函数：左上 1/4 矩形 + 左侧条
function inLShape(x, y) {
  const left = 72;     // L 左侧条 x 起点
  const top = 56;      // L 顶 y 起点
  const barWidth = 36; // 条宽
  const verticalHeight = 144; // 竖条总高
  const horizontalLength = 132; // 横条总长
  const stroke = 4;
  // 主体矩形：竖条 + 横条
  const inVertical = x >= left && x <= left + barWidth && y >= top && y <= top + verticalHeight;
  const inHorizontal = x >= left && x <= left + horizontalLength && y >= top + verticalHeight - barWidth && y <= top + verticalHeight;
  return inVertical || inHorizontal;
}

// L 边缘描边像素（在 L 形 4 像素外圈）：抗锯齿弱化版
function inLStroke(x, y) {
  const left = 72 - 4;
  const top = 56 - 4;
  const barWidth = 36 + 8;
  const verticalHeight = 144 + 4;
  const horizontalLength = 132 + 4;
  const inVertical = x >= left && x <= left + barWidth && y >= top && y <= top + verticalHeight;
  const inHorizontal = x >= left && x <= left + horizontalLength && y >= top + verticalHeight - barWidth && y <= top + verticalHeight;
  return (inVertical || inHorizontal) && !inLShape(x, y);
}

// PNG 手写（同 buildTrayIcon）
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

function generateIconPng() {
  const rowSize = 1 + W * 4;
  const raw = Buffer.alloc(rowSize * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < W; x += 1) {
      const i = y * rowSize + 1 + x * 4;
      const dx = x - CENTER_X;
      const dy = y - CENTER_Y;
      const r = Math.hypot(dx, dy);
      const t = Math.min(1, r / MAX_R);
      const [cr, cg, cb, ca] = bgColor(t);
      let rOut = cr, gOut = cg, bOut = cb;
      if (inLShape(x, y)) {
        rOut = 0xf6; gOut = 0xf3; bOut = 0xed; // 米白
      } else if (inLStroke(x, y)) {
        // 紫色描边
        rOut = Math.round(cr * 0.6 + 0x6b * 0.4);
        gOut = Math.round(cg * 0.6 + 0x4d * 0.4);
        bOut = Math.round(cb * 0.6 + 0xa0 * 0.4);
      }
      raw[i] = rOut;
      raw[i + 1] = gOut;
      raw[i + 2] = bOut;
      raw[i + 3] = ca;
    }
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.resolve(__dirname, '..', 'icon.png');
fs.writeFileSync(out, generateIconPng());
// eslint-disable-next-line no-console
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);