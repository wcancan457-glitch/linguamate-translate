// 阶段 4 preload：阶段 3 全部 + 配置状态 IPC + 打开本地文件 IPC。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linguamate', {
  onBackendReady(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on('backend:ready', wrapped);
    return () => ipcRenderer.removeListener('backend:ready', wrapped);
  },
  onRecordingState(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on('recording:state', wrapped);
    return () => ipcRenderer.removeListener('recording:state', wrapped);
  },
  onShortcutStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    const onRegistered = (_event, payload) => handler({ type: 'registered', ...(payload || {}) });
    const onFailed = (_event, payload) => handler({ type: 'failed', ...(payload || {}) });
    ipcRenderer.on('shortcut:registered', onRegistered);
    ipcRenderer.on('shortcut:registration-failed', onFailed);
    return () => {
      ipcRenderer.removeListener('shortcut:registered', onRegistered);
      ipcRenderer.removeListener('shortcut:registration-failed', onFailed);
    };
  },
  onConfigStatus(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on('config:status', wrapped);
    return () => ipcRenderer.removeListener('config:status', wrapped);
  },
  hideWindow(reason) {
    ipcRenderer.send('window:hide', reason || 'renderer-request');
  },
  copyToClipboard(text) {
    return ipcRenderer.invoke('clipboard:write', text);
  },
  openPath(target) {
    return ipcRenderer.invoke('shell:openPath', target);
  },
  getEnvPath() {
    return ipcRenderer.invoke('config:getEnvPath');
  },
  getConfigStatus() {
    // renderer 启动后主动拉一次：push 模型有 race condition（renderer 还没注册
    // listener 时 main 已经发了 config:status，事件丢失），request-response 兜底。
    return ipcRenderer.invoke('config:getStatus');
  },
});