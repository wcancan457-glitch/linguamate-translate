# LinguaMate Live Backend

实时中文转写与英文翻译的独立后端。它不保存音频和转写内容。

## 启动

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

服务启动后访问：

```text
http://localhost:8787/
```

这是可直接使用的本地页面；点击“开始说话”后，在浏览器提示时允许访问麦克风。健康检查仍可通过 `GET http://localhost:8787/health` 访问。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 检查服务与配置状态；不会返回密钥。 |
| `POST /v1/translate` | 将最终中文句子翻译为英文。请求体：`{"text":"你好"}`。 |
| `POST /v1/clean` | 净化最终中文句子的口头填充和无意义重复。需要配置 `CLEANUP_MODEL`。请求体：`{"text":"嗯，我觉得这个可以"}`。 |
| `WS /v1/asr/tencent` | 将浏览器采集的 16kHz、16bit、单声道 PCM 音频流转发给腾讯云实时 ASR。 |
| `GET /` | 提供本地的实时转写与英文翻译页面。 |

WebSocket 返回三种 JSON 事件：

```json
{"type":"ready"}
{"type":"transcript","text":"你好","isFinal":false}
{"type":"transcript","text":"你好。","isFinal":true}
```

只有 `isFinal: true` 的文本应该被前端送进 `/v1/clean`。前端仍立刻显示原始转写；净化成功后再翻译净化稿。净化不可用时会自动回退到原文翻译，因此不会阻断使用。

## 安全边界

- 腾讯云 `SecretKey` 与翻译 API Key 只存在 `.env` 和部署平台的环境变量中。
- 后端不把密钥返回到任何 HTTP 或 WebSocket 响应。
- 当前版本不落库、不写入音频文件；生产环境应在反向代理层关闭请求日志中的 body 记录。
- `CLEANUP_MODEL` 必须是 TokenHub 中已启用的通用对话模型，不要复用 `hy-mt2-plus` 等翻译专用模型。
