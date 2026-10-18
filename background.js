/**
 * Service Worker（MV3）
 *
 * 职责：
 * 1. 接收内容脚本提取到的图片列表，暂存到 chrome.storage.session，并打开 gallery 页面
 * 2. 为 gallery 提供结果读取接口（SW 被回收后依然可用）
 * 3. 执行 chrome.downloads.download，并把下载进度广播回 gallery
 * 4. 工具栏图标点击作为悬浮按钮的兜底入口
 */

const PAYLOAD_KEY = 'imgx:payload';
/** 提取结果有效期：30 分钟 */
const PAYLOAD_TTL_MS = 30 * 60 * 1000;
/** 单次最多保留的图片数量，与内容脚本保持一致 */
const MAX_ITEMS = 500;

/** downloadId -> { filename, createdAt } */
const activeDownloads = new Map();

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => {
      console.error('[ImgX] 消息处理失败：', message && message.type, err);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    });
  // 返回 true 保持消息通道，等待异步 sendResponse
  return true;
});

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: '无效的消息' };
  }

  switch (message.type) {
    case 'IMGX_PING':
      return { ok: true, version: chrome.runtime.getManifest().version };

    case 'IMGX_EXTRACT_RESULT':
      return handleExtractResult(message, sender);

    case 'IMGX_GET_PAYLOAD':
      return getPayload();

    case 'IMGX_DOWNLOAD':
      return handleDownload(message);

    case 'IMGX_OPEN_GALLERY':
      await openGallery();
      return { ok: true };

    default:
      return { ok: false, error: `未知消息类型：${message.type}` };
  }
}

/**
 * 保存提取结果并打开预览页。
 */
async function handleExtractResult(message) {
  const items = sanitizeItems(message.items);
  if (!items.length) return { ok: false, error: '没有可下载的图片' };

  const payload = {
    sid: crypto.randomUUID(),
    items,
    pageUrl: String(message.pageUrl || ''),
    title: String(message.title || '').slice(0, 200),
    platform: String(message.platform || 'unknown'),
    platformLabel: String(message.platformLabel || ''),
    createdAt: Date.now(),
  };

  await chrome.storage.session.set({ [PAYLOAD_KEY]: payload });
  await openGallery();
  await setBadge(items.length);
  return { ok: true, sid: payload.sid, count: items.length };
}

/** 清洗内容脚本传来的数据，避免把异常字段写进存储 */
function sanitizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const url = typeof raw.url === 'string' ? raw.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      w: Math.max(0, Math.min(20000, Number(raw.w) || 0)),
      h: Math.max(0, Math.min(20000, Number(raw.h) || 0)),
      source: String(raw.source || 'img').slice(0, 20),
      alt: String(raw.alt || '').slice(0, 100),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * 读取上次提取结果；过期或不存在时返回可读错误。
 */
async function getPayload() {
  let stored;
  try {
    stored = await chrome.storage.session.get(PAYLOAD_KEY);
  } catch (err) {
    return { ok: false, error: `读取结果失败：${err.message}` };
  }
  const payload = stored && stored[PAYLOAD_KEY];
  if (!payload) {
    return { ok: false, error: '暂无提取结果，请先在商品详情页点击「获取图片」' };
  }
  if (Date.now() - (payload.createdAt || 0) > PAYLOAD_TTL_MS) {
    await chrome.storage.session.remove(PAYLOAD_KEY);
    return { ok: false, error: '提取结果已过期，请回到商品页重新提取' };
  }
  // gallery 取到数据后清掉角标
  await setBadge(0);
  return { ok: true, payload };
}

/**
 * 执行单张图片下载。
 * gallery 会把转好格式的 blob URL（或回退时的原图 URL）传进来。
 */
