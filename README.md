# LinguaMate Translate

中英双向翻译工具。桌面端支持**录音翻译**、**划词翻译**、**截图翻译**和**手动输入中文翻译**，
后端负责腾讯云 ASR、翻译与 OCR。

> 本仓库与账号下的 [`linguamate`](https://github.com/wcancan457-glitch/linguamate) 是**两个不同的产品**。
> 那个是基于 MSIME fork 的 Windows 输入法（水杉输入法），用 C++ / TSF / COM 实现；本仓库是
> Electron + Node 实现的翻译应用。

## 目录结构

```
linguamate-live/      后端 + 浏览器演示
  backend/            Node 服务：/v1/translate、/v1/translate-en2zh、/v1/ocr、/health
  public/             浏览器演示页
  server.js           演示用服务入口
linguamate-desktop/   Electron 桌面客户端
  src/                主进程：划词捕获、截图、弹窗
  renderer/           悬浮窗 / 主窗口界面
  popup/              划词与截图共用的翻译弹窗
  screenshot/         截图拖框覆盖层
  test/               137 个测试
```

两个目录是各自独立的 npm 工程，各有 `package.json` 和 `.gitignore`，
不共享 `node_modules`，也不需要一并安装。

## 我该改哪个目录？

**默认只改 `linguamate-desktop/`。** 它是界面和桌面能力（按钮、快捷键、划词、截图、录音交互、
显示问题），你日常的功能改动几乎都在这里。

`linguamate-live/` 是后端，只在下面这些时候才动：

| 什么时候 | 改哪个 |
|---|---|
| 加按钮、改界面、加快捷键 | `linguamate-desktop/` |
| 修划词 / 截图 / 录音的交互 | `linguamate-desktop/` |
| 修显示、状态提示 | `linguamate-desktop/` |
| 改翻译的提示词（system prompt） | `linguamate-live/backend/` |
| 换腾讯云模型 / 区域 / 签名细节 | `linguamate-live/backend/` |
| 新增一个后端接口 | `linguamate-live/backend/` |

两者的分工是：桌面端渲染界面后用 `fetch` 请求 `http://localhost:8787` 上的后端接口，
后端再去调腾讯云。**改界面不需要碰后端**——现有的 `/v1/translate`、`/v1/translate-en2zh`、
`/v1/ocr` 已经覆盖全部四种功能。

## 环境变量

真实凭据**不在仓库里**。复制示例文件后自行填写：

- `linguamate-live/backend/.env.example` → `linguamate-live/backend/.env`

| 变量 | 用途 |
|---|---|
| `TENCENT_APP_ID` | 腾讯云账号 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 腾讯云 CAM 凭据（ASR + OCR 共用） |
| `TENCENT_ASR_MODEL` | 实时语音识别引擎 |
| `TRANSLATION_BASE_URL` / `TRANSLATION_API_KEY` / `TRANSLATION_MODEL` | 翻译服务 |
| `CLEANUP_MODEL` | 中文净化 |
| `PORT` / `ALLOWED_ORIGIN` | 服务监听与来源校验 |

`.env` 已被 `.gitignore` 排除（`linguamate-live/.gitignore` 与
`linguamate-live/backend/.gitignore` 各一条）。桌面端在生产模式下从
`%APPDATA%\LinguaMate\.env` 读取，见 `linguamate-desktop/FIRST_RUN.md`。

## 本地运行

```bash
# 后端（浏览器演示）
cd linguamate-live
npm install
npm run dev            # http://localhost:3000

# 桌面客户端
cd linguamate-desktop
npm install
npm start              # Electron，后端默认 localhost:8787
npm test               # 137 个测试
```

## 打包

```bash
cd linguamate-desktop
npm run pack           # 仅 win-unpacked（快，用于回归）
npm run dist           # NSIS 安装包
```

产物在 `linguamate-desktop/dist-electron/`，已被 `.gitignore` 排除。

## 隐私边界

这几条是硬约束，改动前请先读 `linguamate-desktop/src/selection-capture.js` 的注释：

- 划词翻译**不模拟 `Ctrl+C`**，也**不监听键盘**，只观察剪贴板序号的变化。
- 整个划词链路**对剪贴板零写入**。唯一例外是用户显式点击弹窗上的「复制」按钮。
- 不拦截、不吞掉、不改变用户正常的 `Ctrl+C` 行为。
- 选区文本与剪贴板内容**不写入**日志、诊断文件、崩溃报告或历史；诊断输出只有长度、
  来源应用、是否成功这类元数据。
- 截图 OCR **不会**被划词失败自动触发，必须由用户显式发起。
- 新的划词/截图热键不改动现有的录音链路与 `Ctrl+Shift+L`。

## 文档

- `linguamate-live/CLAUDE_HANDOFF.md` —— 交付合同与阶段状态
- `linguamate-live/STAGE_5_PLAN_v2_划词与截图翻译.md` —— 阶段 5 增量计划
- `linguamate-desktop/FIRST_RUN.md` —— 首次配置说明
