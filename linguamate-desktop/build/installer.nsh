; 阶段 4 NSIS 钩子。
; customInstall：安装完弹一次提示，让用户去看 FIRST_RUN.md。
; customUnInstall：electron-builder deleteAppDataOnUninstall:false 已经保证
;   %APPDATA%\LinguaMate\.env 不会被卸载；这里只显示卸载完成消息。

!macro customInstall
  MessageBox MB_ICONINFORMATION|MB_OK "LinguaMate 已安装完成。$\r$\n$\r$\n首次启动前请按 FIRST_RUN.md 说明把云端 .env 放到 %APPDATA%\LinguaMate\.env。$\r$\n$\r$\n未配置时悬浮窗会提示，请到任务栏托盘菜单点'退出 LinguaMate'后再次启动。" IDOK
!macroend

!macro customUnInstall
  MessageBox MB_ICONINFORMATION|MB_OK "LinguaMate 已卸载。$\r$\n$\r$\n%APPDATA%\LinguaMate\.env 仍保留（你的云端密钥），下次安装可直接复用。" IDOK
!macroend