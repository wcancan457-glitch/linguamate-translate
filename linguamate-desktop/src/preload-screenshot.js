// 阶段 5 步骤 5：覆盖层专用 preload。
// 覆盖层开了 sandbox:true，拿不到主进程的 IPC 通道，必须有自己的 preload。
// 只暴露覆盖层需要的两个能力：提交选区 / 取消。不复用 renderer 或 popup 的那套。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureApi', {
  // 选区用 send 而不是 invoke：这是一次性的单向上报，主进程那边要的是「拿到就干活」，
  // 不需要回执。真要用 invoke 也行，但返回 Promise 只会让渲染层多一层无用状态。
  // 坐标一律用视口内的 CSS 像素——覆盖层窗口与屏幕 DIP 是 1:1，主进程据此换算物理像素。
  submitRegion(rect) {
    ipcRenderer.send('screenshot:region', {
      x: Number(rect && rect.x),
      y: Number(rect && rect.y),
      width: Number(rect && rect.width),
      height: Number(rect && rect.height),
    });
  },
  // Esc / 右键。**只上报意图，不带任何坐标**——用户没选东西，主进程不该拿到选区。
  cancel() {
    ipcRenderer.send('screenshot:cancel');
  },
});
