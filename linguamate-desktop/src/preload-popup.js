// 阶段 5 步骤 4：弹窗专用 preload。
// 弹窗窗口开了 sandbox:true，拿不到主进程的 IPC 通道，必须有自己的 preload。
// 只暴露弹窗需要的三个能力，不复用 renderer 的那套。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popupApi', {
  // 初始数据用 request-response 拉，不用 push：
  // loadFile 之后主进程立刻 send，renderer 还没注册 listener 就把事件丢了。
  // 之后主进程再 push 更新（识别中… → 翻译中… → 译文）。
  getData() {
    return ipcRenderer.invoke('popup:getData');
  },
  onData(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_event, payload) => handler(payload || {});
    ipcRenderer.on('popup:data', wrapped);
    return () => ipcRenderer.removeListener('popup:data', wrapped);
  },
  // 渲染完把真实高度告诉主进程，主进程据此 resize + 定位，然后才 show
  reportHeight(height) {
    ipcRenderer.send('popup:resized', { height });
  },
  // 本阶段唯一一处写剪贴板：用户显式点 [复制] 时才触发
  copy(text) {
    ipcRenderer.send('popup:copy', typeof text === 'string' ? text : '');
  },
  // [重试]。不带参数：主进程手里已经有 payload 了。
  retry() {
    ipcRenderer.send('popup:retry');
  },
  // [截图翻译]：划词读不到内容时的兜底出口。
  // 同样是无参——它转达的只是「用户点了一下」，覆盖层由主进程去开。
  // 渲染层拿不到任何截图能力，这是「绝不自动截图」在结构上的保证。
  screenshot() {
    ipcRenderer.send('popup:screenshot');
  },
  close() {
    ipcRenderer.send('popup:close');
  },
});
