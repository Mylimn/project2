/**
 * gallery 页面逻辑
 *
 * 1. 向 Service Worker 拉取最近一次提取结果
 * 2. 网格渲染缩略图、尺寸、来源，支持筛选与勾选
 * 3. 勾选后批量下载：fetch -> createImageBitmap -> OffscreenCanvas 转 PNG
 * 4. 转换失败时回退为原图格式下载，并给出明确提示
 */
(function () {
  'use strict';

  const CONCURRENCY = 3;
  const DOWNLOAD_TIMEOUT_MS = 90 * 1000;
  /** 前若干张缩略图立即加载，保证尺寸筛选及时生效；其余懒加载 */
  const EAGER_LIMIT = 60;

  const SOURCE_LABELS = {
    img: '页面图片',
    lazy: '懒加载',
    srcset: '响应式图',
    background: '背景图',
    poster: '视频封面',
  };

  const el = {
    meta: document.getElementById('page-meta'),
    platform: document.getElementById('platform-badge'),
    total: document.getElementById('total-count'),
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    emptyHint: document.getElementById('empty-hint'),
    selectAll: document.getElementById('select-all'),
    invert: document.getElementById('invert'),
    clearSelection: document.getElementById('clear-selection'),
    selectedCount: document.getElementById('selected-count'),
    minSize: document.getElementById('min-size'),
    download: document.getElementById('download'),
    progress: document.getElementById('progress'),
    progressTitle: document.getElementById('progress-title'),
    progressText: document.getElementById('progress-text'),
    progressFill: document.getElementById('progress-fill'),
    progressList: document.getElementById('progress-list'),
    progressClose: document.getElementById('progress-close'),
    toast: document.getElementById('toast'),
  };

  const state = {
    payload: null,
    /** url -> { el, item, checkbox, dimsEl, stateEl } */
    cards: new Map(),
    /** 展示顺序 */
    order: [],
    selected: new Set(),
    minSize: 100,
    visibleCount: 0,
    downloading: false,
    /** url -> { row, stateEl, nameEl, status } */
    jobs: new Map(),
    jobTotal: 0,
    jobDone: 0,
    /** 尚未释放的 blob URL */
    objectUrls: new Set(),
    /** downloadId -> { resolve, reject, timer } */
    pending: new Map(),
    toastTimer: 0,
    renderToken: 0,
  };

  init();

  function init() {
    bindEvents();
    loadPayload();
  }

  function bindEvents() {
    el.selectAll.addEventListener('click', selectAllVisible);
    el.invert.addEventListener('click', invertVisible);
    el.clearSelection.addEventListener('click', () => {
      for (const url of Array.from(state.selected)) setSelected(url, false);
      updateCounts();
    });
    el.minSize.addEventListener('change', () => {
      state.minSize = Number(el.minSize.value) || 0;
      applyFilter();
    });
    el.download.addEventListener('click', onDownloadClick);
    el.progressClose.addEventListener('click', () => {
      el.progress.hidden = true;
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.type !== 'string') return undefined;
      if (message.type === 'IMGX_DL_PROGRESS') {
        settleDownload(message.downloadId, message.state, message.error);
      } else if (message.type === 'IMGX_PAYLOAD_UPDATED') {
        loadPayload();
      }
      return undefined;
    });

    window.addEventListener('beforeunload', () => {
      for (const url of state.objectUrls) URL.revokeObjectURL(url);
      state.objectUrls.clear();
    });
  }

  // ---------------------------------------------------------------- 数据加载

  async function loadPayload() {
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'IMGX_GET_PAYLOAD' });
    } catch (err) {
      showEmpty(`无法连接扩展后台：${(err && err.message) || err}`);
      return;
    }
    if (!resp || !resp.ok) {
      showEmpty((resp && resp.error) || '暂无提取结果');
      return;
    }
    render(resp.payload);
  }

  function showEmpty(message) {
    state.payload = null;
    state.cards.clear();
    state.order = [];
    state.selected.clear();
    state.visibleCount = 0;
    el.grid.textContent = '';
    el.empty.hidden = false;
    el.emptyHint.textContent = message || '请先在商品详情页点击「获取图片」。';
    el.meta.textContent = '暂无数据';
    el.platform.hidden = true;
    el.total.textContent = '共 0 张';
    updateCounts();
  }

  // ---------------------------------------------------------------- 渲染

  function render(payload) {
    const token = ++state.renderToken;
    state.payload = payload;
    state.cards.clear();
    state.order = [];
    state.selected.clear();
    state.jobs.clear();
    state.visibleCount = 0;
    el.grid.textContent = '';
    el.empty.hidden = true;

    // 顶部来源信息
    el.meta.textContent = '';
    const link = document.createElement('a');
    link.href = payload.pageUrl || '#';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = payload.title ? truncate(payload.title, 70) : '商品详情页';
    el.meta.append('来源：', link, ` · ${formatTime(payload.createdAt)}`);

    if (payload.platformLabel) {
      el.platform.hidden = false;
      el.platform.textContent = payload.platformLabel;
      el.platform.dataset.platform = payload.platform || '';
    } else {
      el.platform.hidden = true;
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      showEmpty('本次没有提取到符合条件的图片，请回到商品页重试。');
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((item, index) => {
      const card = createCard(item, index);
      if (!card) return;
      state.cards.set(item.url, card);
      state.order.push(item.url);
      frag.appendChild(card.el);
    });
    el.grid.appendChild(frag);

    // 渲染期间如果又收到新的 payload，放弃这次筛选计算
    if (token !== state.renderToken) return;
    applyFilter();
  }

  function createCard(item, index) {
    if (!item || !item.url) return null;

    const cardEl = document.createElement('article');
    cardEl.className = 'card';
    cardEl.dataset.url = item.url;

    const checkLabel = document.createElement('label');
    checkLabel.className = 'check';
    checkLabel.title = '选择这张图片';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', '选择这张图片');
    checkLabel.appendChild(checkbox);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.tabIndex = 0;
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('aria-label', '切换选中状态');

    const img = document.createElement('img');
    img.alt = item.alt || '商品图片';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.loading = index < EAGER_LIMIT ? 'eager' : 'lazy';
    img.src = item.url;
    thumb.appendChild(img);

    const stateEl = document.createElement('span');
    stateEl.className = 'card-state';
    stateEl.hidden = true;
    thumb.appendChild(stateEl);

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta';

    const dimsEl = document.createElement('span');
    dimsEl.className = 'dims';
    dimsEl.textContent = item.w > 0 && item.h > 0 ? `${item.w} × ${item.h}` : '测量中…';

    const srcEl = document.createElement('span');
    srcEl.className = 'src-tag';
    srcEl.textContent = SOURCE_LABELS[item.source] || '图片';

    const openEl = document.createElement('a');
    openEl.className = 'open';
    openEl.href = item.url;
    openEl.target = '_blank';
    openEl.rel = 'noreferrer';
    openEl.textContent = '原图';
    openEl.addEventListener('click', (e) => e.stopPropagation());

    metaRow.append(dimsEl, srcEl, openEl);
    cardEl.append(checkLabel, thumb, metaRow);

    const card = { el: cardEl, item, checkbox, dimsEl, stateEl };

    checkbox.addEventListener('change', () => {
      setSelected(item.url, checkbox.checked);
      updateCounts();
    });

    const toggle = () => {
      if (checkbox.disabled) return;
      setSelected(item.url, !state.selected.has(item.url));
      updateCounts();
    };
    thumb.addEventListener('click', toggle);
    thumb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    img.addEventListener('load', () => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w > 0 && h > 0) {
        item.w = w;
        item.h = h;
        dimsEl.textContent = `${w} × ${h}`;
        applyFilter();
      } else {
        dimsEl.textContent = '尺寸未知';
      }
    });
    img.addEventListener('error', () => {
      cardEl.classList.add('broken');
      dimsEl.textContent = '加载失败';
      checkbox.disabled = true;
      if (state.selected.has(item.url)) {
        setSelected(item.url, false);
        updateCounts();
      }
      applyFilter();
    });

    return card;
  }

  // ---------------------------------------------------------------- 选择与筛选

  function setSelected(url, on) {
    const card = state.cards.get(url);
    if (!card) return;
    if (on) state.selected.add(url);
    else state.selected.delete(url);
    card.checkbox.checked = !!on;
    card.el.classList.toggle('selected', !!on);
  }

  /** 判断当前卡片是否通过最小尺寸筛选 */
  function passesFilter(item) {
    if (state.minSize <= 0) return true;
    const measured = item.w > 0 && item.h > 0;
    if (!measured) return true; // 尺寸未知时先展示，加载后再判定
    return Math.max(item.w, item.h) >= state.minSize;
  }

  function applyFilter() {
    let visible = 0;
    for (const url of state.order) {
      const card = state.cards.get(url);
      if (!card) continue;
      const pass = passesFilter(card.item);
      card.el.classList.toggle('filtered', !pass);
      if (pass) visible += 1;
      else if (state.selected.has(url)) setSelected(url, false);
    }
    state.visibleCount = visible;
    updateCounts();
  }

  function isSelectable(url) {
    const card = state.cards.get(url);
    return !!card && !card.el.classList.contains('filtered') && !card.el.classList.contains('broken');
  }

  function selectAllVisible() {
    for (const url of state.order) {
      if (isSelectable(url)) setSelected(url, true);
    }
    updateCounts();
  }

  function invertVisible() {
    for (const url of state.order) {
      if (!isSelectable(url)) continue;
      setSelected(url, !state.selected.has(url));
    }
    updateCounts();
  }

  function updateCounts() {
    const total = state.order.length;
    const visible = state.visibleCount || total;
    el.total.textContent = visible === total ? `共 ${total} 张` : `显示 ${visible} / ${total} 张`;
    el.selectedCount.textContent = `已选 ${state.selected.size} 张`;
    el.download.disabled = state.selected.size === 0 || state.downloading;
    el.download.textContent = state.downloading ? '下载中…' : '下载选中';
  }

  // ---------------------------------------------------------------- 下载

  async function onDownloadClick() {
    if (state.downloading) return;
    const urls = state.order.filter((url) => state.selected.has(url));
    if (!urls.length) {
      toast('请先勾选要下载的图片', 'error');
      return;
    }

    state.downloading = true;
    updateCounts();
    resetProgressPanel(urls);

    const totals = { done: 0, total: urls.length, success: 0, failed: 0, fallback: 0 };
    const queue = urls.map((url, i) => ({ url, index: i + 1 }));

    const workerCount = Math.min(CONCURRENCY, queue.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    state.downloading = false;
    updateCounts();
    finishProgress(totals);

    async function worker() {
      while (queue.length) {
        const job = queue.shift();
        const result = await runJob(job, totals, urls.length);
        if (result === 'ok') totals.success += 1;
        else if (result === 'fallback') {
          totals.success += 1;
          totals.fallback += 1;
        } else totals.failed += 1;
        totals.done += 1;
        updateProgressBar(totals);
      }
    }
  }

  async function runJob(job, totals, total) {
    const card = state.cards.get(job.url);
    const padded = String(job.index).padStart(3, '0');
    setJobStatus(job.url, 'converting', '转换 PNG…');

    let converted = null;
    try {
      converted = await convertToPng(job.url);
    } catch (err) {
      console.warn('[ImgX] 转换为 PNG 失败：', job.url, err);
    }

    let objectUrl;
    let filename;
    let fallback = false;

    if (converted) {
      objectUrl = URL.createObjectURL(converted.blob);
      state.objectUrls.add(objectUrl);
      filename = `商品图_${padded}.png`;
    } else {
      // 回退：直接下载原图，保留原始扩展名
      fallback = true;
      objectUrl = job.url;
      const ext = guessExt(job.url);
      filename = `商品图_${padded}.${ext}`;
      setJobName(job.url, filename);
    }

    setJobStatus(job.url, 'downloading', fallback ? '下载原图…' : '上传到下载器…');

    try {
      const downloadId = await requestDownload(objectUrl, filename);
      await waitForDownload(downloadId);
      setJobStatus(job.url, 'done', fallback ? '已完成（原格式）' : '已完成');
      setCardState(card, 'done', fallback ? '已下载·原格式' : '已下载');
      if (state.jobs.size <= 80) console.debug('[ImgX] 下载完成', filename);
      return fallback ? 'fallback' : 'ok';
    } catch (err) {
      const reason = errorText(err);
      setJobStatus(job.url, 'failed', `失败：${reason}`);
      setCardState(card, 'failed', '下载失败');
      return 'failed';
    } finally {
      if (converted && objectUrl) {
        // 给下载器留出读取时间后再释放 blob URL
        setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
          state.objectUrls.delete(objectUrl);
        }, 4000);
      }
    }
  }

  /** 请求后台下载；后台异常时退化为扩展页直接调用 downloads API */
  async function requestDownload(objectUrl, filename) {
    let resp = null;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'IMGX_DOWNLOAD',
        url: objectUrl,
        filename,
      });
    } catch (err) {
      resp = { ok: false, error: (err && err.message) || String(err) };
    }

    if (resp && resp.ok && resp.downloadId != null) return resp.downloadId;

    try {
      return await chrome.downloads.download({
        url: objectUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (err) {
      throw new Error((resp && resp.error) || (err && err.message) || '下载请求失败');
    }
  }

  function waitForDownload(downloadId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(downloadId);
        reject(new Error('下载超时'));
      }, DOWNLOAD_TIMEOUT_MS);
      state.pending.set(downloadId, { resolve, reject, timer });

      // 下载可能已经瞬间完成，先主动查询一次状态
      chrome.downloads
        .search({ id: downloadId })
        .then((items) => {
          const item = items && items[0];
          if (!item) return;
          if (item.state === 'complete') settleDownload(downloadId, 'complete', null);
          else if (item.state === 'interrupted') settleDownload(downloadId, 'interrupted', item.error);
        })
        .catch(() => {});
    });
  }

  function settleDownload(downloadId, downloadState, error) {
    const pending = state.pending.get(downloadId);
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(downloadId);
    if (downloadState === 'complete') pending.resolve();
    else pending.reject(new Error(error || '下载被中断'));
  }

  // ---------------------------------------------------------------- PNG 转换

  /**
   * 把任意格式图片转成 PNG。
   * @returns {Promise<{blob: Blob, width: number, height: number}|null>}
   */
  async function convertToPng(url) {
    // 方案 1：扩展页 fetch（有 host_permissions，不受 CORS 限制）
    try {
      const res = await fetch(url, {
        credentials: 'omit',
        cache: 'force-cache',
        referrerPolicy: 'no-referrer',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!/^image\//i.test(blob.type || '')) throw new Error('响应内容不是图片');
      return await blobToPng(blob);
    } catch (err) {
      console.warn('[ImgX] fetch 转 PNG 失败，尝试 canvas：', url, err);
    }

    // 方案 2：<img crossorigin> + canvas（CDN 返回 CORS 头时可用）
    try {
      const img = await loadImage(url);
      return await imageToPng(img);
    } catch (err) {
      console.warn('[ImgX] canvas 转 PNG 失败：', url, err);
    }

    return null;
  }

  async function blobToPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    try {
      if (!width || !height) throw new Error('图片尺寸无效');

      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建画布');
        ctx.drawImage(bitmap, 0, 0);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        return { blob: png, width, height };
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布');
      ctx.drawImage(bitmap, 0, 0);
      const png = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
      });
      return { blob: png, width, height };
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function imageToPng(img) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('图片尺寸无效');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(img, 0, 0);
    const png = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
    });
    return { blob: png, width, height };
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => reject(new Error('图片加载超时')), 20000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('图片加载失败'));
      };
      img.src = url;
    });
  }

  // ---------------------------------------------------------------- 进度面板

  function resetProgressPanel(urls) {
    state.jobs.clear();
    state.jobTotal = urls.length;
    state.jobDone = 0;

    el.progress.hidden = false;
    el.progress.dataset.phase = 'running';
    el.progressTitle.textContent = '正在下载';
    el.progressText.textContent = `0 / ${urls.length}`;
    el.progressFill.style.width = '0%';
    el.progressList.textContent = '';

    const frag = document.createDocumentFragment();
    urls.forEach((url, i) => {
      const row = document.createElement('li');
      row.className = 'progress-item';
      row.dataset.url = url;

      const nameEl = document.createElement('span');
      nameEl.className = 'progress-name';
      nameEl.textContent = `商品图_${String(i + 1).padStart(3, '0')}.png`;

      const stateEl = document.createElement('span');
      stateEl.className = 'progress-state';
      stateEl.textContent = '等待中';

      row.append(nameEl, stateEl);
      frag.appendChild(row);
      state.jobs.set(url, { row, stateEl, nameEl, status: 'waiting' });
    });
    el.progressList.appendChild(frag);
  }

  function setJobStatus(url, status, text) {
    const job = state.jobs.get(url);
    if (!job) return;
    job.status = status;
    job.row.dataset.status = status;
    job.stateEl.textContent = text;
  }

  function setJobName(url, name) {
    const job = state.jobs.get(url);
    if (!job) return;
    job.nameEl.textContent = name;
  }

  function updateProgressBar(totals) {
    const percent = totals.total ? Math.round((totals.done / totals.total) * 100) : 0;
    el.progressFill.style.width = `${percent}%`;
    el.progressText.textContent = `${totals.done} / ${totals.total}`;
  }

  function finishProgress(totals) {
    el.progress.dataset.phase = totals.failed ? 'error' : 'done';
    el.progressTitle.textContent = totals.failed ? '下载结束（部分失败）' : '下载完成';
    const parts = [`成功 ${totals.success} / ${totals.total} 张`];
    if (totals.fallback) parts.push(`其中 ${totals.fallback} 张回退为原格式`);
    if (totals.failed) parts.push(`失败 ${totals.failed} 张`);
    el.progressText.textContent = parts.join('，');
    el.progressFill.style.width = '100%';

    if (totals.failed) {
      toast(`下载完成：成功 ${totals.success} 张，失败 ${totals.failed} 张`, 'error');
    } else {
      toast(
        totals.fallback
          ? `已下载 ${totals.success} 张（${totals.fallback} 张因跨域限制回退为原格式）`
          : `已下载 ${totals.success} 张 PNG 图片`,
        'success'
      );
    }
  }

  function setCardState(card, status, text) {
    if (!card) return;
    card.el.dataset.status = status;
    if (status === 'done') {
      card.stateEl.hidden = false;
      card.stateEl.textContent = text;
    } else if (status === 'failed') {
      card.stateEl.hidden = false;
      card.stateEl.textContent = text;
    }
  }

  // ---------------------------------------------------------------- 工具函数

  function errorText(err) {
    const msg = (err && err.message) || String(err || '未知错误');
    if (/Failed to fetch/i.test(msg)) return '网络或跨域限制';
    return truncate(msg, 40);
  }

  function guessExt(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const m = path.match(/\.(jpe?g|png|webp|gif|bmp)$/);
      if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
    } catch (_) {
      /* 忽略 */
    }
    return 'jpg';
  }

  function formatTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (_) {
      return '';
    }
  }

  function truncate(str, len) {
    const s = String(str || '');
    return s.length > len ? `${s.slice(0, len - 1)}…` : s;
  }

  function toast(message, kind) {
    el.toast.textContent = message;
    el.toast.dataset.kind = kind || 'info';
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => {
        if (!el.toast.classList.contains('show')) el.toast.hidden = true;
      }, 200);
    }, 4000);
  }
})();
