/**
 * 图片候选采集核心逻辑（纯函数，无扩展 API 依赖）
 *
 * 该文件同时被两种环境加载：
 * 1. 内容脚本：manifest 中排在 content.js 之前，暴露全局 `ImgXExtract`；
 * 2. Node 单元测试：通过 CommonJS `require()` 使用同一份实现。
 *
 * 主要职责：
 * - 从 <img> / srcset / 懒加载属性 / 背景图 / video poster 中收集候选 URL
 * - 补齐相对路径、清洗阿里 / 京东 / 拼多多 CDN 的缩略图后缀
 * - 过滤图标、logo、占位图、1x1 像素图和小尺寸图片
 * - 去重并按面积倒序输出
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.ImgXExtract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 最小尺寸：宽高都小于该值即视为图标 / 缩略装饰图 */
  const MIN_SIZE = 100;
  /** 单次最多返回的图片数量，防止页面极端情况卡死 */
  const MAX_ITEMS = 500;
  /** 扫描背景图时最多检查的元素数量 */
  const MAX_BG_ELEMENTS = 6000;

  /** 各平台懒加载属性名（淘宝 / 京东 / 拼多多及常见框架） */
  const LAZY_ATTRS = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-original-src',
    'data-actualsrc',
    'data-ks-lazyload',
    'data-lazyload',
    'data-lazy',
    'data-echo',
    'data-img',
    'data-image',
  ];

  /** 装饰性图片的文件名片段（按 - _ . @ ! 切分后精确匹配） */
  const DECORATIVE_SEGMENTS = new Set([
    'logo', 'logos', 'icon', 'icons', 'sprite', 'sprites',
    'placeholder', 'placehold', 'loading', 'lazyload', 'lazy',
    'blank', 'spacer', 'transparent', 'pixel', '1x1',
    'avatar', 'qrcode', 'qr', 'arrow', 'arrows', 'btn', 'button',
    'close', 'delete', 'edit', 'star', 'stars', 'rating', 'badge', 'tag',
  ]);

  /**
   * 平台识别规则：只有商品详情页才注入悬浮按钮。
   * 如需支持更多路由（例如各平台商家后台的新版详情页），在此追加一行正则即可。
   */
  const PLATFORM_RULES = [
    {
      platform: 'taobao',
      label: '淘宝 / 天猫',
      match(u) {
        // 淘宝商品详情：item.taobao.com/item.htm?id=xxx
        if (u.hostname === 'item.taobao.com' && /^\/item\.htm$/i.test(u.pathname)) return true;
        // 天猫商品详情：detail.tmall.com/item.htm?id=xxx
        if (/(^|\.)detail\.tmall\.com$/i.test(u.hostname) && /^\/item\.htm$/i.test(u.pathname)) return true;
        return false;
      },
    },
    {
      platform: 'jd',
      label: '京东',
      match(u) {
        // 京东商品详情：item.jd.com/100012043978.html（含京东国际 item.jd.hk）
        const hostOk = /^(item|npcitem)\.jd\.com$/i.test(u.hostname) || /^item\.jd\.hk$/i.test(u.hostname);
        return hostOk && /^\/\d+\.html$/i.test(u.pathname);
      },
    },
    {
      platform: 'pdd',
      label: '拼多多',
      match(u) {
        // 拼多多 H5 商品详情：mobile.yangkeduo.com/goods.html?goods_id=xxx
        if (/^(mobile\.)?(yangkeduo|pinduoduo)\.com$/i.test(u.hostname)) {
          return /^\/goods(?:2|_detail)?\.html$/i.test(u.pathname);
        }
        // 拼多多商家后台（mms）商品详情 / 编辑页
        if (/^mms\.pinduoduo\.com$/i.test(u.hostname)) {
          if (!/\/goods\//i.test(u.pathname)) return false;
          return /(detail|edit)/i.test(u.pathname) || /(goods_id|goodsId)=/i.test(u.search);
        }
        return false;
      },
    },
  ];

  /**
   * 判断当前 URL 是否属于受支持的商品详情页。
   * @param {string} urlString
   * @returns {{platform: string, label: string}|null}
   */
  function detectPlatform(urlString) {
    let u;
    try {
      u = new URL(urlString);
    } catch (_) {
      return null;
    }
    for (const rule of PLATFORM_RULES) {
      try {
        if (rule.match(u)) return { platform: rule.platform, label: rule.label };
      } catch (_) {
        /* 单条规则异常不影响其他规则 */
      }
    }
    return null;
  }

  /**
   * 把各种写法补全成绝对 URL，并挡掉不可用的协议。
   * @param {string} raw 原始地址（相对 / 协议相对 / 绝对）
   * @param {string} base 页面地址，用于补齐相对路径
   * @returns {string|null}
   */
  function normalizeUrl(raw, base) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!s) return null;
    // data: 多为占位图；blob: 为页面临时对象；javascript: 等一律忽略
    if (/^(data|blob|javascript|mailto|tel|chrome|chrome-extension|about):/i.test(s)) return null;
    if (s === '#') return null;
    if (s.startsWith('//')) s = 'https:' + s;

    let u;
    try {
      u = new URL(s, base || 'https://placeholder.invalid/');
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // 去掉 hash，避免同一张图因锚点不同被重复收集
    u.hash = '';
    return u.href;
  }

  /**
   * 清洗 CDN 缩略图后缀，尽量拿回原图（拿不到时会退回原地址）。
   * 处理规则：
   * - 阿里 CDN：xxx.jpg_400x400.jpg / xxx.jpg_.webp -> xxx.jpg
   * - 京东：xxx.jpg!q70.dpg.webp -> xxx.jpg
   * - 拼多多：xxx.jpg?imageView2/2/w/400 -> xxx.jpg
   */
  function upgradeImageUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return url;
    }
    const host = u.hostname.toLowerCase();
    const isAli = /(^|\.)(alicdn|taobaocdn|taobao|tmall)\.com$/.test(host);
    const isJd = /(^|\.)(360buyimg|jd)\.com$/.test(host);
    const isPdd = /(^|\.)(pddpic|yangkeduo|pinduoduo)\.com$/.test(host);

    if (isAli) {
      // 例：O1CN01xxx.jpg_400x400.jpg -> O1CN01xxx.jpg
      u.pathname = u.pathname.replace(/(\.(?:jpe?g|png|gif|webp))_\d+x\d+[^/]*$/i, '$1');
      // 例：O1CN01xxx.jpg_.webp -> O1CN01xxx.jpg
      u.pathname = u.pathname.replace(/(\.(?:jpe?g|png|gif))_\.webp$/i, '$1');
      // 例：O1CN01xxx.jpg.webp -> O1CN01xxx.jpg
      u.pathname = u.pathname.replace(/\.(jpe?g|png|gif)\.webp$/i, '.$1');
      u.search = '';
    } else if (isJd) {
      // 例：xxx.jpg!q70.dpg.webp -> xxx.jpg
      u.pathname = u.pathname.replace(/![^/]*$/i, '');
      u.pathname = u.pathname.replace(/\.(jpe?g|png|gif)\.webp$/i, '.$1');
      u.search = '';
    } else if (isPdd) {
      // 例：xxx.jpg?imageView2/2/w/400/q/70 -> xxx.jpg
      u.search = '';
      u.pathname = u.pathname.replace(/![^/]*$/i, '');
      u.pathname = u.pathname.replace(/(\.(?:jpe?g|png|gif|webp))_\d+x\d+[^/]*$/i, '$1');
    }
    return u.href;
  }

  /**
   * 解析 srcset，返回候选数组。
   * @param {string} value
   * @returns {{url: string, width: number, density: number}[]}
   */
  function parseSrcset(value) {
    if (!value || typeof value !== 'string') return [];
    const out = [];
    // srcset 以逗号分隔；data URI 内部也有逗号，因此先整段跳过 data URI
    for (const part of value.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const m = seg.match(/^(\S+)(?:\s+([\d.]+)(w|x))?$/i);
      if (!m) continue;
      if (/^data:/i.test(m[1])) continue;
      const n = m[2] ? parseFloat(m[2]) : 0;
      const unit = (m[3] || '').toLowerCase();
      out.push({
        url: m[1],
        width: unit === 'w' ? n : 0,
        density: unit === 'x' ? n : 0,
      });
    }
    return out;
  }

  /**
   * 从 srcset 中挑出分辨率最高的候选。
   * @param {string} value
   * @returns {string|null}
   */
  function pickBestFromSrcset(value) {
    const list = parseSrcset(value);
    if (!list.length) return null;
    const byWidth = list.filter((it) => it.width > 0);
    if (byWidth.length) {
      byWidth.sort((a, b) => b.width - a.width);
      return byWidth[0].url;
    }
    const byDensity = list.filter((it) => it.density > 0);
    if (byDensity.length) {
      byDensity.sort((a, b) => b.density - a.density);
      return byDensity[0].url;
    }
    return list[list.length - 1].url;
  }

  /** 读取尺寸属性，兼容 "800" / "800px" / 百分比等写法 */
  function readDim(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
    const m = String(value).trim().match(/^(\d+(?:\.\d+)?)$/);
    return m ? Math.round(parseFloat(m[1])) : 0;
  }

  /**
   * 读取 <img> 的原始尺寸：优先自然尺寸，其次 width/height 属性与渲染尺寸。
   *
   * 懒加载图片在真实地址加载前通常展示 1x1 data URI 占位图，此时 naturalWidth /
   * naturalHeight 为 1。若直接采用自然尺寸，这类图片会被「1x1 像素图」规则误删，
   * 因此占位尺寸下改用 width/height 属性（属性缺失则退回渲染尺寸）。
   */
  function readImageSize(img) {
    const nw = readDim(img.naturalWidth);
    const nh = readDim(img.naturalHeight);
    if (nw > 1 && nh > 1) return { w: nw, h: nh };

    const aw = readDim(img.getAttribute && img.getAttribute('width'));
    const ah = readDim(img.getAttribute && img.getAttribute('height'));
    if (aw > 1 || ah > 1) return { w: aw || nw, h: ah || nh };

    const rect = safeRect(img);
    return { w: rect.w || nw, h: rect.h || nh };
  }

  /** 判断是否是明显的装饰性图片 */
  function isDecorative(url, meta) {
    let path = '';
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch (_) {
      path = String(url).toLowerCase();
    }
    if (/\.svg$/.test(path)) return true;

    const base = path.split('/').pop() || '';
    // 文件名按分隔符切词，避免 "star" 误伤 "start-banner" 这类名字
    const segments = base.split(/[-_.@!+]+/).filter(Boolean);
    for (const seg of segments) {
      if (DECORATIVE_SEGMENTS.has(seg)) return true;
    }
    // 兼容 logo2.png / iconfont.png 之类的命名
    if (/^(logo|icon|sprite|placeholder|spacer|lazyload)/.test(base)) return true;

    const alt = (meta && meta.alt ? String(meta.alt) : '').toLowerCase().trim();
    if (alt && DECORATIVE_SEGMENTS.has(alt)) return true;

    const cls = meta && meta.className ? String(meta.className).toLowerCase() : '';
    if (cls) {
      for (const token of cls.split(/\s+/)) {
        if (!token) continue;
        if (DECORATIVE_SEGMENTS.has(token)) return true;
        // 常见写法：goods-logo / item-icon
        for (const seg of token.split(/[-_]+/)) {
          if (seg && DECORATIVE_SEGMENTS.has(seg)) return true;
        }
        // 字体图标类名：iconfont / iconify / logo-lg
        if (/^(icon|logo)/.test(token)) return true;
      }
    }
    return false;
  }

  /**
   * 采集页面上的图片候选。
   * @param {Document} doc
   * @param {Window} win
   * @param {{minSize?: number, maxItems?: number, baseUrl?: string}} [options]
   * @returns {{url: string, w: number, h: number, source: string, alt: string}[]}
   */
  function collectCandidates(doc, win, options) {
    const opts = options || {};
    const minSize = opts.minSize || MIN_SIZE;
    const maxItems = opts.maxItems || MAX_ITEMS;
    const baseUrl = opts.baseUrl || (win && win.location && win.location.href) || (doc && doc.baseURI) || '';
    /** @type {Map<string, {url: string, w: number, h: number, source: string, alt: string}>} */
    const found = new Map();

    /**
     * 尝试加入一张图片。
     * @param {string} rawUrl
     * @param {{w?: number, h?: number, source?: string, alt?: string, className?: string}} meta
     */
    function add(rawUrl, meta) {
      const m = meta || {};
      const abs = normalizeUrl(rawUrl, baseUrl);
      if (!abs) return;
      const url = upgradeImageUrl(abs);
      if (isDecorative(url, m)) return;

      const w = Math.max(0, Math.round(m.w || 0));
      const h = Math.max(0, Math.round(m.h || 0));

      // 1x1 像素图、单边 1px 的分割线
      if ((w === 1 && h === 1) || w === 1 || h === 1) return;
      // 宽高都已知且都小于阈值：图标 / 缩略装饰图
      if (w > 0 && h > 0 && w < minSize && h < minSize) return;
      // 极端长宽比：页面分割线、装饰条
      if (w > 0 && h > 0) {
        const ratio = Math.max(w, h) / Math.min(w, h);
        if (ratio > 20) return;
      }

      const exist = found.get(url);
      if (exist) {
        // 同一张图被多个来源命中时，保留更大的尺寸信息
        if (w * h > exist.w * exist.h) {
          exist.w = w || exist.w;
          exist.h = h || exist.h;
        }
        return;
      }
      found.set(url, {
        url,
        w,
        h,
        source: m.source || 'img',
        alt: String(m.alt || '').slice(0, 100),
      });
    }

    if (!doc || typeof doc.querySelectorAll !== 'function') return [];

    // ---------- 1. <img>：src / srcset / 懒加载属性 ----------
    const imgs = doc.querySelectorAll('img');
    for (const img of imgs) {
      if (img.closest && img.closest('svg')) continue;
      const { w, h } = readImageSize(img);
      const alt = img.getAttribute('alt') || '';
      const className = img.getAttribute('class') || '';

      // 懒加载属性通常保存原图地址，优先级高于当前展示的缩略图
      let lazyUrl = null;
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (v && v.trim()) {
          lazyUrl = v;
          break;
        }
      }
      if (lazyUrl) add(lazyUrl, { w, h, source: 'lazy', alt, className });

      // srcset 里挑最大候选
      const best = pickBestFromSrcset(img.getAttribute('srcset'));
      if (best) add(best, { w, h, source: 'srcset', alt, className });

      if (img.currentSrc) add(img.currentSrc, { w, h, source: 'img', alt, className });
      const src = img.getAttribute('src');
      if (src) add(src, { w, h, source: 'img', alt, className });

      // 兜底：<picture><source srcset> 在部分浏览器下 currentSrc 为空
      const picture = img.parentElement;
      if (picture && picture.tagName === 'PICTURE') {
        for (const source of picture.querySelectorAll('source[srcset]')) {
          const sBest = pickBestFromSrcset(source.getAttribute('srcset'));
          if (sBest) add(sBest, { w, h, source: 'srcset', alt, className });
        }
      }
    }

    // ---------- 2. 带懒加载属性的任意元素（div 背景图兜底 / 自定义组件） ----------
    const lazySelector = LAZY_ATTRS.map((attr) => `[${attr}]`).join(',');
    for (const el of doc.querySelectorAll(lazySelector)) {
      if (el.tagName === 'IMG') continue; // 已在上面处理
      for (const attr of LAZY_ATTRS) {
        const v = el.getAttribute(attr);
        if (!v || !v.trim()) continue;
        const rect = safeRect(el);
        add(v, {
          w: rect.w,
          h: rect.h,
          source: 'lazy',
          alt: el.getAttribute('alt') || el.getAttribute('title') || '',
          className: el.getAttribute('class') || '',
        });
      }
    }

    // ---------- 3. video poster ----------
    for (const video of doc.querySelectorAll('video[poster]')) {
      add(video.getAttribute('poster'), { source: 'poster', className: video.getAttribute('class') || '' });
    }

    // ---------- 4. background-image（内联样式 + 计算样式，支持多图层） ----------
    scanBackgroundImages(doc, win, add);

    const items = Array.from(found.values());
    // 面积倒序，未知尺寸的图排在后面（gallery 里再实测尺寸）
    items.sort((a, b) => b.w * b.h - a.w * a.h);
    return items.slice(0, maxItems);
  }

  /** 安全读取元素渲染尺寸（用于背景图元素，避免拿到 0 时误判） */
  function safeRect(el) {
    try {
      if (typeof el.getBoundingClientRect !== 'function') return { w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      return { w: r && r.width > 0 ? Math.round(r.width) : 0, h: r && r.height > 0 ? Math.round(r.height) : 0 };
    } catch (_) {
      return { w: 0, h: 0 };
    }
  }

  /** 从 background-image 值中拆出所有 url(...) */
  function extractBgUrls(value) {
    const urls = [];
    if (!value || typeof value !== 'string' || value.indexOf('url(') === -1) return urls;
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let m;
    while ((m = re.exec(value))) {
      if (m[2]) urls.push(m[2]);
    }
    return urls;
  }

  /** 扫描页面背景图，元素数量设上限避免超长页面阻塞 */
  function scanBackgroundImages(doc, win, add) {
    const all = doc.querySelectorAll('*');
    const limit = Math.min(all.length, MAX_BG_ELEMENTS);
    const getStyle = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle.bind(win) : null;

    for (let i = 0; i < limit; i++) {
      const el = all[i];
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'head') continue;
      // 页面整体背景（平铺纹理）不作为商品图
      if (el === doc.documentElement || el === doc.body) continue;
      if (el.closest && el.closest('svg')) continue;

      let value = '';
      const inline = el.getAttribute && el.getAttribute('style');
      if (inline && inline.indexOf('url(') !== -1) {
        value = inline;
      } else if (getStyle) {
        try {
          const cs = getStyle(el);
          if (cs && cs.backgroundImage && cs.backgroundImage !== 'none') value = cs.backgroundImage;
        } catch (_) {
          /* 某些节点（如已卸载的自定义元素）取样式会抛错，忽略 */
        }
      }
      if (!value) continue;

      const rect = safeRect(el);
      const alt = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
      const className = (el.getAttribute && el.getAttribute('class')) || '';
      for (const url of extractBgUrls(value)) {
        add(url, { w: rect.w, h: rect.h, source: 'background', alt, className });
      }
    }
  }

  return {
    MIN_SIZE,
    MAX_ITEMS,
    LAZY_ATTRS,
    detectPlatform,
    normalizeUrl,
    upgradeImageUrl,
    parseSrcset,
    pickBestFromSrcset,
    isDecorative,
    collectCandidates,
    extractBgUrls,
  };
});
