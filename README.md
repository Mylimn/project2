# 电商图片提取下载（Chrome 扩展 · Manifest V3）

在淘宝 / 天猫 / 京东 / 拼多多商家版的商品详情页右下角注入「获取图片」按钮，
一键提取页面内的商品图，在扩展页面中集中展示、筛选、勾选，并批量下载为 PNG。

## 功能

- **悬浮按钮**：仅在商品详情页出现，固定在右下角，圆角 + 阴影，hover 有反馈；
  注入在 Shadow DOM 中，样式与页面完全隔离，不遮挡页面原有操作。
- **图片提取**：扫描 `<img>`（`src` / `currentSrc` / `srcset`）、常见懒加载属性
  （`data-src`、`data-lazy-src`、`data-original`、`data-ks-lazyload` 等）、
  `<picture><source srcset>`、`video[poster]`、内联与计算样式中的 `background-image`（支持多图层）。
  提取前会自动分步滚动到底部触发懒加载，完成后回到原位置。
- **URL 清洗**：相对路径补全为绝对地址；淘宝 `_400x400.jpg` / `_.webp`、京东
  `!q70.dpg.webp`、拼多多 `?imageView2/...` 等缩略图后缀自动还原为原图；结果去重。
- **过滤规则**：过滤 logo / icon / sprite / placeholder / 二维码等命名或 class 的装饰图、
  1x1 像素图、单边 1px 分割线、极端长宽比，以及宽高都小于 100px 的小图。
- **预览页**：网格布局展示缩略图、尺寸与来源标签，支持全选 / 反选 / 取消选择、
  按最小尺寸（100 / 300 / 500 / 800px）筛选，加载失败的图片会标记并禁止勾选。
- **批量下载**：统一转换为 PNG（jpg / webp / gif 均可），文件名按 `商品图_001.png`
  三位补零；下载过程有逐张进度与最终结果反馈；跨域转换失败时自动回退为原图格式并提示。

## 支持页面

| 平台 | 注入范围 |
| --- | --- |
| 淘宝 / 天猫 | `item.taobao.com/item.htm`、`detail.tmall.com/item.htm` |
| 京东 | `item.jd.com/<数字>.html`、`item.jd.hk/<数字>.html`、`npcitem.jd.com/<数字>.html` |
| 拼多多（H5） | `mobile.yangkeduo.com/goods.html`、`mobile.pinduoduo.com/goods.html`、`/goods2.html`、`/goods_detail.html` |
| 拼多多商家版 | `mms.pinduoduo.com/goods/**` 的详情 / 编辑页 |

其他页面（首页、搜索页、列表页等）不会注入按钮；如需扩展，修改
[extract.js](extract.js) 中的 `PLATFORM_RULES` 即可。

## 安装

1. 打开 Chrome / Edge，访问 `chrome://extensions`（Edge 为 `edge://extensions`）。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本项目根目录（包含 `manifest.json` 的目录）。
4. 建议在工具栏的扩展菜单中把本扩展固定，方便查看角标数量。

> 品牌版 Chrome 137+ 已移除命令行的 `--load-extension` 参数，但**手动加载已解压扩展不受影响**。
> 自动化测试因此优先使用 Chrome for Testing 或 Microsoft Edge（见下文）。

## 使用

1. 打开支持的商品详情页，等页面加载完成。
2. 点击右下角「获取图片」，按钮会显示「提取中…」，同时自动滚动触发懒加载。
3. 提取完成后会自动打开预览页，工具栏角标显示本次提取的图片数量。
4. 在预览页勾选需要的图片（可先按最小尺寸筛选），点击「下载选中」。
5. 文件以 `商品图_001.png`、`商品图_002.png`……命名，保存到浏览器默认下载目录。

再次提取会复用已打开的预览页并刷新数据，不会堆积大量标签页。

## 文件结构

