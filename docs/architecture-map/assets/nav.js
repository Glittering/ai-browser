// 架构图页面的轻量交互：搜索过滤 + 目录高亮。无外部依赖。
(function () {
  var q = document.getElementById('q');
  var hint = document.getElementById('qhint');
  if (!q || !hint) return;

  var all = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
  // 只对"叶子索引项"（表格行、模块卡、链路步骤）做文本匹配，避免父容器把整节内容
  // 都当成命中，导致搜索什么都筛不掉。
  var leaves = all.filter(function (el) { return !el.querySelector('[data-search]'); });
  var containers = all.filter(function (el) { return !!el.querySelector('[data-search]'); });
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.section'));
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var defaultHint = hint.textContent;
  var total = leaves.length;
  var activeId = null;

  function norm(s) { return String(s || '').toLowerCase(); }

  function visibleLeafIn(scope) {
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      if (el.classList.contains('hidden')) continue;
      if (scope.contains(el)) return true;
    }
    return false;
  }

  function setActive() {
    var best = null;
    sections.forEach(function (sec) {
      if (sec.classList.contains('hidden')) return;
      if (sec.getBoundingClientRect().top < window.innerHeight * 0.45) best = sec.id;
    });
    if (best === activeId) return;
    activeId = best;
    tocLinks.forEach(function (a) {
      var on = a.getAttribute('href') === '#' + best;
      a.style.background = on ? 'var(--accent-soft)' : '';
    });
  }

  function apply() {
    var term = norm(q.value.trim());
    all.forEach(function (el) { el.classList.add('hidden'); });

    if (!term) {
      all.forEach(function (el) { el.classList.remove('hidden'); });
      hint.textContent = defaultHint;
      setActive();
      return;
    }

    var shown = 0;
    leaves.forEach(function (el) {
      if (norm(el.textContent).indexOf(term) !== -1) {
        el.classList.remove('hidden');
        shown++;
      }
    });

    // 子项全被隐藏的容器（图层行、卡片网格）一并收起，避免留下空壳。
    containers.slice().reverse().forEach(function (el) {
      if (!visibleLeafIn(el)) el.classList.add('hidden');
    });

    sections.forEach(function (sec) {
      var head = sec.querySelector('.sec-head');
      var desc = sec.querySelector('.sec-desc');
      var headHit = norm(head && head.textContent).indexOf(term) !== -1
        || norm(desc && desc.textContent).indexOf(term) !== -1;
      if (headHit || visibleLeafIn(sec)) sec.classList.remove('hidden');
    });

    hint.textContent = '匹配 ' + shown + ' / ' + total + ' 个索引项';
    setActive();
  }

  q.addEventListener('input', apply);
  window.addEventListener('scroll', setActive, { passive: true });
  apply();
})();
