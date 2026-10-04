# LinguaMate Live

一个只做两件事的本地网页 MVP：实时中文转写与英文翻译。

## 先体验界面

```powershell
npm install
npm run dev
```

打开 `http://localhost:3000`，选择“浏览器演示”，允许麦克风权限后即可体验实时转写。这个模式依赖 Chrome/Edge 的浏览器语音识别能力，适合验证界面和流程。

## 接入正式云端能力

1. 复制 `.env.example` 为 `.env`。
2. 在腾讯云开通实时语音识别，填写 `TENCENT_APP_ID`、`TENCENT_SECRET_ID` 与 `TENCENT_SECRET_KEY`。
3. 在翻译模型供应商处创建 API Key，填写 `TRANSLATION_*` 三项。
4. 重启服务，页面选择“腾讯云实时 ASR”。

密钥只放在 `.env`，不会发送到浏览器。

## 处理逻辑

浏览器演示模式：浏览器语音识别直接返回中间/最终文字。

腾讯模式：浏览器采集 16 kHz PCM 音频，通过本地 WebSocket 发给 `server.js`；服务端签名后连接腾讯云 ASR，再把结果回传。只有最终句子才会请求翻译接口，因此英文不会在说话时反复跳动。

> 提示：上线前应把本地 Node 服务部署为长期运行的后端服务，并将 `.env` 配置为平台环境变量。不要把 SecretKey 或翻译模型 API Key 写入前端。
