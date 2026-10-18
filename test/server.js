/**
 * 端到端测试用本地服务器
 *
 * 通过 Chrome 的 --host-resolver-rules 把 item.taobao.com / img.alicdn.com 解析到本机，
 * 从而在真实域名、真实 match pattern 与 host_permissions 下测试扩展。
 *
 * 路由：
 *   /item.htm   商品详情页 fixture（详情页 URL 白名单命中）
 *   /list.htm   商品列表页（非详情页，用于验证按钮不注入）
 *   /test/**、/icons/**  静态资源
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function startServer(options = {}) {
  const port = options.port == null ? 0 : options.port;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, server).catch((err) => {
      console.error('[server] 请求处理失败：', err);
      sendText(res, 500, `Internal Error: ${err.message}`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
}

async function handleRequest(req, res, server) {
  const address = server.address();
  const port = address ? address.port : 0;
  const url = new URL(req.url || '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  if (pathname === '/health') {
    sendJson(res, { ok: true, port });
    return;
  }

  if (pathname === '/item.htm') {
    const html = await renderHtml('fixture.html', port);
    sendHtml(res, html);
    return;
  }

  if (pathname === '/' || pathname === '/list.htm') {
    const html = await renderHtml('list.html', port);
    sendHtml(res, html);
    return;
  }

  // 仅暴露测试图片与图标，避免把整个项目目录暴露出去
  if (pathname.startsWith('/img/') || pathname.startsWith('/test/img/') || pathname.startsWith('/icons/')) {
    const baseDir = pathname.startsWith('/img/') ? path.join(__dirname, 'img') : null;
    const relative = pathname.startsWith('/img/')
      ? pathname.slice('/img/'.length)
      : pathname.slice(1);
    const filePath = baseDir ? path.resolve(baseDir, relative) : path.resolve(ROOT, relative);
    const allowedRoot = baseDir ? baseDir : ROOT;
    if (!filePath.startsWith(allowedRoot + path.sep)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    let buf;
    try {
      buf = await fs.readFile(filePath);
    } catch (_) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return;
  }

  sendText(res, 404, 'Not Found');
}

async function renderHtml(file, port) {
  const raw = await fs.readFile(path.join(__dirname, file), 'utf8');
  return raw.replaceAll('__PORT__', String(port));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(html);
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(text);
}

// 直接运行：npm run serve（默认 8123 端口）
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const desiredPort = Number(process.env.PORT) || 8123;
  const { server, port } = await startServer({ port: desiredPort });
  console.log(`[server] http://127.0.0.1:${port}`);
  console.log(`[server] 详情页 fixture: http://item.taobao.com:${port}/item.htm?id=100012`);
  console.log(`[server] 非详情页:      http://item.taobao.com:${port}/list.htm`);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}
