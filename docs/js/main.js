/**
 * 图提取 / ImageGrab 官网交互脚本
 *
 * 全部为原生实现，无第三方依赖，支持 file:// 直接打开：
 * 1. 移动端汉堡菜单（含 Escape 关闭、焦点管理）
 * 2. 滚动后导航栏毛玻璃状态
 * 3. 滚动监听，高亮当前区块的导航项
 * 4. IntersectionObserver 实现元素淡入上移动画
 * 5. 页脚年份、占位链接处理
 */
(function () {
  'use strict';

  /** @param {string} selector @param {ParentNode} [root] */
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  /** @param {string} selector @param {ParentNode} [root] */
  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  /** 用户是否开启了「减少动态效果」 */
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** 桌面断点，与 CSS 中的 768px 保持一致 */
  var desktopQuery = window.matchMedia('(min-width: 768px)');

  // ---------------------------------------------------------------- 移动端菜单

  function initMobileMenu() {
    var toggle = $('#menu-toggle');
    var nav = $('#site-nav');
    if (!toggle || !nav) return;

    var firstLink = $('.nav-link', nav);

    function isOpen() {
      return document.body.classList.contains('menu-open');
    }

    function openMenu() {
      document.body.classList.add('menu-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', '关闭导航菜单');
      if (firstLink) firstLink.focus({ preventScroll: true });
    }

    function closeMenu(restoreFocus) {
      if (!isOpen()) return;
      document.body.classList.remove('menu-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', '打开导航菜单');
      if (restoreFocus) toggle.focus({ preventScroll: true });
    }

    toggle.addEventListener('click', function () {
      if (isOpen()) closeMenu(true);
      else openMenu();
    });

    // 点击任意导航项后收起菜单（锚点跳转仍由浏览器处理）
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu(false);
    });

    // Escape 关闭并把焦点交还汉堡按钮
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) closeMenu(true);
    });

    // 视口放大到桌面断点时自动收起
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', function (event) {
        if (event.matches) closeMenu(false);
      });
    }
  }

  // ---------------------------------------------------------------- 导航栏吸顶状态

  function initNavbarScroll() {
    var navbar = $('#navbar');
    if (!navbar) return;

    var ticking = false;

    function update() {
      navbar.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------------------------------------------------------------- 滚动区块高亮

  function initScrollSpy() {
    var links = $$('.nav-link[href^="#"]');
    if (!links.length || !('IntersectionObserver' in window)) return;

    /** @type {Map<Element, Element>} 区块 -> 导航项 */
    var sectionToLink = new Map();
    var sections = [];

    links.forEach(function (link) {
      var id = link.getAttribute('href').slice(1);
      var section = document.getElementById(id);
      if (!section) return;
      sectionToLink.set(section, link);
      sections.push(section);
    });

    if (!sections.length) return;

    // 首屏不属于任何导航项：只观察它，用来在回到顶部时清除高亮
    var hero = document.getElementById('hero');
    if (hero) {
      sectionToLink.set(hero, null);
      sections.push(hero);
    }

    function setActive(activeLink) {
      links.forEach(function (link) {
        var isActive = link === activeLink;
        link.classList.toggle('is-active', isActive);
        if (isActive) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      });
    }

    var observer = new IntersectionObserver(
      function (entries) {
        var visible = entries
          .filter(function (entry) {
            return entry.isIntersecting;
          })
          .sort(function (a, b) {
            return b.intersectionRatio - a.intersectionRatio;
          })[0];

        if (visible) setActive(sectionToLink.get(visible.target));
      },
      // 只把视口中部附近的区块视为「当前区块」
      { rootMargin: '-40% 0px -55% 0px', threshold: [0, 0.15, 0.4, 0.7] }
    );

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  // ---------------------------------------------------------------- 入场动画

  function initReveal() {
    var items = $$('[data-reveal]');
    if (!items.length) return;

    function showAll() {
      items.forEach(function (item) {
        item.classList.add('is-visible');
      });
    }

    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      showAll();
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target); // 只播放一次
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );

    items.forEach(function (item) {
      observer.observe(item);
    });

    // 运行中切换「减少动态效果」时，把未显示的元素直接展示
    if (typeof reduceMotion.addEventListener === 'function') {
      reduceMotion.addEventListener('change', function (event) {
        if (event.matches) showAll();
      });
    }
  }

  // ---------------------------------------------------------------- 其他

  function initMisc() {
    // 版权年份
    var year = $('#year');
    if (year) year.textContent = String(new Date().getFullYear());

    // 占位链接（例如待补充的 GitHub 地址）不触发跳转
    $$('[data-placeholder]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
      });
    });
  }

  // ---------------------------------------------------------------- 启动

  function init() {
    initMobileMenu();
    initNavbarScroll();
    initScrollSpy();
    initReveal();
    initMisc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
