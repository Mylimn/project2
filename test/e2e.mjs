/**
 * Chrome + CDP 端到端测试
 *
 * 测试链路：
 *   本地服务器（item.taobao.com / img.alicdn.com 解析到 127.0.0.1）
 *   -> Chrome 加载未打包扩展
 *   -> 打开详情页 fixture，验证悬浮按钮只在详情页出现
 *   -> 点击按钮，验证 gallery 标签页自动打开、图片数量与过滤结果
 *   -> 全选并下载，验证生成 商品图_001.png ~ 商品图_008.png 且为标准 PNG
 *
 * 运行：node test/e2e.mjs
 * 可选环境变量：
 *   CHROME_PATH   Chrome 可执行文件路径
 *   E2E_HEADLESS  设为 0 可强制有头模式
 */
import { spawn, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 环境变量优先；否则自动探测 Chrome for Testing / Edge / Chrome */
const BROWSER_PATH = process.env.CHROME_PATH || '';
const FORCE_HEADLESS = process.env.E2E_HEADLESS !== '0';

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const checks = [];
const consoleLogs = [];
let chromeProc = null;
let serverInfo = null;
let tempDir = null;
let downloadsDir = null;

// ---------------------------------------------------------------- 工具

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function check(name, pass, detail = '') {
  checks.push({ name, pass: !!pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  return !!pass;
}

async function waitFor(desc, fn, timeout = 15000, interval = 200) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  const suffix = lastError ? `（最后错误：${lastError.message}）` : '';
  throw new Error(`等待超时：${desc}${suffix}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  static async open(wsUrl) {
    const conn = new CdpConnection(wsUrl);
    await conn.connect();
    return conn;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        this.dispatch(msg);
      };
    });
  }

  dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method && this.handlers.has(msg.method)) {
      for (const fn of this.handlers.get(msg.method)) {
        try {
          fn(msg.params);
        } catch (err) {
          console.warn('[e2e] CDP 事件处理异常：', err.message);
        }
      }
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function evaluate(conn, expression) {
  const result = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const desc =
      (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
      result.exceptionDetails.text ||
      '未知异常';
    throw new Error(`页面脚本异常：${desc}`);
  }
  return result.result ? result.result.value : undefined;
}

async function openPage(debugPort, url) {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  if (!res.ok) throw new Error(`创建标签页失败：HTTP ${res.status}`);
  const target = await res.json();
  const conn = await CdpConnection.open(target.webSocketDebuggerUrl);
  await conn.send('Runtime.enable');
  await conn.send('Page.enable');
  conn.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || [])
      .map((arg) => (arg.value !== undefined ? arg.value : arg.description || ''))
      .join(' ');
    consoleLogs.push(`[${params.type}] ${text}`);
  });
  conn.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    consoleLogs.push(
      `[exception] ${(details.exception && details.exception.description) || details.text || ''}`
    );
  });
  return { target, conn };
}

async function waitForPageReady(conn) {
  await waitFor('页面加载完成', async () => (await evaluate(conn, 'document.readyState')) === 'complete', 25000);
}

async function listTargets(debugPort) {
  const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!res.ok) throw new Error(`读取目标列表失败：HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- Chrome 启动

async function resolveBrowser() {
  if (BROWSER_PATH) {
    return { bin: BROWSER_PATH, label: '自定义浏览器（CHROME_PATH）' };
  }

  // 优先使用 Chrome for Testing（品牌版 Chrome 137+ 已移除 --load-extension）
  const cftRoot = path.join(__dirname, '.browsers');
  try {
    const entries = await fsp.readdir(cftRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'chrome.exe') {
        const bin = path.join(entry.parentPath || entry.path, entry.name);
        return { bin, label: 'Chrome for Testing' };
      }
    }
  } catch (_) {
    /* 没有下载 CfT 时忽略 */
  }

  for (const bin of BROWSER_CANDIDATES) {
    if (!(await fileExists(bin))) continue;
    if (/Google\\Chrome\\Application\\chrome\.exe$/i.test(bin)) {
      console.warn(
        '[e2e] 品牌版 Chrome 137+ 已移除 --load-extension，改用手边的 Chromium 内核浏览器；' +
          '如需测试真实 Chrome，请安装 Chrome for Testing 并设置 CHROME_PATH。'
      );
      continue;
    }
    return { bin, label: /msedge\.exe$/i.test(bin) ? 'Microsoft Edge (Chromium)' : bin };
  }

  throw new Error(
    '未找到可用于加载扩展的浏览器。请安装 Chrome for Testing 或 Edge，并用 CHROME_PATH 指定路径。'
  );
}

async function launchChrome({ headless, debugPort, userDataDir, browser }) {
  if (!(await fileExists(browser.bin))) {
    throw new Error(`未找到浏览器：${browser.bin}`);
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
    '--host-resolver-rules=MAP item.taobao.com 127.0.0.1, MAP img.alicdn.com 127.0.0.1',
    '--ignore-certificate-errors',
    '--window-size=1400,1400',
    '--remote-allow-origins=*',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const proc = spawn(browser.bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stderr = [];
  proc.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) consoleLogs.push(`[chrome] 退出码 ${code}`);
  });

  await waitFor(
    'Chrome DevTools 端口',
    async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      return res.ok;
    },
    25000,
    300
  );
  return { proc, stderr: () => stderr.join('') };
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

function killChrome(proc) {
  if (!proc || proc.killed) return;
  try {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } catch (_) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 测试主流程

async function runScenario({ headless, browserInfo }) {
  checks.length = 0;
  consoleLogs.length = 0;

  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgx-e2e-'));
  downloadsDir = path.join(tempDir, 'downloads');
  const userDataDir = path.join(tempDir, 'profile');
  await fsp.mkdir(downloadsDir, { recursive: true });
  await fsp.mkdir(userDataDir, { recursive: true });

  serverInfo = await startServer({ port: 0 });
  const sitePort = serverInfo.port;
  const itemUrl = `http://item.taobao.com:${sitePort}/item.htm?id=100012`;
  const listUrl = `http://item.taobao.com:${sitePort}/list.htm`;

  console.log(
    `\n启动 ${browserInfo.label}（${headless ? 'headless' : 'headful'}），测试站点端口 ${sitePort}，下载目录 ${downloadsDir}`
  );

  // 用 profile 偏好指定下载目录：CDP Browser.setDownloadBehavior 会让扩展传入的
  // filename 失效（下载按 URL 命名），无法验证「商品图_001.png」这类命名规则。
  await fsp.mkdir(path.join(userDataDir, 'Default'), { recursive: true });
  await fsp.writeFile(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: {
        default_directory: downloadsDir,
        prompt_for_download: false,
        directory_upgrade: true,
      },
    })
  );

  const debugPort = await getFreePort();
  const launched = await launchChrome({ headless, debugPort, userDataDir, browser: browserInfo });
  chromeProc = launched.proc;

  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  if (!version.webSocketDebuggerUrl) throw new Error('Chrome 未提供 DevTools 地址');
  // ---------- 1. 详情页注入悬浮按钮 ----------
  const { conn: pageConn } = await openPage(debugPort, itemUrl);
  await waitForPageReady(pageConn);

  const fab = await waitFor(
    '详情页注入悬浮按钮',
    async () =>
      evaluate(
        pageConn,
        `(() => {
          const host = document.getElementById('imgx-root');
          if (!host || !host.shadowRoot) return null;
          const btn = host.shadowRoot.getElementById('imgx-fab');
          if (!btn) return null;
          return { text: btn.textContent.trim(), disabled: btn.disabled };
        })()`
      ),
    15000,
    250
  );

  check('详情页出现悬浮按钮', !!fab, fab ? `文案「${fab.text}」` : '未找到 #imgx-fab');
  check('按钮文案为「获取图片」', /获取图片/.test(fab.text), fab.text);

  const geometry = await evaluate(
    pageConn,
    `(() => {
      const host = document.getElementById('imgx-root');
      const btn = host.shadowRoot.getElementById('imgx-fab');
      const r = btn.getBoundingClientRect();
      const hostStyle = getComputedStyle(host);
      return {
        rightGap: Math.round(innerWidth - r.right),
        bottomGap: Math.round(innerHeight - r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
        position: hostStyle.position,
        visibility: hostStyle.visibility,
        radius: getComputedStyle(btn).borderRadius,
        shadow: getComputedStyle(btn).boxShadow,
      };
    })()`
  );
  check(
    '按钮固定在右下角',
    geometry.position === 'fixed' && geometry.rightGap <= 40 && geometry.bottomGap <= 130,
    `rightGap=${geometry.rightGap}, bottomGap=${geometry.bottomGap}`
  );
  check(
    '按钮具备圆角与阴影',
    parseFloat(geometry.radius) >= 16 && geometry.shadow !== 'none',
    `radius=${geometry.radius}`
  );
  check('按钮可见', geometry.visibility === 'visible');

  // ---------- 2. 非详情页不注入 ----------
  const { conn: listConn } = await openPage(debugPort, listUrl);
  await waitForPageReady(listConn);
  await sleep(1200);
  const listHasButton = await evaluate(listConn, `!!document.getElementById('imgx-root')`);
  check('非商品详情页不出现按钮', !listHasButton);

  // ---------- 3. 点击按钮 -> 打开 gallery ----------
  await evaluate(
    pageConn,
    `(() => {
      const host = document.getElementById('imgx-root');
      host.shadowRoot.getElementById('imgx-fab').click();
      return true;
    })()`
  );

  const galleryTarget = await waitFor(
    'gallery 标签页打开',
    async () => {
      const targets = await listTargets(debugPort);
      return targets.find(
        (t) =>
          t.type === 'page' &&
          typeof t.url === 'string' &&
          t.url.startsWith('chrome-extension://') &&
          t.url.includes('gallery.html')
      );
    },
    30000,
    300
  );
  check('点击后自动打开 gallery 页面', !!galleryTarget, galleryTarget.url);

  const galleryConn = await CdpConnection.open(galleryTarget.webSocketDebuggerUrl);
  await galleryConn.send('Runtime.enable');
  await galleryConn.send('Page.enable');
  galleryConn.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || [])
      .map((arg) => (arg.value !== undefined ? arg.value : arg.description || ''))
      .join(' ');
    consoleLogs.push(`[gallery:${params.type}] ${text}`);
  });
  galleryConn.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails || {};
    consoleLogs.push(
      `[gallery:exception] ${(details.exception && details.exception.description) || details.text || ''}`
    );
  });
  await waitForPageReady(galleryConn);

  // 等待缩略图加载并完成尺寸测量
  try {
    await waitFor(
      'gallery 渲染并测量图片尺寸',
      async () => {
        const state = await evaluate(
          galleryConn,
          `(() => {
            const cards = [...document.querySelectorAll('.card')];
            if (cards.length < 9) return null;
            const pending = cards.some((c) => /测量中/.test(c.querySelector('.dims').textContent));
            return pending ? null : true;
          })()`
        );
        return state;
      },
      20000,
      300
    );
  } catch (err) {
    const debug = await evaluate(
      galleryConn,
      `JSON.stringify({
        url: location.href,
        ready: document.readyState,
        cards: document.querySelectorAll('.card').length,
        emptyHidden: document.getElementById('empty') ? document.getElementById('empty').hidden : null,
        emptyHint: document.getElementById('empty-hint') ? document.getElementById('empty-hint').textContent.trim() : null,
        meta: document.getElementById('page-meta') ? document.getElementById('page-meta').textContent : null,
        dims: [...document.querySelectorAll('.dims')].map((d) => d.textContent)
      })`
    ).catch((e) => `诊断失败：${e.message}`);
    console.error('[e2e] gallery 诊断：', debug);
    console.error('[e2e] gallery 控制台：\n' + consoleLogs.slice(-20).join('\n'));
    throw err;
  }

  const galleryState = await evaluate(
    galleryConn,
    `(() => {
      const cards = [...document.querySelectorAll('.card')];
      return {
        total: cards.length,
        visible: cards.filter((c) => !c.classList.contains('filtered')).length,
        broken: cards.filter((c) => c.classList.contains('broken')).length,
        loaded: cards.filter((c) => {
          const img = c.querySelector('img');
          return img && img.naturalWidth > 0;
        }).length,
        urls: cards.map((c) => c.dataset.url),
        dims: cards.map((c) => c.querySelector('.dims').textContent.trim()),
        selected: document.getElementById('selected-count').textContent,
        totalText: document.getElementById('total-count').textContent,
        meta: document.getElementById('page-meta').textContent,
        badge: document.getElementById('platform-badge').textContent,
        emptyHidden: document.getElementById('empty').hidden,
        downloadDisabled: document.getElementById('download').disabled,
      };
    })()`
  );

  check('gallery 展示 9 张图片', galleryState.total === 9, `total=${galleryState.total}`);
  check('过滤后仍显示 9 张（100px 以上）', galleryState.visible === 9, `visible=${galleryState.visible}`);
  check('1 张坏图标记为加载失败', galleryState.broken === 1, `broken=${galleryState.broken}`);
  check('8 张缩略图成功加载', galleryState.loaded === 8, `loaded=${galleryState.loaded}`);
  check('页面来源信息正确', /测试商品/.test(galleryState.meta) && /淘宝/.test(galleryState.badge), galleryState.meta);
  check('初始未选中任何图片', /已选 0 张/.test(galleryState.selected), galleryState.selected);
  check('未选中时下载按钮禁用', galleryState.downloadDisabled === true);

  const urlJoined = galleryState.urls.join('\n');
  check(
    '未采集 logo / 1x1 / 80px 小图 / icon 命名图 / sprite 图',
    !/logo-icon|pixel\.png|small-banner|product-icon|sprite-sheet/.test(urlJoined)
  );
  check('淘宝缩略图后缀已清洗并去重', !/_400x400/.test(urlJoined) && galleryState.urls.filter((u) => u.endsWith('/img/product-1.jpg')).length === 1);
  check(
    '跨域懒加载图片已纳入',
    galleryState.urls.some((u) => u.startsWith('http://img.alicdn.com:') && u.endsWith('/img/product-2.jpg'))
  );

  // ---------- 4. 全选并下载 ----------
  await evaluate(
    galleryConn,
    `(() => {
      document.getElementById('select-all').click();
      return document.getElementById('selected-count').textContent;
    })()`
  ).then((text) => check('全选后选中 8 张可下载图片', /已选 8 张/.test(text), text));

  await evaluate(
    galleryConn,
    `(() => {
      document.getElementById('download').click();
      return true;
    })()`
  );

  const progress = await waitFor(
    '下载流程结束',
    async () => {
      const state = await evaluate(
        galleryConn,
        `(() => {
          const panel = document.getElementById('progress');
          return {
            phase: panel.dataset.phase || '',
            hidden: panel.hidden,
            text: document.getElementById('progress-text').textContent,
            title: document.getElementById('progress-title').textContent,
            items: [...document.querySelectorAll('.progress-item')].map((li) => li.dataset.status),
          };
        })()`
      );
      return state.phase === 'done' || state.phase === 'error' ? state : null;
    },
    150000,
    500
  );

  check('下载进度面板展示最终结果', progress.phase === 'done', `${progress.title} / ${progress.text}`);
  check('8 张图片全部下载成功', /成功 8 \/ 8/.test(progress.text), progress.text);
  check(
    '进度列表全部为 done',
    progress.items.length === 8 && progress.items.every((s) => s === 'done'),
    `items=${progress.items.join(',')}`
  );

  // ---------- 5. 校验下载文件 ----------
  const files = await waitFor(
    '生成 PNG 文件',
    async () => {
      const names = (await fsp.readdir(downloadsDir)).filter(
        (name) => name.startsWith('商品图_') && name.endsWith('.png')
      );
      return names.length >= 8 ? names.sort() : null;
    },
    25000,
    300
  );

  check('生成 8 个 PNG 文件', files.length === 8, files.join(', '));
  check(
    '文件名按 001 起始补零',
    files[0] === '商品图_001.png' && files[7] === '商品图_008.png',
    `${files[0]} … ${files[files.length - 1]}`
  );

  const dims = [];
  let pngOk = 0;
  for (const name of files) {
    const buf = await fsp.readFile(path.join(downloadsDir, name));
    const signature = buf.subarray(0, 8).toString('hex');
    const isPng = signature === '89504e470d0a1a0a';
    if (isPng) pngOk += 1;
    // IHDR: 8 字节签名 + 4 字节长度 + 4 字节类型 + 4 字节宽 + 4 字节高
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    dims.push(`${width}x${height}`);
    check(
      `${name} 是合法 PNG（${width}×${height}）`,
      isPng && width > 0 && height > 0,
      isPng ? 'PNG 魔数正确' : `文件头=${signature}`
    );
  }
  check('全部文件为 PNG 格式（jpg/webp 已转换）', pngOk === files.length, `png=${pngOk}/${files.length}`);

  const expectedDims = [
    '1200x1200',
    '480x480',
    '480x480',
    '520x520',
    '640x360',
    '640x480',
    '800x600',
    '900x900',
  ].sort();
  const actualDims = dims.slice().sort();
  check(
    'PNG 尺寸与原图一致',
    JSON.stringify(expectedDims) === JSON.stringify(actualDims),
    `expected=${expectedDims.join(',')} actual=${actualDims.join(',')}`
  );

  const failedChecks = checks.filter((c) => !c.pass);
  if (failedChecks.length) {
    console.log('\n页面控制台日志（最近 40 条）：');
    console.log(consoleLogs.slice(-40).join('\n') || '(无)');
    console.log('\nChrome stderr（最近 20 行）：');
    console.log(launched.stderr().split('\n').slice(-20).join('\n'));
  }

  return failedChecks.length === 0;
}

