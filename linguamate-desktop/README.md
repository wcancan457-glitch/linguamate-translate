# LinguaMate Desktop

这是 LinguaMate Live 的**独立桌面客户端工程**。阶段 4（§4.2 验收合同）把阶段 3 的悬浮窗主链路 + 复制 / 朗读打包成可分发的 Windows 安装包，并补齐首次配置说明；阶段 5 增量在同一套工程里加上了**划词翻译**与**截图翻译**两个输入模式，共用一个浮动弹窗。

## 本阶段做了什么

- **后端 dotenv 多路径查找**：`backend/src/server.js` 的 `resolveDotenvPath()` 按三档优先级读 `.env`：
  1. `process.env.LINGUAMATE_DOTENV_PATH`（dev 模式由桌面端显式注入 `backend/.env`）；
  2. `%APPDATA%\LinguaMate\.env`（生产模式默认）；
  3. dev fallback `backend/.env`（asar 内，开发用）。
  三档都找不到 → dotenv 静默失败，`/health` 返回 `configured: false`。
- **electron-builder 配置**：`package.json` 加 `build` 字段 + `pack` / `dist` 脚本；NSIS per-user 安装，无 UAC；产物落在 `dist-electron/`。
- **APPDATA 检测与首次配置**：桌面端启动时 `ensureAppDataDir()` 创建 `%APPDATA%\LinguaMate`；`FIRST_RUN.md` 通过 `asarUnpack` 落地，方便用户从资源管理器直接打开。
- **/health 校验 + 托盘气泡**：后端 ready 后后台调一次 `/health`，任一 provider `false` 时通过 `tray.displayBalloon` 发气泡、给 renderer 发 `config:status` 事件。
- **状态栏可点击引导**：renderer 在 `configured=false` 时把状态栏变黄 + 点下划线，点击调 `shell.openPath` 打开 `%APPDATA%\LinguaMate` 文件夹。
- **打开本地文件 IPC**：preload 暴露 `openPath` / `getEnvPath` / `onConfigStatus`，主进程 `shell:openPath` 处理。
- **密钥卫生**：`files` 显式 include `src/**` `renderer/**` `build/**` `FIRST_RUN.md` `package.json`，**不打包任何 `.env`**；`LINGUAMATE_DOTENV_PATH` 在打包后**不注入**，让后端 fallback 到 APPDATA；PowerShell 启动日志只输出 backend port + 错误，不输出任何 key 内容。

## 阶段 5 增量（已合并）

按 §4.2 阶段 5 合同，已完成：

