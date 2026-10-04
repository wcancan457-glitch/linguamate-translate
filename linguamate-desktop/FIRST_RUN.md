# LinguaMate 首次配置说明

安装完成后，**第一次启动前**你需要把云端密钥放到 `%APPDATA%\LinguaMate\.env` 里。LinguaMate 安装包里**不带**任何密钥——这是按 `CLAUDE_HANDOFF.md` §4.1 的"密钥不在安装包和日志中"原则故意这么做的。

## 第一步：找到配置目录

打开 PowerShell 跑：

```powershell
echo $env:APPDATA\Linguamate
```

或者直接打开资源管理器，地址栏粘贴：

```
%APPDATA%\LinguaMate
```

如果目录还没建，启动一次 LinguaMate（托盘会出现，悬浮窗会弹"未配置云端密钥"），主进程会自动建这个目录并把本说明文件复制到那里。

## 第二步：写 `.env`

在该目录新建一个文件，文件名严格叫 `.env`（注意开头是英文句点，不是中文句号）。内容示例：

```
TENCENT_APP_ID=13000xxxxx
TENCENT_SECRET_ID=AKIDxxxxxxxxxxxxxxxx
TENCENT_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
TENCENT_ASR_MODEL=16k_zh
TENCENT_TTS_VOICE=502001
TRANSLATION_BASE_URL=https://api.tokenhub.ai/v1
TRANSLATION_API_KEY=sk-xxxxxxxxxxxxxxxx
TRANSLATION_MODEL=hy-mt2-plus
CLEANUP_MODEL=glm-5.3-flash
```

各字段含义：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `TENCENT_APP_ID` | 是 | 腾讯云 ASR 应用 ID |
| `TENCENT_SECRET_ID` | 是 | 腾讯云 CAM 凭据（**同时**用于 ASR 和 TTS） |
| `TENCENT_SECRET_KEY` | 是 | 同上 |
| `TENCENT_ASR_MODEL` | 否 | ASR 模型，默认 `16k_zh` |
| `TENCENT_TTS_VOICE` | 否 | 朗读音色 ID，默认 `502001`（中文女声）。常用音色见下方"音色速查"。**如果用的是腾讯云子账号凭据，记得给子账号授予 `QcloudTTSFullAccess` 策略，否则朗读会报 503**。 |
| `TRANSLATION_BASE_URL` | 是 | 翻译 / 净化模型 base URL（OpenAI 兼容） |
| `TRANSLATION_API_KEY` | 是 | 翻译 / 净化模型 API Key |
| `TRANSLATION_MODEL` | 是 | 翻译模型名 |
| `CLEANUP_MODEL` | 是 | 净化模型名（与翻译模型不同的对话模型） |

### 音色速查（腾讯云 TTS）

| 音色 ID | 描述 |
| --- | --- |
| `502001` | 中文女声·智瑜（默认） |
| `502002` | 中文女声·智聆 |
| `502003` | 中文男声·智康 |
| `101001` | 英文女声·WeRose |
| `101002` | 英文男声·WeJack |