// ---------------------------------------------------------------- 清理与入口

async function cleanup({ keepTemp = false } = {}) {
  if (chromeProc) killChrome(chromeProc);
  chromeProc = null;
  if (serverInfo) {
    await new Promise((resolve) => serverInfo.server.close(resolve));
    serverInfo = null;
  }
  if (tempDir && !keepTemp) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  if (keepTemp && tempDir) console.log(`临时目录保留：${tempDir}`);
  tempDir = null;
}

async function main() {
  let ok = false;
  let attemptHeadless = FORCE_HEADLESS;
  const browserInfo = await resolveBrowser();
  console.log(`测试浏览器：${browserInfo.label}\n  ${browserInfo.bin}`);

  try {
    ok = await runScenario({ headless: attemptHeadless, browserInfo });
  } catch (err) {
    console.error(`\n[${attemptHeadless ? 'headless' : 'headful'}] 测试失败：`, err.message);

    // 无头模式加载扩展失败时，自动回退有头模式重试一次
    if (attemptHeadless) {
      console.log('\n准备以有头模式重试（浏览器窗口会短暂出现）…');
      await cleanup();
      attemptHeadless = false;
      try {
        ok = await runScenario({ headless: false, browserInfo });
      } catch (err2) {
        console.error('\n[headful] 测试失败：', err2.message);
        ok = false;
      }
    }
  } finally {
    const failed = checks.filter((c) => !c.pass);
    await cleanup({ keepTemp: !ok && failed.length > 0 });
  }

  const passed = checks.filter((c) => c.pass).length;
  console.log(`\n===== E2E 结果：${passed} / ${checks.length} 项通过 =====`);
  if (!ok) process.exitCode = 1;
}

await main();
