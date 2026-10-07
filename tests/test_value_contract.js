// tests/test_value_contract.js — node.value 截断契约（两条读层共用同一 helper）
// 覆盖方案 3.5 的 fixtures：199/200/201、emoji 与组合字符不产生孤立 surrogate、
// password/file 不泄露、get_value 分页与 value_fetch 展开。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import axExtractor from '../src/main/axExtractor.js';

const require = createRequire(import.meta.url);
const vc = require('../src/shared/value_contract.cjs');
const { truncateNodeValue, getValueResult, expandValueFetch, expandValueFetchTree, sensitiveInputKind, codePointLength } = vc;

// 199 / 200 / 201 个 code point：只有 201 应该出现截断字段。
const mk = (n, ch = 'a') => Array.from({ length: n }, () => ch).join('');

// 断言字符串里没有孤立 surrogate（emoji 被切半的唯一可观测症状）。
function hasLoneSurrogate(s) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(s);
}

describe('truncateNodeValue — 边界长度', () => {
  it('VC-01 199 code point 不截断，只返回 { value }', () => {
    const r = truncateNodeValue(mk(199), 'n1');
    expect(r).toEqual({ value: mk(199) });
    expect(Object.keys(r)).toEqual(['value']);
  });

  it('VC-02 200 code point 不截断（恰好等于上限）', () => {
    const r = truncateNodeValue(mk(200), 'n1');
    expect(r).toEqual({ value: mk(200) });
    expect(r.value_truncated).toBeUndefined();
  });

  it('VC-03 201 code point 截断，且只多出契约规定的字段', () => {
    const r = truncateNodeValue(mk(201), 'ax-418');
    expect(r.value_truncated).toBe(true);
    expect(r.value_full_length).toBe(201);
    expect(r.value_length_unit).toBe('unicode_code_point');
    expect(r.value_fetch_ref).toEqual({ action: 'get_value', target: 'ax-418' });
    expect(Object.keys(r).sort()).toEqual(
      ['value', 'value_fetch_ref', 'value_full_length', 'value_length_unit', 'value_truncated'].sort()
    );
  });

  it('VC-04 value 永远是原值前缀，不追加省略号', () => {
    const raw = mk(500);
    const r = truncateNodeValue(raw, 'n');
    expect(r.value.length).toBe(200);
    expect(raw.startsWith(r.value)).toBe(true);
    expect(r.value.endsWith('...')).toBe(false);
    expect(r.value).toBe(raw.slice(0, 200));
  });

  it('VC-05 value_truncated 从不出现 false（普通节点不加字段）', () => {
    for (const n of [1, 199, 200]) {
      expect('value_truncated' in truncateNodeValue(mk(n), 'n')).toBe(false);
    }
  });
});

describe('truncateNodeValue — Unicode 正确性', () => {
  it('VC-06 emoji 边界不产生孤立 surrogate，长度按 code point 计', () => {
    // 201 个 emoji = 402 个 UTF-16 code unit；旧 slice(0,200) 会正好切在
    // 第 101 个 emoji 的高位代理上，产生半个 emoji。
    const raw = Array.from({ length: 201 }, () => '\u{1F600}').join('');
    const r = truncateNodeValue(raw, 'n');
    expect(raw.length).toBe(402);          // UTF-16 code unit
    expect(codePointLength(raw)).toBe(201); // code point
    expect(r.value_full_length).toBe(201);
    expect(hasLoneSurrogate(r.value)).toBe(false);
    expect(codePointLength(r.value)).toBe(200);
  });

  it('VC-07 组合字符（代理对 + 组合音标）边界同样不被切坏', () => {
    // "e" + U+0301 = 2 code point / 3 UTF-16 unit，故意让 200 落在中间。
    const unit = 'e\u0301';
    const raw = unit.repeat(150); // 300 code point
    const r = truncateNodeValue(raw, 'n');
    expect(r.value_full_length).toBe(300);
    expect(codePointLength(r.value)).toBe(200);
    expect(hasLoneSurrogate(r.value)).toBe(false);
    expect(raw.startsWith(r.value)).toBe(true);
  });

  it('VC-08 中日韩与 emoji 混排：value 仍是原值前缀', () => {
    const raw = '你好世界'.repeat(60) + '\u{1F600}'.repeat(10);
    const r = truncateNodeValue(raw, 'n');
    expect(r.value_full_length).toBe(240 + 10);
    expect(raw.startsWith(r.value)).toBe(true);
    expect(hasLoneSurrogate(r.value)).toBe(false);
  });
});

describe('sensitiveInputKind — password / file 不泄露', () => {
  it('VC-09 password input 识别为 password', () => {
    expect(sensitiveInputKind({ tagName: 'INPUT', type: 'password' })).toBe('password');
    expect(sensitiveInputKind({ tagName: 'INPUT', type: 'PASSWORD' })).toBe('password');
  });

  it('VC-10 file input 识别为 file（本地路径不当普通 value 暴露）', () => {
    expect(sensitiveInputKind({ tagName: 'INPUT', type: 'file' })).toBe('file');
  });

  it('VC-11 普通 input / textarea 不是敏感控件', () => {
    expect(sensitiveInputKind({ tagName: 'INPUT', type: 'text' })).toBe(null);
    expect(sensitiveInputKind({ tagName: 'TEXTAREA' })).toBe(null);
  });
});