```
manifest.json          扩展清单（MV3）
extract.js             图片候选采集与 URL 清洗（纯函数，Node 可直接加载）
content.js             悬浮按钮、懒加载触发、消息发送
content.css            按钮与提示样式（注入 Shadow DOM）
background.js          Service Worker：消息路由、结果暂存、下载执行、进度广播
gallery.html/js/css    提取结果展示与批量下载页
icons/                 扩展图标（16 / 48 / 128）
tools/make-icons.ps1   图标生成脚本
tools/make-test-images.ps1  测试图片生成脚本
README.md              本文档
test/
  package.json         唯一开发依赖：jsdom
  unit.test.js         extract.js 单元测试
  fixture.html         模拟详情页（覆盖懒加载 / srcset / 背景图 / 坏图 / 装饰图）
  list.html            非详情页，用于验证按钮不注入
  server.js            本地静态服务器（E2E 用）
  e2e.mjs              Chrome / Edge + CDP 端到端测试
  img/                 测试图片
```

## 开发与测试

```powershell
cd test
npm install

# 单元测试（jsdom，12 个用例）
npm test

# 端到端测试（默认无头模式，33 项检查）
npm run test:e2e

# 强制有头模式（浏览器窗口会短暂出现）
$env:E2E_HEADLESS = "0"; npm run test:e2e

# 指定浏览器
$env:CHROME_PATH = "C:\path\to\chrome.exe"; npm run test:e2e
```

端到端测试做了什么：

- 本地服务器把 `item.taobao.com`、`img.alicdn.com` 通过 `--host-resolver-rules`
  解析到 127.0.0.1，保证在真实域名、真实 `matches` / `host_permissions` 下测试；
- 加载未打包扩展，验证悬浮按钮只在详情页出现、位置与样式正确；
- 点击按钮后验证预览页自动打开、9 张候选图（含跨域懒加载图）、过滤与去重结果；
- 全选后执行下载，校验 8 个 `商品图_00X.png`、PNG 魔数与像素尺寸与原图一致。

下载目录通过临时 profile 的 `Preferences`（`download.default_directory`）指定。
**注意**：CDP 的 `Browser.setDownloadBehavior` 会让扩展传入的文件名失效（下载按 URL 命名），
因此测试没有使用它。

浏览器选择顺序：`CHROME_PATH` → `test/.browsers` 下的 Chrome for Testing →
Edge（Chromium）→ 品牌版 Chrome（会跳过并提示，因为命令行无法加载扩展）。
无头模式失败时会自动以有头模式重试一次。

### 手工验收清单

- [ ] 详情页右下角出现「获取图片」，hover 有反馈，页面原有按钮可正常点击；
- [ ] 搜索页 / 首页不出现按钮；
- [ ] 点击后预览页自动打开，数量与页面内商品图数量一致，logo / 图标 / 1x1 未被采集；
- [ ] 勾选若干图片下载，得到 `商品图_001.png` 起的 PNG 文件，尺寸与原图一致；
- [ ] 关闭预览页后再次提取，仍能正常打开并刷新数据；
- [ ] 工具栏图标点击可作为兜底入口。

## 已知限制

- PNG 转换依赖 `host_permissions` 中的平台域名与 CDN 域名；不在其中的图片可能因跨域
  无法转换，此时会回退为原图格式下载并在进度面板中标注。
- GIF 动图转换为 PNG 时只保留首帧。
- 懒加载触发最多滚动 3 秒；超长页面若仍有未加载图片，可先手动滚动再点击按钮。
- 提取结果存放在 `chrome.storage.session`，浏览器重启或超过 30 分钟后失效。
- 不注入 iframe（`all_frames: false`），仅处理顶层页面中的图片。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 工具栏图标点击时对当前标签页触发提取 |
| `scripting` | 内容脚本未注入时动态补注入 `extract.js` / `content.js` |
| `downloads` | 调用 `chrome.downloads.download` 保存 PNG 并跟踪进度 |
| `storage` | 用 `chrome.storage.session` 在提取页与预览页之间传递结果 |
| `host_permissions` | 三平台页面注入，以及采集 / 转换三个平台的图片 CDN |

## 版本管理

项目使用 Git 做本地版本管理（不推远端），按里程碑提交：

```
chore: 初始化扩展项目与仓库配置
feat: 实现图片提取逻辑与内容脚本
feat: 实现后台消息路由与下载服务
feat: 实现 gallery 展示与批量 PNG 下载
test: 补充单测与 Chrome 端到端测试
docs: 完善安装与使用说明
```

测试产物（`test/node_modules/`、`test/tmp/`、`test/downloads/`、`test/.browsers/` 等）
已加入 [.gitignore](.gitignore)，不会进入版本历史。