async function handleDownload(message) {
  const url = typeof message.url === 'string' ? message.url : '';
  if (!url) return { ok: false, error: '缺少下载地址' };
  // 只允许扩展自身创建的 blob URL 或 http(s) 地址，避免被页面滥用于下载任意内容
  if (!/^(blob:chrome-extension:\/\/|https?:\/\/)/i.test(url)) {
    return { ok: false, error: '不支持的下载地址' };
  }

  const filename = sanitizeFilename(message.filename);
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (err) {
    return { ok: false, error: `下载失败：${(err && err.message) || err}` };
  }

  activeDownloads.set(downloadId, { filename, createdAt: Date.now() });
  // 清理长时间未收到状态变化的记录，避免 Map 膨胀
  setTimeout(() => activeDownloads.delete(downloadId), 5 * 60 * 1000);
  return { ok: true, downloadId, filename };
}

/** 修正文件名：去掉路径分隔符与非法字符，保证以 .png 结尾（回退时保留原扩展名） */
function sanitizeFilename(name) {
  let base = String(name || '商品图.png').trim();
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '');
  if (!base) base = '商品图.png';
  if (!/\.(png|jpe?g|webp|gif)$/i.test(base)) base += '.png';
  if (base.length > 120) {
    const ext = (base.match(/\.(png|jpe?g|webp|gif)$/i) || ['.png'])[0];
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** 记录 gallery 标签页 id，便于重复提取时复用并刷新数据 */
let galleryTabId = null;

/** 打开（或复用）gallery 标签页 */
async function openGallery() {
  const url = chrome.runtime.getURL('gallery.html');

  if (galleryTabId != null) {
    try {
      const tab = await chrome.tabs.get(galleryTabId);
      if (tab) {
        await chrome.tabs.update(galleryTabId, { active: true });
        if (tab.windowId != null) {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch (_) {
            /* 窗口 API 不可用时忽略 */
          }
        }
        // 让已打开的 gallery 重新拉取最新结果
        broadcast({ type: 'IMGX_PAYLOAD_UPDATED' });
        return;
      }
    } catch (_) {
      galleryTabId = null;
    }
  }

  const tab = await chrome.tabs.create({ url });
  galleryTabId = tab.id;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === galleryTabId) galleryTabId = null;
});

// ---------------------------------------------------------------- 下载进度广播

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state && delta.state.current;
  const error = delta.error && delta.error.current;
  if (!state && !error) return;

  const meta = activeDownloads.get(delta.id);
  const finalState = state || (error ? 'interrupted' : 'in_progress');

  broadcast({
    type: 'IMGX_DL_PROGRESS',
    downloadId: delta.id,
    state: finalState,
    error: error || null,
    filename: meta ? meta.filename : '',
  });

  if (finalState === 'complete' || finalState === 'interrupted') {
    activeDownloads.delete(delta.id);
  }
});

/** 向扩展页面广播消息；没有监听者时忽略异常 */
function broadcast(message) {
  try {
    const p = chrome.runtime.sendMessage(message);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    /* 忽略：gallery 可能已关闭 */
  }
}

// ---------------------------------------------------------------- 角标

async function setBadge(count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#4f7cff' });
    await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' });
  } catch (_) {
    /* 浏览器不支持角标时忽略 */
  }
}

// ---------------------------------------------------------------- 工具栏兜底入口

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const triggered = await triggerExtract(tab.id);
  if (!triggered) {
    // 非支持页面或内容脚本未注入：打开 gallery（无数据时会展示操作指引）
    await openGallery();
  }
});

/**
 * 触发指定标签页的提取：
 * 先尝试给已注入的内容脚本发消息；失败则用 chrome.scripting 补注入一次。
 */
async function triggerExtract(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'IMGX_TRIGGER_EXTRACT' });
    return true;
  } catch (_) {
    /* 内容脚本可能尚未注入，继续尝试动态注入 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['extract.js', 'content.js'],
    });
    await chrome.tabs.sendMessage(tabId, { type: 'IMGX_TRIGGER_EXTRACT' });
    return true;
  } catch (err) {
    console.warn('[ImgX] 无法在当前页面触发提取：', (err && err.message) || err);
    return false;
  }
}

// ---------------------------------------------------------------- 生命周期

chrome.runtime.onInstalled.addListener(() => {
  setBadge(0);
  console.info('[ImgX] 扩展已安装 / 更新');
});

chrome.runtime.onStartup.addListener(() => {
  setBadge(0);
});