完整音色列表见 [腾讯云语音合成官方文档](https://cloud.tencent.com/document/product/1073/92668)。

把上面这些值换成你自己的腾讯云 / TokenHub 凭据。本文件**没有任何真实凭据示例**，请勿把你的真实密钥写进文档 / 截图 / 日志 / Git。

## 第三步：重启 LinguaMate

托盘菜单 → **退出 LinguaMate** → 再点桌面快捷方式启动。

- 状态栏变"后端已就绪"：配置成功，按 `Ctrl+Shift+L` 录音即可。
- 状态栏仍显示"未配置云端密钥"：检查 `.env` 文件名、路径是否完全一致；任何拼写错误都会让后端 `/health` 返回 `configured: false`。

## 两个新功能：划词翻译与截图翻译

除了录音，LinguaMate 还能翻译**屏幕上看到的英文**。两个功能共用同一个小弹窗，都只做一件事：把译文显示出来，**绝不改动你的文档、绝不模拟按键、绝不自动粘贴**。

### 快捷键总表

| 功能 | 触发方式 | 说明 |
| --- | --- | --- |
| 录音翻译 | `Ctrl+Shift+L` | 按一次开始，再按一次停止。可用 `LINGUAMATE_SHORTCUT` 改。 |
| **截图翻译** | `Ctrl+Shift+S` | 全屏变暗 → 拖框选一块区域 → 松手翻译。可用 `LINGUAMATE_SCREENSHOT_HOTKEY` 改。 |
| **划词翻译** | **没有快捷键** | 见下。 |

> 划词翻译**故意没有热键**。它监听的是按键的**结果**——短时间内剪贴板变了两次。你按的仍然是普通的 `Ctrl+C`，程序不拦截、不模拟、不吞掉它。

### 划词翻译：怎么用

1. 在任何能选中文字的地方（网页、PDF、记事本、VS Code…）**选中一段英文**；
2. **连按两次 `Ctrl+C`**（两次之间隔半秒左右，和双击鼠标差不多）；
3. 屏幕上会出现一个小弹窗，上面是灰色小字的原文，下面是大字的中文译文；
4. 点 `[×]` 或按 `Esc` 关闭。

> **注意**：`Ctrl+C` 会**正常覆盖**你的剪贴板——这本来就是复制该做的事。LinguaMate 只是读一下你复制出来的内容，读完就用完即弃，**自己一个字符都不会写回剪贴板**。

### 截图翻译：怎么用

1. 把要翻译的区域摆到屏幕上；
2. 按 `Ctrl+Shift+S`，整个屏幕变暗，鼠标变成十字；
3. **按住左键拖出一个框**，框住要翻译的区域，松手；
4. 弹窗先显示「正在识别…」，然后是「正在翻译…」，最后是译文；
5. 想取消就按 `Esc` 或点右键——屏幕上什么都不留。

框可以框任何东西：图片里的英文、PDF、聊天记录、视频字幕。**框里没有文字也没关系**，会提示「未识别到文字」。

### 弹窗上的四个按钮

| 按钮 | 什么时候出现 | 点了会发生什么 |
| --- | --- | --- |
| `[复制]` | 有译文时 | 把**译文**放进剪贴板。这是 LinguaMate **唯一**会写剪贴板的地方，且只在你点它的时候。 |
| `[截图翻译]` | 划词读不到内容时 | 重新开一次拖框覆盖层，让你换一块区域截图翻译 |
| `[重试]` | 失败但重发有意义时 | 重新发一次同样的请求 |
| `[×]` | 一直都有 | 关闭弹窗（`Esc` 同效） |

### 平台限制

**划词和截图翻译都只在 Windows 上可用。** 在 macOS / Linux 上这两个功能不会注册，托盘菜单里的对应项会标注「仅支持 Windows」。录音翻译不受影响，所有平台都能用。

### 遇到问题时

| 现象 | 原因和办法 |
| --- | --- |
| 连按两次 `Ctrl+C` 没反应 | **两次按得太快**。程序要求观察到**两次独立的剪贴板变化，且两次之间不超过 1 秒**；每次变化后另有 280 毫秒去抖窗口（Windows 一次复制会连续写好几种剪贴板格式，不去抖会数出七八次）。请把节奏放到半秒左右，和双击鼠标差不多。 |
| 弹窗说「此内容无法读取」 | 这个应用的选区既读不到、复制出来的也不是纯文本（常见于：游戏画面、PDF 里的图片、某些远程桌面、密码框）。点弹窗上的 `[截图翻译]` 改用截图。 |
| 在 Chrome 里划词没反应 | 已知问题：Chrome 默认关闭了无障碍接口，UI Automation 读不到它的选区。**这不是故障**，直接用 `Ctrl+Shift+S` 截图翻译。 |
| 弹窗说「未识别到文字」 | 框里的区域确实没有可识别的文字（纯白、纯色块、太小的字）。框大一点，或者换一块有字的区域。**重试没有意义**——所以这一档只给 `[截图翻译]`，不给 `[重试]`。 |
| 弹窗说「截图超时」 | 覆盖层开着 60 秒你没框选，它自动收摊了（不这样的话整个桌面会一直黑着）。重新按 `Ctrl+Shift+S` 即可。 |
| 弹窗说「识别超时」 | 腾讯云 OCR 超过 30 秒没响应。点 `[重试]`。 |
| 弹窗说「选区太小」/「截图过大」 | 框得太小（截不到内容）或太大（超过服务端 3MB 上限）。调整框的大小再来一次。 |
| 弹窗说「鉴权失败」/「配额用尽」/「未配置」 | `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 没配、被吊销，或腾讯云 OCR 欠费了。查 `.env` 和腾讯云控制台。 |
| 按 `Ctrl+Shift+S` 没反应，但录音正常 | 这个快捷键被别的软件抢占了。用 `LINGUAMATE_SCREENSHOT_HOTKEY` 换一个（比如改成 `Ctrl+Shift+A`）。录音热键不受影响——它走的是另一条注册路径。 |
| 划词翻译把「刚复制好的内容」弄丢了 | 不会。LinguaMate 读剪贴板只读不写，你复制完的东西在弹窗出现前后完全一样。可以自己核对：触发划词前后各按一次 `Ctrl+V` 到记事本，比对内容。 |

### 隐私边界（这部分是硬承诺，不是宣传）

- **划词翻译全程不写剪贴板**，一个字符都不写。你按 `Ctrl+C` 复制了什么，弹窗出来之后剪贴板里还是什么。
- 划词和截图**都不把你的文字写进任何日志、诊断文件或历史记录**。程序只会记录「长度多少」「来自哪个程序」「成功没有」这类元数据。
- 截图只存在于内存里，识别完立刻丢弃，**不落盘、不进回收站**。
- LinguaMate 不会模拟 `Ctrl+C`、不会模拟 `Ctrl+V`、不会往你正在用的窗口里打字。**译文只出现在那个小弹窗里，怎么处置完全由你决定。**

## 卸载时数据如何处理

- 控制面板 → 卸载 LinguaMate 时，**安装目录会被清空**，但 `%APPDATA%\LinguaMate\.env` **会保留**（这是你的云端密钥，是你的数据）。
- 卸载提示框会明确告诉你这点。
- 重新安装后无需重新写 `.env`，直接重启即可。

## 故障排查

| 现象 | 可能原因 |
| --- | --- |
| 托盘出现但悬浮窗状态栏一直"后端启动中…" | 8787 端口被其它进程占用。检查 `LINGUAMATE_BACKEND_PORT` 环境变量，或关掉冲突进程。 |
| 状态栏"未配置云端密钥" | `.env` 文件不存在 / 文件名错 / 内容某行缺引号或拼错 key 名 |
| 录音能识别但翻译一直空 | `TRANSLATION_BASE_URL` 或 `TRANSLATION_API_KEY` 没配齐；看后端 `/health` 的 `translate` 字段 |
| 录音出 final 段但中文净化稿空 | `CLEANUP_MODEL` 没配；`/health` 的 `cleanup` 字段 |
| 点朗读没声音 / 状态栏"语音合成服务不可用" | `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 没配；或 TTS 服务没在腾讯云控制台开通；或用的是子账号但没授予 `QcloudTTSFullAccess` |
| 点朗读状态栏"语音合成返回为空" | 文本全是标点 / 数字 / 净化失败的占位词；换一个含英文句子的内容再试 |

如果 `/health` 返回结构你没把握，可以这样直接看：

```powershell
# 启动 LinguaMate 后单独跑
curl http://localhost:8787/health
```

它会返回 `{ "asr": true/false, "translate": true/false, "cleanup": true/false }`，三个都 `true` 才是配置成功。

也可以单独试一下朗读端点：

```powershell
curl -X POST http://localhost:8787/v1/tts -H "Content-Type: application/json" -d '{"text":"Hello"}' --output test.mp3
```

`test.mp3` 双击能用 Windows Media Player / Groove 播放 = 腾讯云 TTS 通了。

## 文件位置速查

- 安装目录：`%LOCALAPPDATA%\Programs\LinguaMate\`（per-user 安装；卸载时清空）
- 用户配置：`%APPDATA%\LinguaMate\.env`（卸载时保留）
- 本说明：`%APPDATA%\LinguaMate\FIRST_RUN.md`（卸载时保留）