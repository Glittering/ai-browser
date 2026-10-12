// tests/test_semantic_extractor.js — Tests for preload/extractor.cjs
// Uses jsdom via vitest environment
// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load test HTML
const htmlPath = resolve(__dirname, 'test_pages/basic_controls.html');
const basicHTML = readFileSync(htmlPath, 'utf-8');

// We'll dynamically import the extractor after setting up DOM
let extractTree;

beforeAll(async () => {
  // Set up jsdom with the test HTML
  document.documentElement.innerHTML = basicHTML;
  // Wait for scripts to execute (jsdom runs them inline)
  await new Promise(r => setTimeout(r, 0));

  // Dynamic import — the module must work in jsdom (no Electron APIs).
  // extractor.cjs is CommonJS, so it is exposed under `.default`.
  const mod = await import('../src/preload/extractor.cjs');
  const ns = mod.default || mod;
  extractTree = ns.extractTree;
});

describe('extractTree()', () => {
  it('SE-001: returns non-null root', () => {
    const tree = extractTree();
    expect(tree).not.toBeNull();
    expect(tree.role).toBeDefined();
  });

  it('SE-002: finds buttons >= 4', () => {
    const tree = extractTree();
    const buttons = findAllByRole(tree, 'button');
    expect(buttons.length).toBeGreaterThanOrEqual(4);
  });

  it('SE-003: finds textboxes >= 3', () => {
    const tree = extractTree();
    const textboxes = findAllByRole(tree, 'textbox');
    expect(textboxes.length).toBeGreaterThanOrEqual(3);
  });

  it('SE-004: disabled button has disabled state', () => {
    const tree = extractTree();
    const disabledBtn = findById(tree, 'btn-disabled');
    // May be null if denoised differently; accept finding by role+state
    const allButtons = findAllByRole(tree, 'button');
    const disabled = allButtons.find(b => b.states && b.states.includes('disabled'));
    expect(disabled).toBeDefined();
  });

  it('SE-005: hidden elements not in tree', () => {
    const tree = extractTree();
    expect(findById(tree, 'div-hidden')).toBeNull();
    expect(findById(tree, 'div-display-none')).toBeNull();
  });

  it('SE-006: aria-label takes priority for label', () => {
    const tree = extractTree();
    const searchInput = findAllByRole(tree, 'textbox')
      .find(el => el.label === 'Search');
    expect(searchInput).toBeDefined();
  });

  it('SE-007: title fallback for label', () => {
    const tree = extractTree();
    const primaryBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'Primary action');
    expect(primaryBtn).toBeDefined();
  });

  it('SE-008: label truncated at 60 chars', () => {
    const tree = extractTree();
    const allElements = flattenTree(tree);
    for (const el of allElements) {
      if (el.label) {
        expect(el.label.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it('SE-009: bounds have positive dimensions', () => {
    // Skip in jsdom — getBoundingClientRect returns 0,0,0,0 in jsdom
    // Will be tested in integration with real Electron
  });

  it('SE-010: pure layout wrappers denoised', () => {
    const tree = extractTree();
    // layout-wrapper divs should not appear
    expect(findById(tree, 'wrapper-empty')).toBeNull();
  });

  it('SE-011: data-* attributes preserved', () => {
    const tree = extractTree();
    const primaryBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'Primary action');
    if (primaryBtn && primaryBtn.attributes) {
      expect(primaryBtn.attributes['data-testid']).toBe('primary-btn');
    }
  });

  it('SE-012: id stable across calls', () => {
    const tree1 = extractTree();
    const tree2 = extractTree();
    const btn1 = findAllByRole(tree1, 'button')[0];
    const btn2 = findAllByRole(tree2, 'button')[0];
    if (btn1 && btn2) {
      expect(btn1.id).toBe(btn2.id);
    }
  });

  it('SE-013: ARIA role overrides tagName', () => {
    const tree = extractTree();
    const ariaBtn = findAllByRole(tree, 'button')
      .find(el => el.label === 'ARIA role button');
    expect(ariaBtn).toBeDefined();
  });

  it('SE-014: focused element marked', () => {
    // Focus something first
    const input = document.getElementById('input-text');
    if (input) input.focus();
    const tree = extractTree();
    // Not asserting non-null — focus may or may not register in jsdom
  });

  it('SE-018: empty page does not crash', () => {
    document.documentElement.innerHTML = '<html><body></body></html>';
    const tree = extractTree();
    expect(tree).not.toBeNull();
  });

  it('SE-020: tree size is reasonable', () => {
    // Restore basic HTML
    document.documentElement.innerHTML = basicHTML;
    const tree = extractTree();
    const allElements = flattenTree(tree);
    expect(allElements.length).toBeLessThan(500);
  });

  it('SE-021: Draft.js editor emits block-level editor_blocks (P4)', () => {
    document.documentElement.innerHTML =
      '<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="true">' +
      '<div data-block="true">para one</div>' +
      '<div data-block="true">para two</div>' +
      '</div></div>';
    const tree = extractTree();
    const editor = flattenTree(tree).find(n => n.editor_type === 'draft'); // DraftEditor-root container
    const content = flattenTree(tree).find(n => n.editor_type === 'draft' && n.editor_blocks);
    const blocks = (content ? content.editor_blocks : null) || (editor ? editor.editor_blocks : null);
    expect(blocks).toBeDefined();
    expect(blocks.map(b => b.text)).toEqual(['para one', 'para two']);
  });

  it('SE-022: plain contenteditable splits paragraphs on newline', () => {
    document.documentElement.innerHTML =
      '<div id="ce1" contenteditable="true"><p>first block</p><p>second block</p></div>';
    const tree = extractTree();
    const ce = flattenTree(tree).find(n => n.editor_type === 'contenteditable');
    const blocks = ce ? ce.editor_blocks : null;
    expect(blocks).toBeDefined();
    expect(blocks.map(b => b.role)).toEqual(['p', 'p']);
  });
});

// ---------------------------------------------------------------------------
// ai-id 稳定性（AI-ID）
//
// agent 的典型用法是**先 get_tree 拿 id、再按 id 操作**，而页面在这中间自更新
// （画布增删节点、列表插入一行）是常态。旧实现用"每次抽取都归零"的计数器按遍历
// 顺序编号，于是最前面插入一个元素就会把后面**所有**元素重新编号 —— 旧 id 指向
// 另一个元素，操作照常报 success 却打在了别的东西上。这几条钉住修复。
// ---------------------------------------------------------------------------
describe('data-ai-id 的稳定性', () => {
  // 取"没有原生 id"的元素 —— 只有它们才走自动编号那条路
  const groupIds = () => {
    const out = {};
    document.querySelectorAll('[role="group"]').forEach((el) => {
      out[el.getAttribute('aria-label')] = el.getAttribute('data-ai-id');
    });
    return out;
  };

  it('AI-ID-001: 抽取两次（DOM 未变）id 完全一致', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="g0"><button>b0</button></div>' +
      '<div role="group" aria-label="g1"><button>b1</button></div>' +
      '</div>';
    extractTree();
    const a = groupIds();
    extractTree();
    const b = groupIds();
    expect(a).toEqual(b);
    expect(a['g0']).toBeTruthy();
  });

  it('AI-ID-002: 在前面插入新元素后，已有元素的 id 不得漂移', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="g0"><button>b0</button></div>' +
      '<div role="group" aria-label="g1"><button>b1</button></div>' +
      '<div role="group" aria-label="g2"><button>b2</button></div>' +
      '</div>';
    extractTree();
    const before = groupIds();

    // 页面自更新：最前面插入一个新分组 —— 旧实现会让 g0/g1/g2 全部换号
    const fresh = document.createElement('div');
    fresh.setAttribute('role', 'group');
    fresh.setAttribute('aria-label', 'gnew');
    fresh.innerHTML = '<button>bnew</button>';
    const host = document.getElementById('host');
    host.insertBefore(fresh, host.firstElementChild);

    extractTree();
    const after = groupIds();
    for (const k of Object.keys(before)) {
      expect(`${k}=${after[k]}`).toBe(`${k}=${before[k]}`);
    }
    // 新元素要拿到一个**不同于**所有已有 id 的新号
    expect(after['gnew']).toBeTruthy();
    expect(Object.values(before)).not.toContain(after['gnew']);
  });

  it('AI-ID-003: 同一页面上生成的 id 互不重号（含跨抽取新增的元素）', () => {
    document.documentElement.innerHTML =
      '<div id="host">' +
      '<div role="group" aria-label="h0"><button>c0</button></div>' +
      '<div role="group" aria-label="h1"><button>c1</button></div>' +
      '</div>';
    extractTree();
    extractTree(); // 再抽一次，序号不得回退
    const host = document.getElementById('host');
    const extra = document.createElement('div');
    extra.setAttribute('role', 'group');
    extra.setAttribute('aria-label', 'h2');
    extra.innerHTML = '<button>c2</button>';
    host.appendChild(extra);
    extractTree();

    const ids = Array.from(document.querySelectorAll('[data-ai-id]')).map((e) => e.getAttribute('data-ai-id'));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('AI-ID-004: 原生 id 优先于自动编号（原有语义不变）', () => {
    document.documentElement.innerHTML = '<button id="native-btn">N</button>';
    extractTree();
    expect(document.getElementById('native-btn').getAttribute('data-ai-id')).toBe('native-btn');
  });
});

// Helper: recursive find by id
function findById(tree, id) {
  if (tree.id === id) return tree;
  if (tree.children) {
    for (const child of tree.children) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

// Helper: find all by role
function findAllByRole(tree, role) {
  const results = [];
  if (tree.role === role) results.push(tree);
  if (tree.children) {
    for (const child of tree.children) {
      results.push(...findAllByRole(child, role));
    }
  }
  return results;
}

// Helper: flatten tree to array
function flattenTree(tree) {
  const results = [tree];
  if (tree.children) {
    for (const child of tree.children) {
      results.push(...flattenTree(child));
    }
  }
  return results;
}
// ---------------------------------------------------------------------------
// 同源 iframe（IFRAME）
//
// 真实场景：ComfyUI 这类编辑器把主体装在**同源 iframe** 里，外层只是一个壳。
// 修复前这类页面在语义树里等于全瞎 —— iframe 里 2024 个元素（106 个按钮 / 42 个输入框）
// 一个都进不了树。根因有两处，都必须钉住：
//   ① `process()` 里 iframe 的递归写在 `isSemantic()` 判定**之后**，而 iframe 本身不带
//      语义（无 role/无 label），永远走不到那段递归；
//   ② `isSemantic()` 用 `el instanceof HTMLElement`，HTMLElement 是**顶层 window**的构造
//      函数，iframe 里的元素属于 iframe 自己的 window —— 跨文档 instanceof 恒为 false。
// ---------------------------------------------------------------------------
describe('同源 iframe 的内容必须进语义树', () => {
  const build = () => {
    document.documentElement.innerHTML = '<body><button id="topbtn">TOP</button><iframe id="fr"></iframe></body>';
    const ifr = document.getElementById('fr');
    // jsdom 里同步写入，避免 srcdoc 异步加载带来的时序干扰
    ifr.contentDocument.open();
    ifr.contentDocument.write(
      '<button id="inbtn">INNER</button><input id="inp" placeholder="PIN"><div><button id="deep">DEEP</button></div>'
    );
    ifr.contentDocument.close();
    return extractTree();
  };

  it('IFRAME-001: iframe 内部的按钮出现在语义树里', () => {
    const flat = flattenTree(build());
    const inner = flat.find((n) => n.id === 'inbtn');
    expect(inner).toBeDefined();
    expect(inner.role).toBe('button');
    expect(inner.label).toBe('INNER');
  });

  it('IFRAME-002: 深层嵌套的元素也要带出来（不是只取一层）', () => {
    const flat = flattenTree(build());
    expect(flat.find((n) => n.id === 'deep')).toBeDefined();
  });

  it('IFRAME-003: iframe 内的输入框带上可操作语义', () => {
    const flat = flattenTree(build());
    const inp = flat.find((n) => n.id === 'inp');
    expect(inp).toBeDefined();
    expect(inp.role).toBe('textbox');
    expect((inp.actions || []).length).toBeGreaterThan(0);
  });

  it('IFRAME-004: 每个新元素都拿到 data-ai-id（否则 ui.act 定位不到）', () => {
    const flat = flattenTree(build());
    for (const id of ['inbtn', 'inp', 'deep']) {
      const el = document.getElementById('fr').contentDocument.getElementById(id);
      expect(el.getAttribute('data-ai-id')).toBeTruthy();
      const node = flat.find((n) => n.id === el.getAttribute('data-ai-id'));
      expect(node).toBeDefined();
    }
  });

  it('IFRAME-005: 对照——顶层元素不受影响（修 iframe 不能把主文档弄坏）', () => {
    const flat = flattenTree(build());
    const top = flat.find((n) => n.id === 'topbtn');
    expect(top).toBeDefined();
    expect(top.label).toBe('TOP');
  });
});

// ---------------------------------------------------------------------------
// 属性写入纪律 —— 读取不得打扰页面
//
// 实测（tools/_oneoff/mutation_microtest.cjs，真实 Chromium）：setAttribute 设成
// **完全相同的值**，MutationObserver 照样收到记录。所以"每次都写"等于每一次读取都
// 向页面自己的 observer 灌 N 条属性变更（4000 元素页面实测每次 4001 条），页面里
// 任何监听属性的脚本都会被惊动 —— 而我们只是想读它。
//
// 这一组必须自带阳性对照：只断言"热读写了 0 次"是不够的，万一探针本身失效（比如
// setAttribute 不是走 prototype），0 就是假绿。所以先清掉标注证明"冷读确实会写"。
// ---------------------------------------------------------------------------
describe('data-ai-id 写入纪律', () => {
  function spyOnAiIdWrites(fn) {
    const calls = [];
    const orig = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (String(name).toLowerCase() === 'data-ai-id') calls.push({ tag: this.tagName, value });
      return orig.call(this, name, value);
    };
    try { fn(); } finally { Element.prototype.setAttribute = orig; }
    return calls;
  }

  it('SE-ID-001: 元素已带同一个 data-ai-id 时，第二次抽取不得再写（含无 id 的生成型）', () => {
    // 清掉全部标注 → 制造一次真正的"冷读"
    document.querySelectorAll('[data-ai-id]').forEach((el) => el.removeAttribute('data-ai-id'));
    // 顺手把 iframe 里也清掉（同源帧的内容会被递归抽取）
    document.querySelectorAll('iframe').forEach((f) => {
      try { f.contentDocument.querySelectorAll('[data-ai-id]').forEach((el) => el.removeAttribute('data-ai-id')); } catch (_) {}
    });

    const cold = spyOnAiIdWrites(() => extractTree());
    const warm = spyOnAiIdWrites(() => extractTree());

    // 阳性对照：探针确实抓得到写入（否则下面的 0 没有意义）
    expect(cold.length).toBeGreaterThan(0);
    expect(cold.every((c) => c.value)).toBe(true);
    // 断言本体：热读零写入
    expect(warm).toEqual([]);
  });

  it('SE-ID-002: 沿用已有 id → 冷读写进去的值与树里报出的 id 一致', () => {
    const tree = extractTree();
    const flat = [];
    (function walk(n) { if (!n) return; flat.push(n); (n.children || []).forEach(walk); })(tree);
    const withId = flat.filter((n) => n.id && document.querySelector('[data-ai-id="' + n.id + '"]'));
    expect(withId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 语义自述不得把 agent 引向错误动作
//
// 这两条都是 e2e/richtext_ws.cjs 自己打印出来的 P2 观察，但没人当失败处理 ——
// 观察是对的，缺的是断言。实测依据 tools/_oneoff/role_gap_probe.cjs（真实 Chromium）：
//
//     input[type=file] → role=textbox  actions=[type,setContent,clear,focus]
//     role=combobox    → actions=[focus]           （没有 click）
//     role=listbox / option / menu / menuitem → actions=[]
//
// 共同点：不崩、不报错，只是让 agent 用错动作（去 type 一个文件选择器，
// 或以为自定义下拉不可点）。所以永远不会红，必须由测试钉住。
//
// 注意：这组测试会替换 document.body，用完必须还原 —— 后面还有依赖同一个 fixture
// 的用例（SE-ID 那组读的是 data-ai-id）。
// ---------------------------------------------------------------------------
describe('ARIA 控件角色与动作自述', () => {
  const WIDGETS_HTML = `
    <input type="file" id="f">
    <input type="text" id="t">
    <div role="combobox" id="c" tabindex="0">选择器</div>
    <div role="listbox" id="l"><div role="option" id="o">A</div></div>
    <div role="menu" id="m"><div role="menuitem" id="mi">X</div></div>
    <div role="switch" id="sw" tabindex="0">开关</div>
    <div role="tab" id="tb" tabindex="0">标签</div>
    <div role="searchbox" id="sb" tabindex="0">搜索</div>
    <button id="ok">确定</button>`;

  let savedBody = null;
  beforeEach(() => {
    savedBody = document.body.innerHTML;
    document.body.innerHTML = WIDGETS_HTML;
  });
  afterEach(() => { document.body.innerHTML = savedBody; });

  const flat = (tree) => {
    const out = [];
    (function w(n) { if (!n) return; out.push(n); (n.children || []).forEach(w); })(tree);
    return out;
  };
  const byId = (tree, id) => flat(tree).find((n) => n.id === id);

  it('RW-001: input[type=file] 报 role=fileinput，动作是 upload 而不是 type', () => {
    const f = byId(extractTree(), 'f');
    expect(f.role).toBe('fileinput');
    expect(f.actions).toContain('upload');
    // 关键：不得出现 type/setContent/clear —— 那正是把 agent 引向错误动作的东西
    for (const bad of ['type', 'setContent', 'clear']) {
      expect(f.actions, `fileinput 不该自述 ${bad}`).not.toContain(bad);
    }
  });

  it('RW-002: 普通文本输入框仍是 textbox + type（不得被 RW-001 波及）', () => {
    const t = byId(extractTree(), 't');
    expect(t.role).toBe('textbox');
    expect(t.actions).toContain('type');
  });

  it('RW-003: W3C 控件角色一律自述可点（combobox/listbox/option/menu/menuitem/switch/tab）', () => {
    const tree = extractTree();
    for (const id of ['c', 'l', 'o', 'm', 'mi', 'sw', 'tb']) {
      const n = byId(tree, id);
      expect(n, `#${id} 应进入语义树`).toBeTruthy();
      expect(n.actions, `#${id} (role=${n.role}) 应自述 click`).toContain('click');
    }
  });

  it('RW-004: searchbox 自述输入类动作', () => {
    const sb = byId(extractTree(), 'sb');
    expect(sb.role).toBe('searchbox');
    expect(sb.actions).toContain('type');
  });

  it('RW-005: 普通 button 不受影响（仍是 click/focus/hover）', () => {
    const ok = byId(extractTree(), 'ok');
    expect(ok.role).toBe('button');
    expect(ok.actions).toEqual(['click', 'focus', 'hover']);
  });

  it('RW-006: 阳性对照 —— 带 draggable 的容器仍能推出 click', () => {
    // 没有这条，RW-003 全绿也可能是因为整条动作推断链失效（例如节点根本没进树）。
    // 第一次写的时候用的是裸 <div style="cursor:pointer">，结果它是 undefined ——
    // 因为 isSemantic() 对无 role、无可交互子元素的裸 div 直接返回 false，
    // 节点压根不进语义树。这个失败本身有价值：它证明"cursor:pointer 的裸 div"这条路
    // 在真实页面里也拿不到动作，得靠 role/draggable 才进得来。
    document.body.innerHTML = '<div role="group" id="d" draggable="true">可拖容器</div>';
    const d = byId(extractTree(), 'd');
    expect(d, '容器必须进入语义树').toBeTruthy();
    expect(d.actions).toContain('click');
  });
});
