/**
 * 内容脚本：在商品详情页注入「获取图片」悬浮按钮，提取页面图片并交给扩展后台。
 * 依赖同目录先加载的 extract.js（全局 ImgXExtract）。
 */
(function () {
  'use strict';

  // 同一页面可能被重复注入（例如扩展重载），做一次幂等保护
  if (window.__IMGX_CONTENT_LOADED__) return;
  window.__IMGX_CONTENT_LOADED__ = true;

  const X = window.ImgXExtract;
  if (!X) {
    console.warn('[ImgX] extract.js 未加载，跳过注入');
    return;
  }

  /** 仅商品详情页才显示按钮；平台路由集中在 extract.js 的 PLATFORM_RULES */
  const platformInfo = X.detectPlatform(location.href);
  if (!platformInfo) return;

  const HOST_ID = 'imgx-root';
  const SCROLL_BUDGET_MS = 3000;

  let host = null;
  let shadow = null;
  let btn = null;
  let toastEl = null;
  let toastTimer = 0;
  let running = false;
  let ready = false;

  /** 启动参数：只有页面主体可见时才注入，避免 iframe / 预渲染页面出现按钮 */
  if (document.visibilityState === 'prerender') return;

  mount();
  // 单页应用切换路由时同步按钮显示状态
  window.addEventListener('popstate', syncVisibility);

  // ---------------------------------------------------------------- UI

  function mount() {
    if (document.getElementById(HOST_ID)) {
      host = document.getElementById(HOST_ID);
      shadow = host.shadowRoot;
      btn = shadow && shadow.getElementById('imgx-fab');
      toastEl = shadow && shadow.getElementById('imgx-toast');
      return;
    }

    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-imgx', '1');
    // 初始内联定位，保证样式文件加载前不闪到页面流中
    host.style.cssText = 'position:fixed;right:24px;bottom:96px;z-index:2147483646;visibility:hidden;';

    shadow = host.attachShadow({ mode: 'open' });

    // 外链样式注入 Shadow DOM；content.css 已声明为 web_accessible_resources
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');
    link.addEventListener('load', reveal);
    link.addEventListener('error', () => {
      // 样式加载失败时兜底，保证按钮至少可见
      const style = document.createElement('style');
      style.textContent =
        '#imgx-fab{position:relative;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;' +
        'background:linear-gradient(135deg,#4f7cff,#7c4dff);color:#fff;font:600 14px/1 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'cursor:pointer;box-shadow:0 10px 24px rgba(79,124,255,.35)}';
      shadow.appendChild(style);
      reveal();
    });
    shadow.appendChild(link);

    btn = document.createElement('button');
    btn.id = 'imgx-fab';
    btn.type = 'button';
    btn.dataset.state = 'idle';
    btn.setAttribute('aria-label', '获取当前页面的商品图片');
    btn.title = '提取当前页面的商品图片';
    btn.innerHTML =
      '<svg class="imgx-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="3"></rect>' +
      '<circle cx="8.5" cy="9.5" r="1.8" fill="currentColor" stroke="none"></circle>' +
      '<path d="M4.5 17.5l4.6-4.6a1.5 1.5 0 0 1 2.1 0l2.2 2.2"></path>' +
      '<path d="M14.5 14.5l1.4-1.4a1.5 1.5 0 0 1 2.1 0l1.5 1.5"></path></svg>' +
      '<span class="imgx-label">获取图片</span>';

    toastEl = document.createElement('div');
    toastEl.id = 'imgx-toast';
    toastEl.hidden = true;
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');

    shadow.appendChild(btn);
    shadow.appendChild(toastEl);
    (document.body || document.documentElement).appendChild(host);

    btn.addEventListener('click', onButtonClick);
    // 阻止按钮上的手势冒泡到页面（例如拖拽、卡片点击）
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      host.addEventListener(type, (e) => e.stopPropagation(), true);
    }

    // 样式若在极端情况下迟迟不触发 load，也强制显示
    setTimeout(reveal, 600);
    syncVisibility();
  }

  function reveal() {
    if (ready || !host) return;
    ready = true;
    host.style.visibility = 'visible';
  }

  function syncVisibility() {
    if (!host) return;
    const ok = !!X.detectPlatform(location.href);
    host.style.display = ok ? '' : 'none';
  }

  /**
   * @param {'idle'|'loading'|'error'} state
   * @param {string} text
   */
  function setButtonState(state, text) {
    if (!btn) return;
    btn.dataset.state = state;
    btn.disabled = state === 'loading';
    const label = btn.querySelector('.imgx-label');
    if (label) label.textContent = text;
  }

  function showToast(message, kind) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.dataset.kind = kind || 'info';
    toastEl.hidden = false;
    // 触发过渡动画
    requestAnimationFrame(() => toastEl.classList.add('imgx-show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('imgx-show');
      setTimeout(() => {
        if (!toastEl.classList.contains('imgx-show')) toastEl.hidden = true;
      }, 200);
    }, 3200);
  }

  // ---------------------------------------------------------------- 行为

  async function onButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();
    await runExtract();
  }

  async function runExtract() {
    if (running) return;
    running = true;
    setButtonState('loading', '提取中…');
    showToast('正在触发懒加载并扫描图片…', 'info');

    try {
      await autoScroll();

      const items = X.collectCandidates(document, window, { minSize: X.MIN_SIZE });
      if (!items.length) {
        showToast('未找到符合条件的商品图片（需 ≥100×100）', 'error');
        setButtonState('idle', '获取图片');
        return;
      }

      const resp = await sendMessage({
        type: 'IMGX_EXTRACT_RESULT',
        items,
        pageUrl: location.href,
        title: document.title,
        platform: platformInfo.platform,
        platformLabel: platformInfo.label,
      });

      if (!resp || !resp.ok) {
        throw new Error((resp && resp.error) || '扩展后台未响应');
      }
      showToast(`已提取 ${items.length} 张图片，正在打开预览页…`, 'success');
      setButtonState('idle', '获取图片');
    } catch (err) {
      console.warn('[ImgX] 提取失败：', err);
      const msg = String((err && err.message) || err);
      showToast(
        /context invalidated/i.test(msg) ? '扩展已更新，请刷新页面后重试' : `提取失败：${msg}`,
        'error'
      );
      setButtonState('error', '重试');
      setTimeout(() => {
        setButtonState('idle', '获取图片');
      }, 1500);
    } finally {
      running = false;
    }
  }

  /**
   * 分步滚动到底部再复位，触发懒加载；总时长受 SCROLL_BUDGET_MS 限制。
   */
  async function autoScroll() {
    const scroller = document.scrollingElement || document.documentElement;
    const startY = window.scrollY || scroller.scrollTop || 0;
    const step = Math.max(320, Math.floor(window.innerHeight * 0.9));
    const deadline = Date.now() + SCROLL_BUDGET_MS;

    let y = startY;
    let guard = 0;
    while (Date.now() < deadline && guard < 40) {
      guard += 1;
      const maxY = Math.max(0, (scroller.scrollHeight || 0) - window.innerHeight);
      if (y >= maxY) break;
      y = Math.min(maxY, y + step);
      window.scrollTo(0, y);
      // 部分站点监听 scroll 事件才加载，补发一次
      window.dispatchEvent(new Event('scroll'));
      await sleep(120);
    }

    // 回到用户原来的位置，避免打断浏览
    window.scrollTo(0, startY);
    await sleep(180);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 包装 runtime.sendMessage，把 lastError 转成 Promise 拒绝 */
  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(resp);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // 工具栏图标点击时由 background 转发触发
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'IMGX_TRIGGER_EXTRACT') return undefined;
    runExtract().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true; // 异步响应
  });
})();
