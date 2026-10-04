// 阶段 5 步骤 5：截图覆盖层的交互。
//
// 只做一件事：让用户拖出一个矩形，然后把这个矩形的**视口 CSS 像素坐标**报上去。
// 换算成物理像素是主进程的事（它才知道缩略图实际多大）。
//
// 取消路径：Esc、右键。两者都只上报「取消」，不带任何坐标。

const api = window.captureApi;

const el = {
  selection: document.getElementById('selection'),
  size: document.getElementById('size'),
  hint: document.getElementById('hint'),
};

const MIN_PX = 4;

let anchor = null;      // mousedown 的落点
let dragTo = { x: 0, y: 0 };
let dragging = false;

function currentRect() {
  if (!anchor) return null;
  return {
    x: Math.min(anchor.x, dragTo.x),
    y: Math.min(anchor.y, dragTo.y),
    width: Math.abs(dragTo.x - anchor.x),
    height: Math.abs(dragTo.y - anchor.y),
  };
}

function paint() {
  const rect = currentRect();
  if (!rect || rect.width < 1 || rect.height < 1) {
    el.selection.hidden = true;
    return;
  }
  el.selection.hidden = false;
  el.selection.style.left = `${rect.x}px`;
  el.selection.style.top = `${rect.y}px`;
  el.selection.style.width = `${rect.width}px`;
  el.selection.style.height = `${rect.height}px`;
  el.size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

// 夹回视口。覆盖层铺满整块屏幕，正常情况下鼠标根本出不去，但窗口边界/多屏
// 拖拽仍可能给出越界坐标——夹住比让主进程拿到一个越界矩形安全。
function clampPoint(event) {
  return {
    x: Math.min(Math.max(event.clientX, 0), window.innerWidth),
    y: Math.min(Math.max(event.clientY, 0), window.innerHeight),
  };
}

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;      // 只认左键；右键走 contextmenu 取消
  event.preventDefault();
  anchor = clampPoint(event);
  dragTo = { ...anchor };
  dragging = true;
  el.hint.textContent = '松开鼠标开始识别 · Esc / 右键取消';
  paint();
});

document.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  dragTo = clampPoint(event);
  paint();
});

document.addEventListener('mouseup', (event) => {
  if (!dragging) return;
  dragging = false;
  dragTo = clampPoint(event);
  const rect = currentRect();
  anchor = null;
  el.selection.hidden = true;
  // 框太小就是误点（手滑），不提交、不结束：让用户原地重画。
  // 这时主进程那边什么都没发生——覆盖层还开着，没有任何代价。
  if (!rect || rect.width < MIN_PX || rect.height < MIN_PX) {
    el.hint.textContent = '区域太小，请重新拖框 · Esc / 右键取消';
    return;
  }
  api.submitRegion(rect);
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.cancel();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  api.cancel();
});

// 覆盖层是 focusable:true + show()，焦点就在这里，Esc 收得到。
// 但保险起见：页面获得焦点时也主动对一下，用户点了遮罩以外的地方也不会卡住。
window.addEventListener('focus', () => { document.body.classList.add('focused'); });
window.addEventListener('blur', () => { document.body.classList.remove('focused'); });
