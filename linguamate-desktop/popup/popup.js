// 阶段 5 步骤 4：弹窗渲染层。
//
// 初始数据用 invoke 拉（getData），后续更新用 onData 收。
// 渲染完把真实高度 reportHeight 回去，主进程据此 resize + 定位，然后才显示——
// 这样既不会按最大高度先闪一下，也不用在主进程里猜内容多高。
//
// Esc 关闭：弹窗 focusable:true + show()，出现时**抢焦点**，所以键盘事件进得来。
// 取舍见 src/popup-manager.js 文件头——2026-09-30 用户在「Esc 关不掉」之后明确
// 接受「弹窗会打断当前应用」换来的。
// 边界要说清楚：Esc 只在**弹窗持有焦点时**有效。用户点回原应用继续干活之后，
// Esc 就回到原应用去了，弹窗不会跟着关——那属于用户已经不在看这个弹窗。

const api = window.popupApi;

const el = {
  popup: document.getElementById('popup'),
  kind: document.getElementById('kind'),
  sourceWrap: document.getElementById('source-wrap'),
  source: document.getElementById('source'),
  translation: document.getElementById('translation'),
  notice: document.getElementById('notice'),
  status: document.getElementById('status'),
  retry: document.getElementById('retry'),
  screenshot: document.getElementById('screenshot'),
  copy: document.getElementById('copy'),
  close: document.getElementById('close'),
};

let lastCopied = '';

function setStatus(text, tone) {
  el.status.textContent = text || '';
  if (tone) el.status.dataset.tone = tone;
  else delete el.status.dataset.tone;
}

function clearNotice() {
  el.notice.hidden = true;
  el.notice.textContent = '';
  el.popup.querySelector('.truncated')?.remove();
}

function showNotice(text) {
  el.notice.textContent = text || '';
  el.notice.hidden = !text;
}

function showTruncated() {
  if (el.popup.querySelector('.truncated')) return;
  const tag = document.createElement('span');
  tag.className = 'truncated';
  tag.textContent = '内容较长，已截断';
  el.popup.appendChild(tag);
}

function render(data) {
  if (!data) return;
  const mode = data.mode === 'screenshot' ? 'screenshot' : 'selection';
  el.kind.textContent = mode === 'screenshot' ? '截图翻译' : '划词翻译';

  const source = typeof data.sourceText === 'string' ? data.sourceText : '';
  if (source) {
    el.source.textContent = source;
    el.sourceWrap.hidden = false;
  } else {
    el.source.textContent = '';
    el.sourceWrap.hidden = true;
  }

  const translation = typeof data.translation === 'string' ? data.translation : '';
  el.translation.textContent = translation;
  lastCopied = translation;

  clearNotice();
  if (data.truncated) showTruncated();
  if (data.error) {
    showNotice(data.error);
    // 主进程已经把「为什么失败」分得很细（未识别到文字 / 截图超时 / 鉴权失败 /
    // 配额用尽 / 读不到内容），这里硬写「出错了」会把这些区分全抹掉——用户看到的
    // 永远是同一句话，只能反复重试。给了 status 就用它，只在主进程没给时才兜底。
    setStatus(data.status || '出错了', 'error');
  } else if (data.status) {
    setStatus(data.status, translation ? 'done' : null);
  } else if (translation) {
    setStatus('完成', 'done');
  } else {
    setStatus('准备中…');
  }

  // [重试] 只在**确实是失败态、且重发有意义**时出现。
  // 可见性由主进程给的 `retryable` 决定，不再看「有没有原文」：
  //  · 截图 OCR 挂掉时压根还没有原文，但**恰恰最需要**能重试，所以不能靠 source 判断；
  //  · 「读不到内容」「未识别到文字」这两类，重发同一份空数据毫无意义，
  //    主进程会显式给 retryable:false——「此内容无法读取」那一条还会给
  //    action:'screenshot'，换成 [截图翻译] 这个真正有用的出口。
  el.retry.hidden = !data.error || data.retryable === false;
  // [截图翻译] 只在主进程点名要它时出现。点了也只是转达一次点击，
  // 覆盖层开不开由主进程决定——渲染层自己绝不会去发起截图。
  el.screenshot.hidden = data.action !== 'screenshot';
  el.copy.hidden = !translation;
  // 打开后告诉主进程真实高度
  requestAnimationFrame(reportHeight);
}

function reportHeight() {
  const height = Math.ceil(el.popup.getBoundingClientRect().height) + 12;
  api.reportHeight(height);
}

el.close.addEventListener('click', () => api.close());

// Esc 关闭。弹窗里没有任何输入框，不存在「Esc 应该先作用在某个控件上」这种分支，
// 直接关掉。走的是和 [×] 同一个 popup:close 通道，主进程那边销毁逻辑不用分叉。
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  api.close();
});

// 重试不传原文：主进程手里就有 payload，让原文在渲染进程里再走一圈没有意义，
// 反而让「谁持有用户文本」这件事变模糊（隐私边界要求越少环节越好）。
el.retry.addEventListener('click', () => {
  el.retry.disabled = true;
  api.retry();
  setTimeout(() => { el.retry.disabled = false; }, 600);
});

// [截图翻译]：划词读不到内容时的兜底出口。这里只发一个「用户点了」，
// 不传任何参数——主进程手上没有选区可复用，它只能重新开一次覆盖层让用户重选。
el.screenshot.addEventListener('click', () => {
  el.screenshot.disabled = true;
  api.screenshot();
  setTimeout(() => { el.screenshot.disabled = false; }, 600);
});

el.copy.addEventListener('click', () => {
  if (!lastCopied) return;
  // 本阶段唯一一处写剪贴板，且只在用户显式点击时发生
  api.copy(lastCopied);
  el.copy.dataset.copied = '1';
  el.copy.textContent = '已复制';
  setTimeout(() => {
    delete el.copy.dataset.copied;
    el.copy.textContent = '复制';
  }, 1200);
});

// 主进程可能在数据到达前就 resize 过，字体加载完再报一次高度
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(reportHeight);
}

api.getData().then(render);
api.onData(render);
