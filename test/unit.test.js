/**
 * extract.js 单元测试（Node + jsdom）
 *
 * 覆盖：
 * - 平台详情页识别
 * - 相对路径补全、协议相对、非法协议过滤
 * - 淘宝 / 京东 / 拼多多 CDN 缩略图后缀清洗
 * - srcset 解析与最大候选选择
 * - 装饰图 / 小图 / 1x1 / 极端长宽比过滤
 * - fixture 页面的图片采集数量、来源与去重
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const X = require('../extract.js');

const PORT = 8123;
const BASE = `http://item.taobao.com:${PORT}/item.htm?id=100012`;

function fixtureDom() {
  const raw = fs
    .readFileSync(path.join(__dirname, 'fixture.html'), 'utf8')
    .replaceAll('__PORT__', String(PORT));
  return new JSDOM(raw, { url: BASE, pretendToBeVisual: true });
}

function htmlDom(html, url = BASE) {
  return new JSDOM(html, { url });
}

// ---------------------------------------------------------------- 平台识别

test('detectPlatform: 只识别商品详情页', () => {
  assert.equal(X.detectPlatform('https://item.taobao.com/item.htm?id=1').platform, 'taobao');
  assert.equal(X.detectPlatform('https://detail.tmall.com/item.htm?id=1').platform, 'taobao');
  assert.equal(X.detectPlatform('https://item.jd.com/100012043978.html').platform, 'jd');
  assert.equal(X.detectPlatform('https://item.jd.hk/100012043978.html').platform, 'jd');
  assert.equal(X.detectPlatform('https://mobile.yangkeduo.com/goods.html?goods_id=1').platform, 'pdd');
  assert.equal(X.detectPlatform('https://mobile.pinduoduo.com/goods.html?goods_id=1').platform, 'pdd');
  assert.equal(X.detectPlatform('https://mms.pinduoduo.com/goods/goods_detail?goods_id=1').platform, 'pdd');

  // 非详情页 / 非支持页面
  assert.equal(X.detectPlatform('https://item.taobao.com/search.htm?q=abc'), null);
  assert.equal(X.detectPlatform('https://www.taobao.com/'), null);
  assert.equal(X.detectPlatform('https://item.jd.com/100012043978.htm'), null);
  assert.equal(X.detectPlatform('https://mms.pinduoduo.com/goods/goods_list'), null);
  assert.equal(X.detectPlatform('not a url'), null);
});

// ---------------------------------------------------------------- URL 处理

test('normalizeUrl: 补全相对路径并过滤非法协议', () => {
  assert.equal(
    X.normalizeUrl('./img/a.jpg', 'https://item.taobao.com/item.htm?id=1'),
    'https://item.taobao.com/img/a.jpg'
  );
  assert.equal(
    X.normalizeUrl('//img.alicdn.com/a.jpg', 'https://item.taobao.com/item.htm'),
    'https://img.alicdn.com/a.jpg'
  );
  assert.equal(
    X.normalizeUrl('https://img.alicdn.com/a.jpg#frag', 'https://item.taobao.com/'),
    'https://img.alicdn.com/a.jpg'
  );
  assert.equal(X.normalizeUrl('data:image/gif;base64,R0lGODlhAQAB', BASE), null);
  assert.equal(X.normalizeUrl('javascript:void(0)', BASE), null);
  assert.equal(X.normalizeUrl('blob:https://item.taobao.com/abc', BASE), null);
  assert.equal(X.normalizeUrl('', BASE), null);
});

test('upgradeImageUrl: 清洗各平台缩略图后缀', () => {
  assert.equal(
    X.upgradeImageUrl('https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg_400x400.jpg'),
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg'
  );
  assert.equal(
    X.upgradeImageUrl('https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg_.webp'),
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg'
  );
  assert.equal(
    X.upgradeImageUrl('https://img14.360buyimg.com/n0/jfs/t1/abc.jpg!q70.dpg.webp'),
    'https://img14.360buyimg.com/n0/jfs/t1/abc.jpg'
  );
  assert.equal(
    X.upgradeImageUrl('https://img.pddpic.com/gaudit/2024/a.jpg?imageView2/2/w/400/q/70'),
    'https://img.pddpic.com/gaudit/2024/a.jpg'
  );
  // 未知域名保持原样
  assert.equal(
    X.upgradeImageUrl('https://example.com/a.jpg?x=1'),
    'https://example.com/a.jpg?x=1'
  );
});

test('parseSrcset / pickBestFromSrcset', () => {
  const list = X.parseSrcset('./a.jpg 200w, ./b.jpg 1200w, ./c.jpg 2x');
  assert.equal(list.length, 3);
  assert.equal(X.pickBestFromSrcset('./a.jpg 200w, ./b.jpg 1200w'), './b.jpg');
  assert.equal(X.pickBestFromSrcset('./a.jpg 1x, ./b.jpg 2x'), './b.jpg');
  assert.equal(
    X.pickBestFromSrcset('data:image/gif;base64,R0lGODlhAQAB 1x, ./b.jpg 2x'),
    './b.jpg'
  );
  assert.equal(X.pickBestFromSrcset(''), null);
});

test('isDecorative: 过滤 logo / icon / sprite 等命名', () => {
  assert.equal(X.isDecorative('https://img.alicdn.com/a/logo.png', {}), true);
  assert.equal(X.isDecorative('https://img.alicdn.com/a/product-icon.png', {}), true);
  assert.equal(X.isDecorative('https://img.alicdn.com/a/sprite-sheet.png', {}), true);
  assert.equal(X.isDecorative('https://img.alicdn.com/a/goods-1.jpg', {}), false);
  assert.equal(X.isDecorative('https://img.alicdn.com/a/start-banner.jpg', {}), false);
  assert.equal(X.isDecorative('https://img.alicdn.com/a/goods.jpg', { className: 'iconfont' }), true);
});

test('extractBgUrls: 支持多层背景图与引号', () => {
  assert.deepEqual(X.extractBgUrls(`url("./a.jpg"), url('/b.jpg')`), ['./a.jpg', '/b.jpg']);
  assert.deepEqual(X.extractBgUrls('none'), []);
  assert.deepEqual(X.extractBgUrls('linear-gradient(#fff, #000)'), []);
});

// ---------------------------------------------------------------- 采集逻辑

test('collectCandidates: fixture 页面共采集 9 张，来源正确且已去重', () => {
  const dom = fixtureDom();
  const items = X.collectCandidates(dom.window.document, dom.window, { baseUrl: BASE });
  const urls = items.map((it) => it.url);

  assert.equal(items.length, 9, `实际采集：\n${urls.join('\n')}`);

  const expectHost = `http://item.taobao.com:${PORT}/img/`;
  const expected = [
    'product-1.jpg',
    'product-2.jpg',
    'product-3.jpg',
    'product-4.jpg',
    'product-5.jpg',
    'product-6.jpg',
    'product-7.jpg',
    'product-8.jpg',
    'missing.jpg',
  ];
  for (const name of expected) {
    assert.ok(
      urls.some((u) => u.endsWith(`/img/${name}`)),
      `缺少 ${name}`
    );
  }

  // 淘宝缩略图后缀已清洗，且与主图去重（只保留一条 product-1）
  assert.equal(urls.filter((u) => u === `${expectHost}product-1.jpg`).length, 1);
  assert.ok(!urls.some((u) => u.includes('_400x400')));

  // 装饰图、小图、1x1、文件名带 icon / sprite 的都应被过滤
  for (const bad of ['logo-icon', 'pixel.png', 'small-banner', 'product-icon', 'sprite-sheet']) {
    assert.ok(!urls.some((u) => u.includes(bad)), `不应包含 ${bad}`);
  }

  // 跨域懒加载图片
  assert.ok(urls.includes(`http://img.alicdn.com:${PORT}/img/product-2.jpg`));

  // 来源标记
  const byName = (name) => items.find((it) => it.url.endsWith(`/img/${name}`));
  assert.equal(byName('product-2.jpg').source, 'lazy');
  assert.equal(byName('product-3.jpg').source, 'srcset');
  assert.equal(byName('product-4.jpg').source, 'background');
  assert.equal(byName('product-8.jpg').source, 'poster');
  assert.equal(byName('product-1.jpg').source, 'img');

  // 面积倒序：1200x1200 的 product-3 应排在首位
  assert.ok(items[0].url.endsWith('/img/product-3.jpg'));
});

test('collectCandidates: 尺寸未知的图片保留，交给 gallery 再测量', () => {
  const dom = htmlDom('<img src="https://img.alicdn.com/a/real-product.jpg">');
  const items = X.collectCandidates(dom.window.document, dom.window);
  assert.equal(items.length, 1);
  assert.equal(items[0].w, 0);
  assert.equal(items[0].h, 0);
});

test('collectCandidates: 懒加载占位图（自然尺寸 1x1）用 width/height 属性兜底', () => {
  const html = `
    <img
      id="lazy"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
      data-src="https://img.alicdn.com/a/real-product.jpg"
      width="640"
      height="480"
    >
    <img
      id="lazy-nosize"
      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
      data-src="https://img.alicdn.com/a/no-size.jpg"
    >
  `;
  const dom = htmlDom(html);
  // 模拟占位图已加载：自然尺寸为 1x1
  for (const id of ['lazy', 'lazy-nosize']) {
    const img = dom.window.document.getElementById(id);
    Object.defineProperty(img, 'naturalWidth', { value: 1 });
    Object.defineProperty(img, 'naturalHeight', { value: 1 });
  }
  const items = X.collectCandidates(dom.window.document, dom.window);
  const real = items.find((it) => it.url.endsWith('/real-product.jpg'));
  assert.ok(real, `应保留占位图背后的真实图片：${items.map((it) => it.url).join(', ')}`);
  assert.equal(real.w, 640);
  assert.equal(real.h, 480);
  // 没有任何尺寸线索的 1x1 占位图与真实 1x1 像素图无法区分，按像素图过滤
  assert.ok(!items.some((it) => it.url.endsWith('/no-size.jpg')));
});

test('collectCandidates: 过滤 1x1、小图、极端长宽比，保留单边达标图', () => {
  const html = `
    <img src="https://img.alicdn.com/x/pixel.jpg" width="1" height="1">
    <img src="https://img.alicdn.com/x/small.jpg" width="60" height="90">
    <img src="https://img.alicdn.com/x/line.jpg" width="1000" height="10">
    <img src="https://img.alicdn.com/x/tall.jpg" width="60" height="200">
    <img src="https://img.alicdn.com/x/normal.jpg" width="800" height="700">
  `;
  const dom = htmlDom(html);
  const urls = X.collectCandidates(dom.window.document, dom.window).map((it) => it.url);
  assert.equal(urls.length, 2, urls.join('\n'));
  assert.ok(urls.some((u) => u.endsWith('/tall.jpg')));
  assert.ok(urls.some((u) => u.endsWith('/normal.jpg')));
});

test('collectCandidates: 同图不同尺寸信息合并，保留较大尺寸', () => {
  const html = `
    <img src="https://img.alicdn.com/x/big.jpg" width="1000" height="1000">
    <img src="https://img.alicdn.com/x/small.jpg" width="200" height="200">
    <img src="https://img.alicdn.com/x/big.jpg" width="500" height="500">
  `;
  const dom = htmlDom(html);
  const items = X.collectCandidates(dom.window.document, dom.window);
  assert.equal(items.length, 2);
  const big = items.find((it) => it.url.endsWith('/big.jpg'));
  assert.equal(big.w, 1000);
  assert.equal(big.h, 1000);
  assert.equal(big.url, items[0].url);
});

test('collectCandidates: 背景图多图层都会被采集', () => {
  const html = `
    <div style="width:300px;height:300px;background-image:url('https://img.alicdn.com/a/bg-1.jpg'),url('https://img.alicdn.com/a/bg-2.jpg')"></div>
  `;
  const dom = htmlDom(html);
  const urls = X.collectCandidates(dom.window.document, dom.window).map((it) => it.url);
  assert.equal(urls.length, 2, urls.join('\n'));
});
