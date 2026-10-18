# 电商图片提取下载（Chrome 扩展 · Manifest V3）

在淘宝 / 天猫 / 京东 / 拼多多商家版的商品详情页右下角注入「获取图片」按钮，
一键提取页面内的商品图，集中展示后勾选批量下载为 PNG。

> 本文档在开发过程中持续完善，安装与使用说明见后续章节。

## 文件结构

```
manifest.json      扩展清单
extract.js         图片候选采集与 URL 清洗（纯函数）
content.js         悬浮按钮、懒加载触发、消息发送
content.css        按钮与提示样式（注入 Shadow DOM）
background.js      Service Worker：消息路由、结果暂存、下载
gallery.html/js/css 提取结果展示与批量下载页
icons/             扩展图标
test/              单元测试与端到端测试
tools/             图标生成脚本
```