- **P2 腾讯云 TTS 替换浏览器 speechSynthesis**（用户点名）：
  - 后端新增 `/v1/tts` POST 端点（`backend/src/server.js` 的 `ttsTencent`），按 TC3-HMAC-SHA256 v3 签名调 `tts.tencentcloudapi.com` 的 `TextToVoice` Action，base64 MP3 流返回；
  - 文本按 `MAX_TENCENT_TTS_CHARS=150` 在句子边界切段，多段 MP3 拼接回传；
  - 前端 `renderer.js` 用 `fetch` + `<audio>` + `URL.createObjectURL` 播 MP3；录音时按钮禁用，停止时清 blob URL；
  - `index.html` 加 `<audio id="speak-audio" hidden>` + CSP 加 `media-src 'self' blob:`；
  - **TTS 用 ASR 同对 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`（CAM 凭据）**，无需单独 API Key；子账号需要 `QcloudTTSFullAccess` 策略；
  - 音色可配：`TENCENT_TTS_VOICE`（默认 `502001` 中文女声·智瑜）；常用音色见 `FIRST_RUN.md` 的"音色速查"。
- **P1 状态栏 5 段流程 + spinner**（用户上一轮点名）：录音→识别→整理→翻译→完成，每段有清晰状态文案；中文/英文独立 spinner；停止录音时统一清理。
- **划词翻译**（用户点名，步骤 6A）：**没有热键**。监听的是按键的*结果*——短时间（≤1000ms）内出现**两次独立的剪贴板变更事件**即视为双 `Ctrl+C`。因此用户每一次 `Ctrl+C` 都照常生效，程序**不监听键盘、不模拟按键、不吞事件**。
  - 后端新增 `/v1/translate-en2zh`（EN→CN）；`/v1/ocr`（腾讯云 `GeneralBasicOCR`）供截图翻译共用；
  - `src/selection-capture.js` 常驻监听：`GetClipboardSequenceNumber()` 轮询 + **280ms 时间去抖**（实测一次复制使序号跳 7–8 次，**必须**按时间去抖而非按次数判定）→ 第二次事件后**当场重新读取** `clipboard.readText()` → 空/非纯文本则回退 UIA（`src/selection-reader.js`，PowerShell + `UIAutomationClient`）→ 仍失败则弹「此内容无法读取」并给 `[截图翻译]` 按钮，**绝不自动截图**；
  - 判定用的是**事件层面**的「两次变更」，**不是**比较两次文本是否相同——后者会把「复制到相同内容」误判为没变化。
  - **临时目录自清理**：监听脚本落在 `%TEMP%\linguamate-clip-*`。托盘正常退出时立刻删；被 `taskkill /F`、断电或任务管理器强杀时进程内代码跑不到，会留下孤儿目录（实测一轮测试积了 9 个），因此**每次启动时扫一遍**：删掉 mtime 超过 1 小时的同名目录。阈值取 1 小时而不是 0，是因为 dev 与打包版的 `userData` 路径不同（`linguamate-desktop` vs `LinguaMate`），单实例锁拦不住两者并存，按「老到不可能还在用」判定才不会误删另一个活实例的目录。阈值可用 `LINGUAMATE_CLIP_STALE_TMP_MS`（毫秒）覆盖。
- **截图翻译**（用户点名，步骤 6B）：`Ctrl+Shift+S`（可用 `LINGUAMATE_SCREENSHOT_HOTKEY` 覆盖）→ 全屏 50% 黑覆盖层 → 拖框 → 腾讯云 OCR → 合并段落 → **一次** `/v1/translate-en2zh` → 弹窗。Esc / 右键 / 拖出屏 / 60 秒超时四条取消路径，**取消后弹窗根本不创建**。
- **共享弹窗**（`src/popup-manager.js` + `popup/`）：划词与截图**共用一个单例**和**一个操作号** `popupOpId`——连按两次只留一个弹窗，陈旧请求的结果被 `myOp !== popupOpId` 静默丢弃。透明分层窗口 `focusable:true` 抢焦点，`Esc` 才进得来。
- **零剪贴板写入**（本阶段的硬边界）：划词链路**一个字符都不写**剪贴板。弹窗的写能力收在 `popup-manager.js` 内部的 `defaultWriteClipboard`，`main.js` **不注入** `writeClipboard`——于是划词那 200 行代码连写方法都碰不到。唯一写剪贴板的地方是用户点 `[复制]`。
- **两处端到端实测抓到的真 bug**（单测全绿，只有真跑才暴露）：
  - 腾讯云在图里无文字时返回的是 **HTTP 502 + `FailedOperation.ImageNoText`**，不是「200 但段落为空」。只判空段落会让它掉进通用 5xx，弹窗显示「可重试」——而重试的是**同一张图**，重试一百次一样。已单列一支并给 `action:'screenshot'`（换区域才有意义）。
  - `popup/popup.js` 曾把 `data.status` 硬写成「出错了」，把主进程分好的「未识别到文字 / 截图超时 / 鉴权失败 / 配额用尽 / 读不到内容」全抹平。
- **热键注册是「只加不改」**：`registerShortcut(accelerator)` 保持逐字未动（它开头就 `unregisterAll()`），截图热键走**新增**的 `registerExtraShortcuts()`，函数体内不出现任何 `unregister`。实测：把截图热键故意设成已被占用的 `Ctrl+Shift+L` → 截图注册失败，**录音热键照常工作**。

> 阶段 5 仍有这些项必须**用户单独点名**才能做：自动粘贴、开机自启、按住说话、历史记录、术语表、TSF/IME。

## 本阶段刻意没有做什么

按 §4.2 验收合同，**下面所有项必须等用户单独点名**才能做（阶段 5 的划词/截图翻译**不包含**在内，但也不构成对下列任何一项的授权）：

- **自动粘贴到其它软件**（系统 Hook / Win32 SendInput / Clipboard.SetText 后模拟 Ctrl+V）。划词翻译刻意**不模拟 `Ctrl+C`**、**不写剪贴板**、**不拦截用户的 `Ctrl+C`**——译文只出现在弹窗里，怎么处置由用户决定。
- **开机自启**（Run 注册表项 / Startup 文件夹）。
- **按住说话 / 松开结束**（替代当前"按一次开始、再按一次停止"）。
- **历史记录**（本地 sqlite / 文件 + UI 时间线）。截图只存在于内存，识别完立即丢弃，**不落盘**。
- **术语表**（中英对照字典 + 翻译前注入）。
- **完整 Windows 输入法集成**（TSF / IME DLL 注入）。本阶段的划词**不是**输入法，只是「监听双复制的剪贴板结果」。

阶段 5 的其余每一项仍得用户单独点名 + 单独验收。

另外本阶段也没动：

- 网页 MVP（`linguamate-live/public/*`）。
- 腾讯 ASR 签名流程、音频协议（16 kHz / 16 bit / 单声道 PCM）。
- 后端 `cleanFinalSentence` / `translateFinalSentence` / `normalizeCleanupText`。

## 启动

### 开发模式（dev）

```powershell
cd D:\zxf\claude\linguamate-desktop
npm install
npm start
```

预期与阶段 3 一致：
- 托盘右下角紫色 16×16 图标；
- 主屏右下角 460×260 悬浮窗；
- 后端 in-process 启动，端口 8787；
- `Ctrl+Shift+L` 录音，状态栏会显示"后端已就绪 → 腾讯云正在实时识别 → 中文/英文翻译陆续回填"；
- `npm start` 期间 dev 模式由主进程显式设 `LINGUAMATE_DOTENV_PATH = backend/.env`，所以 `.env` 放在仓库里的 `backend/.env` 即可生效。

### 打包（pack — 不出 installer，只解压版）

```powershell
cd D:\zxf\claude\linguamate-desktop
npm install
npm run pack
```

产物：`dist-electron\win-unpacked\LinguaMate.exe`。双击启动即可，无安装步骤。**注意**：解压版不会自动创建桌面 / 开始菜单快捷方式，也不会注册卸载项；适合本地冒烟测试。

### 打包并出 NSIS installer（dist — 全流程）

```powershell
cd D:\zxf\claude\linguamate-desktop
npm install
npm run dist
```

产物：`dist-electron\LinguaMate Setup 0.1.0.exe`。双击安装：

- 选择安装目录（默认 `%LOCALAPPDATA%\Programs\LinguaMate\`）；
- 勾选"创建桌面快捷方式"和"创建开始菜单快捷方式"；
- 末尾弹一个 MessageBox 提示首次配置 `.env`；
- 安装完毕双击桌面图标启动 → 状态栏如已配置好就是"后端已就绪"，否则是"未配置云端密钥"。

### 自定义环境变量

```powershell
$env:LINGUAMATE_SHORTCUT = 'Alt+Space'      # 录音全局快捷键
$env:LINGUAMATE_SCREENSHOT_HOTKEY = 'Ctrl+Shift+S'  # 截图翻译全局快捷键（Electron accelerator 语法）
$env:LINGUAMATE_BACKEND_PORT = '8787'        # 后端端口
$env:LINGUAMATE_BACKEND_DIR = 'D:\...\backend' # dev 模式用
$env:LINGUAMATE_DOTENV_PATH = 'C:\...\env'   # 强制覆盖 .env 路径
$env:LINGUAMATE_ALLOWED_ORIGIN = '*'         # CORS
npm start                                   # 或 npm run pack / dist
```

`LINGUAMATE_DOTENV_PATH` 在打包后一般**不设**，让后端按 APPDATA → dev fallback 顺序自己选。

`LINGUAMATE_SCREENSHOT_HOTKEY` **留空即用默认值 `CommandOrControl+Shift+S`**。它与录音热键 `LINGUAMATE_SHORTCUT`（默认 `Ctrl+Shift+L`）**不要设成同一个**——冲突时截图那一路注册失败（会弹提示），但录音那一路不受影响（走的是另一条注册路径）。划词翻译**没有**热键，因此不存在 `LINGUAMATE_SELECTION_HOTKEY` 这个变量。

## 首次配置

详见 `FIRST_RUN.md`（同目录，已通过 `asarUnpack` 落地到 `%APPDATA%\LinguaMate\FIRST_RUN.md`）。要点：

1. `%APPDATA%\LinguaMate` 目录首次启动时由主进程自动建；
2. 把云端密钥写到 `%APPDATA%\LinguaMate\.env`（文件名严格）；
3. 托盘菜单 → 退出 LinguaMate → 再次启动；
4. 状态栏变"后端已就绪"=成功；否则按 `FIRST_RUN.md` 的故障排查表查。

卸载时 `.env` 保留（用户数据），下次安装无需重新写。

## 回归（必须做）

按 `CLAUDE_HANDOFF.md` §4.1 修改后必须做的最低验证：

```powershell
cd D:\zxf\claude\linguamate-live\backend
npm test
```

然后逐项验证：

### dev 回归（与阶段 3 行为一致）

```powershell
cd D:\zxf\claude\linguamate-desktop
npm start
```

- 真实麦克风说两句话，中文净化稿 + 英文翻译按说话顺序回填；
- 中文 `[复制]` / 英文 `[复制]` 粘贴到外部编辑器一致；
- 英文 `[朗读]` 在录音外能播能停，录音时按钮禁用；
- 用户编辑中文 / 英文后再复制，复制出去是改后内容。

### pack / dist 回归（阶段 4 新增）

1. `npm run dist` → 双击安装包 → 默认安装目录 + 桌面 / 开始菜单快捷方式出现；
2. 启动 → 状态栏"未配置云端密钥：把 .env 放到 %APPDATA%\LinguaMate\.env（点这里打开该文件夹）"；
3. 点击状态栏 → 资源管理器打开 `%APPDATA%\LinguaMate\`，看到 `FIRST_RUN.md` 副本；
4. 把 `linguamate-live\backend\.env` 内容粘贴到 `%APPDATA%\LinguaMate\.env` → 托盘菜单退出 → 再启动；
5. 状态栏变"后端已就绪" → 录音 → 中文 / 英文正常 → 复制 / 朗读全 OK；
6. 控制面板卸载 → 进程退出 → 桌面 / 开始菜单快捷方式消失 → `%APPDATA%\LinguaMate\.env` 仍存在。

### 阶段 5 增量回归（pack 产物）

1. `npm run pack` → 确认 asar 内有 `popup/index.html`、`popup/popup.js`、`popup/styles.css`、`screenshot/index.html`、`screenshot/index.js`、`screenshot/styles.css`，以及 `src/` 下的 `selection-capture.js` / `selection-reader.js` / `popup-manager.js` / `screenshot-window.js` / `preload-popup.js` / `preload-screenshot.js`：

   ```powershell
   npx asar list dist-electron\win-unpacked\resources\app.asar | Select-String 'popup|screenshot|selection-'
   ```

2. 启动 `dist-electron\win-unpacked\LinguaMate.exe` → 日志应出现 `截图翻译 已注册 (CommandOrControl+Shift+S)`。**没有这行就说明热键没注册成功**，不能宣称「全部可用」。
3. `Ctrl+Shift+L` 录音照常（阶段 2/3 链路未被阶段 5 影响）。
4. `Ctrl+Shift+S` 拖框 → 译文弹窗。裁剪比例必须从 `thumbnail.getSize()` 的**实际像素**反推，不能用 `display.scaleFactor`（这是 HiDPI 截错位置的根因）。
5. 划词：选中英文 → 连按两次 `Ctrl+C` → 弹窗。**核对剪贴板在触发前后完全一致**（划词链路零写入）。
6. 取消路径：覆盖层出现后按 `Esc` / 右键 → 屏幕上什么都不留，**且不产生任何 `[popup] bounds` 日志**（弹窗根本没被创建）。
7. 连按两次 `Ctrl+Shift+S` → 只允许存在一个覆盖层，日志应出现一条 `busy=ignored`。
8. 把 `LINGUAMATE_SCREENSHOT_HOTKEY` 设成 `CommandOrControl+Shift+L`（与录音冲突）→ 截图注册失败并提示，**录音热键仍可用**。这是 `registerExtraShortcuts()` 不含 `unregister` 的直接证据。

### 密钥卫生（防止密钥意外进安装包）

```powershell
# 1. asar 内不应出现任何 key 字面值
select-string -Path dist-electron\win-unpacked\resources\app.asar -Pattern 'TENCENT_SECRET_KEY|TRANSLATION_API_KEY' -SimpleMatch
# 预期：无匹配

# 2. installer exe 不应出现 key 字面值
select-string -Path dist-electron\win-unpacked\LinguaMate.exe -Pattern 'TENCENT_SECRET_KEY|TRANSLATION_API_KEY' -SimpleMatch
# 预期：无匹配

# 3. PowerShell 启动日志不应出现 key
npm start
# 预期：[linguamate-desktop] backend ready at http://localhost:8787
# 预期：无任何 TENCENT_* / TRANSLATION_API_KEY 输出
```

## 目录结构

```
linguamate-desktop/
├── package.json              # electron + electron-builder + build 配置
├── README.md
├── FIRST_RUN.md              # 首次配置说明（也通过 asarUnpack 落地到 APPDATA）
├── .gitignore
├── build/
│   ├── icon.png              # 256×256 installer icon（手写生成）
│   ├── installer.nsh         # NSIS 自定义 install / uninstall 钩子
│   └── scripts/gen-icon.js   # icon.png 生成脚本（可重跑）
├── src/
│   ├── main.js               # 主进程：单实例、托盘、悬浮窗、快捷键、后端、APPDATA 检测、/health 校验、气泡、划词/截图串接
│   ├── preload.js            # 悬浮窗 contextBridge 白名单 IPC
│   ├── selection-capture.js  # 划词主通道：剪贴板序号轮询 + 280ms 去抖 + 两次变更判定
│   ├── selection-reader.js   # 划词备用通道：PowerShell + UIAutomationClient 读活动窗口选区
│   ├── popup-manager.js      # 划词/截图共享的单例弹窗（含唯一的写剪贴板能力）
│   ├── screenshot-window.js  # 全屏覆盖层 + desktopCapturer 裁剪
│   ├── preload-popup.js      # 弹窗 preload（沙箱）
│   └── preload-screenshot.js # 覆盖层 preload（沙箱）
├── renderer/                 # 录音悬浮窗（阶段 2/3/4 的内容，本阶段未动）
│   ├── index.html
│   ├── renderer.js
│   └── styles.css
├── popup/                    # 划词/截图结果弹窗
│   ├── index.html
│   ├── popup.js
│   └── styles.css
├── screenshot/               # 截图拖框覆盖层
│   ├── index.html
│   ├── index.js
│   └── styles.css
└── test/                     # node --test，无 electron 运行时也能跑（依赖全部注入）
```