describe('expandValueFetch — 主进程组装时补 tab', () => {
  it('VC-12 value_fetch_ref 展开成 mcp + ws 两种调用提示并带上真实 tab', () => {
    const node = { id: 'ax-418', value_fetch_ref: { action: 'get_value', target: 'ax-418' } };
    expandValueFetch(node, 2);
    expect(node.value_fetch).toEqual({
      mcp: { tool: 'browse_act', args: { action: 'get_value', target: 'ax-418', tab: 2 } },
      ws: { method: 'ui.act', params: { action: 'get_value', target: 'ax-418', tab: 2 } },
    });
    expect(node.value_fetch_ref).toBeUndefined();
  });

  it('VC-13 整棵树递归展开（含子节点）', () => {
    const tree = {
      id: 'root', children: [
        { id: 'a', value_fetch_ref: { action: 'get_value', target: 'a' } },
        { id: 'b', children: [{ id: 'c', value_fetch_ref: { action: 'get_value', target: 'c' } }] },
      ],
    };
    expandValueFetchTree(tree, 5);
    expect(tree.children[0].value_fetch.ws.params.tab).toBe(5);
    expect(tree.children[1].children[0].value_fetch.mcp.args.tab).toBe(5);
  });
});

describe('getValueResult — get_value 分页', () => {
  it('VC-14 默认 offset=0，一次拿全时 value_truncated=false / next_offset=null', () => {
    const r = getValueResult(mk(1837), 0, undefined);
    expect(r.value_full_length).toBe(1837);
    expect(r.returned_length).toBe(1837);
    expect(r.value_truncated).toBe(false);
    expect(r.next_offset).toBe(null);
    expect(r.value_length_unit).toBe('unicode_code_point');
  });

  it('VC-15 limit 生效时返回 next_offset，且两段拼起来等于原值', () => {
    const raw = mk(5000);
    const p1 = getValueResult(raw, 0, 2000);
    expect(p1.value_truncated).toBe(true);
    expect(p1.next_offset).toBe(2000);
    const p2 = getValueResult(raw, p1.next_offset, 2000);
    expect(p2.offset).toBe(2000);
    expect(p2.returned_length).toBe(2000);
    const p3 = getValueResult(raw, p2.next_offset, 2000);
    expect(p3.returned_length).toBe(1000);
    expect(p3.value_truncated).toBe(false);
    expect(p1.value + p2.value + p3.value).toBe(raw);
  });

  it('VC-16 limit 硬上限 1,000,000 code point', () => {
    const r = getValueResult(mk(10), 0, 10 ** 9);
    // 请求超过硬上限不会报错，但会被夹到 1e6（这里原值只有 10，仍全量返回）
    expect(r.returned_length).toBe(10);
    const big = getValueResult(mk(20), 0, 5);
    expect(big.returned_length).toBe(5);
    expect(big.next_offset).toBe(5);
  });

  it('VC-17 1,000,001 code point 按 offset/limit 分页，全长正确', () => {
    const raw = mk(1000001);
    const p1 = getValueResult(raw, 0, 1000000);
    expect(p1.value_full_length).toBe(1000001);
    expect(p1.returned_length).toBe(1000000);
    expect(p1.next_offset).toBe(1000000);
    const p2 = getValueResult(raw, 1000000, 1000000);
    expect(p2.returned_length).toBe(1);
    expect(p2.value_truncated).toBe(false);
  });

  it('VC-18 offset 越界返回空串而不是抛错', () => {
    const r = getValueResult(mk(10), 999, 100);
    expect(r.value).toBe('');
    expect(r.returned_length).toBe(0);
    expect(r.value_truncated).toBe(false);
  });
});

// 方案 3.5 第 8 条：两条读层对同一值必须产出完全相同的截断字段。
describe('两条读层共用同一契约（AX 与 legacy 不得漂移）', () => {
  const longValue = mk(250, 'z');
  const node = {
    nodeId: '418',
    role: { value: 'textbox' },
    name: { value: 'long' },
    value: { value: longValue },
    properties: [],
    backendDOMNodeId: 418,
  };

  it('VC-19 AX 读层产出的截断字段与 helper 完全一致', () => {
    const tree = axExtractor.normalizeAxTree([node]);
    const [value, truncated, full, unit] = [
      tree.value, tree.value_truncated, tree.value_full_length, tree.value_length_unit,
    ];
    const expected = truncateNodeValue(longValue, tree.id, 200);
    expect(value).toBe(expected.value);
    expect(truncated).toBe(true);
    expect(full).toBe(expected.value_full_length);
    expect(unit).toBe('unicode_code_point');
    expect(tree.value_fetch_ref).toEqual({ action: 'get_value', target: tree.id });
  });

  it('VC-20 AX 读层对 200 code point 的值不加任何截断字段', () => {
    const short = { ...node, value: { value: mk(200) } };
    const tree = axExtractor.normalizeAxTree([short]);
    expect(tree.value).toBe(mk(200));
    expect('value_truncated' in tree).toBe(false);
    expect('value_full_length' in tree).toBe(false);
  });

  it('VC-21 AX 读层对 emoji 长值不产生孤立 surrogate', () => {
    const emojiNode = { ...node, value: { value: '\u{1F600}'.repeat(201) } };
    const tree = axExtractor.normalizeAxTree([emojiNode]);
    expect(tree.value_full_length).toBe(201);
    expect(tree.value.length).toBe(400); // 200 个 emoji = 400 UTF-16 unit
    expect(hasLoneSurrogate(tree.value)).toBe(false);
  });
});
