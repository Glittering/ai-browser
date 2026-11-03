// tests/test_tab_group.js — 标签页归属与上限的判据（shared/tab_group.cjs）
//
// 这些判据决定三件事，桩桩都会伤人：
//   - 谁的上限算在谁头上（把人的标签页算进 agent 的配额 = 人开不了页面）
//   - 满了之后能不能拒绝（拒绝是唯一不丢数据的选择）
//   - 弹窗撑爆时牺牲哪一页（选错 = 把用户正在看的、或者 agent 正在跑流程的那页关掉）
import { describe, it, expect } from 'vitest';
import tabGroup from '../src/shared/tab_group.cjs';

const { HUMAN_GROUP, DEFAULT_LIMIT } = tabGroup;

describe('TG 组身份', () => {
  it('TG-1 有会话 → 自己的组；没会话 → 人的组', () => {
    expect(tabGroup.groupIdForSession('abc')).toBe('agent:abc');
    expect(tabGroup.groupIdForSession(null)).toBe(HUMAN_GROUP);
    expect(tabGroup.groupIdForSession('')).toBe(HUMAN_GROUP);
  });

  it('TG-2 人的组和 agent 的组要能区分开（上限、清理、标签栏都靠这个判断）', () => {
    expect(tabGroup.isAgentGroup('agent:x')).toBe(true);
    expect(tabGroup.isAgentGroup(HUMAN_GROUP)).toBe(false);
    expect(tabGroup.isHumanGroup(HUMAN_GROUP)).toBe(true);
    expect(tabGroup.isHumanGroup('agent:x')).toBe(false);
    expect(tabGroup.isHumanGroup(undefined)).toBe(true);
  });

  it('TG-3 组色按诞生顺序取，不按 id 哈希（人记的是"紫色那个"）', () => {
    expect(tabGroup.colorFor(0)).toBe(tabGroup.COLORS[0]);
    expect(tabGroup.colorFor(1)).not.toBe(tabGroup.colorFor(0));
    // 绕一圈回到起点，而不是 undefined
    expect(tabGroup.colorFor(tabGroup.COLORS.length)).toBe(tabGroup.COLORS[0]);
  });
});

describe('TG 上限', () => {
  it('TG-4 默认上限 8；环境变量可改，非法值回默认', () => {
    expect(DEFAULT_LIMIT).toBe(8);
    expect(tabGroup.limitFromEnv({})).toBe(8);
    expect(tabGroup.limitFromEnv({ AI_BROWSER_TAB_LIMIT: '3' })).toBe(3);
    expect(tabGroup.limitFromEnv({ AI_BROWSER_TAB_LIMIT: '0' })).toBe(8);
    expect(tabGroup.limitFromEnv({ AI_BROWSER_TAB_LIMIT: '-2' })).toBe(8);
    expect(tabGroup.limitFromEnv({ AI_BROWSER_TAB_LIMIT: 'abc' })).toBe(8);
    // 上限只用于自保，不该被设成 1000 变成"等于没有"
    expect(tabGroup.limitFromEnv({ AI_BROWSER_TAB_LIMIT: '1000' })).toBe(64);
  });

  it('TG-5 人的组**永远**允许继续开（限制人等于把产品做废）', () => {
    const d = tabGroup.decideOpen({ group: HUMAN_GROUP, count: 99, limit: 8 });
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(null);
    expect(d.remaining).toBe(null);
  });

  it('TG-6 agent 的组按 count/limit 判定，remaining 不许为负', () => {
    expect(tabGroup.decideOpen({ group: 'agent:x', count: 0, limit: 2 }))
      .toMatchObject({ allowed: true, remaining: 2 });
    expect(tabGroup.decideOpen({ group: 'agent:x', count: 1, limit: 2 }))
      .toMatchObject({ allowed: true, remaining: 1 });
    expect(tabGroup.decideOpen({ group: 'agent:x', count: 2, limit: 2 }))
      .toMatchObject({ allowed: false, remaining: 0 });
    expect(tabGroup.decideOpen({ group: 'agent:x', count: 5, limit: 2 }))
      .toMatchObject({ allowed: false, remaining: 0 });
  });

  it('TG-7 limit 缺失按默认值算，绝不当成"不限"', () => {
    expect(tabGroup.decideOpen({ group: 'agent:x', count: DEFAULT_LIMIT }).allowed).toBe(false);
    expect(tabGroup.decideOpen({ group: 'agent:x', count: DEFAULT_LIMIT - 1 }).allowed).toBe(true);
  });
});

describe('TG 满额时牺牲哪一页', () => {
  const tabs = [
    { id: 1, usedAt: 100, url: '/oldest' },
    { id: 2, usedAt: 900, url: '/newest' },
    { id: 3, usedAt: 500, url: '/middle' },
  ];

  it('TG-8 挑最久没用的那一页', () => {
    expect(tabGroup.pickEvictable({ tabs })).toBe(1);
  });

  it('TG-9 正在被打开的那一页不许牺牲（关了自己等于什么都没发生）', () => {
    expect(tabGroup.pickEvictable({ tabs, except: 1 })).toBe(3);
  });

  it('TG-10 人眼前那一页不许牺牲（人正在看着它）', () => {
    expect(tabGroup.pickEvictable({ tabs, activeTab: 1 })).toBe(3);
  });

  it('TG-11 挂着对话框的页不许牺牲（那是"等人点"的状态，关掉就把人的操作吞了）', () => {
    const withDialog = [
      { id: 1, usedAt: 100, dialog: true },
      { id: 2, usedAt: 900 },
    ];
    expect(tabGroup.pickEvictable({ tabs: withDialog })).toBe(2);
  });

  it('TG-12 没有可牺牲的页 → null（调用方宁可超限，也不吞正在用的页）', () => {
    expect(tabGroup.pickEvictable({ tabs: [{ id: 1, usedAt: 1 }], except: 1 })).toBe(null);
    expect(tabGroup.pickEvictable({ tabs: [] })).toBe(null);
    expect(tabGroup.pickEvictable({})).toBe(null);
  });

  // 2026-11-03 对照 Chromium 的吸收第 2 项。我们的淘汰是**整页关掉**，比 Chrome 的
  // discard 狠（discard 之后表单还在，我们一关全没），所以"不许丢弃"清单里凡是
  // 本项目真实存在的状态都要落到这里。"正在放声音"没落：架构已经把它消化掉了
  // —— agent 的后台页从出生就被按住（shared/tab_audio.cjs），能出声的只有
  // activeTab（TG-10 已排除）和人自己开的页（不归 agent 组管）。
  it('TG-13 有没提交的输入的页不许牺牲（写了一半的私信被关掉 = 把几分钟工作删了）', () => {
    const withDraft = [
      { id: 1, usedAt: 100, draft: true },
      { id: 2, usedAt: 900 },
      { id: 3, usedAt: 500 },
    ];
    expect(tabGroup.pickEvictable({ tabs: withDraft })).toBe(3);
    // 保护是"跳过这一页"，不是"整组都不许动"：还有别的页就牺牲别的
    expect(tabGroup.pickEvictable({ tabs: [{ id: 1, usedAt: 100, draft: true }] })).toBe(null);
  });

  it('TG-14 下载进行中的页不许牺牲（关页会连带取消那条下载）', () => {
    const withDl = [
      { id: 1, usedAt: 100, downloading: true },
      { id: 3, usedAt: 500 },
    ];
    expect(tabGroup.pickEvictable({ tabs: withDl })).toBe(3);
  });

  it('TG-15 保护只认"有"，不认各种假值（undefined / false / 0 都等于没有）', () => {
    const noise = [
      { id: 1, usedAt: 100, draft: false, downloading: undefined, dialog: 0 },
      { id: 2, usedAt: 900 },
    ];
    expect(tabGroup.pickEvictable({ tabs: noise })).toBe(1);
  });
});

describe('TG 哪些动作算"留下没提交的内容"', () => {
  it('TG-16 把文字送进页面的动作置位草稿', () => {
    for (const a of ['type', 'setContent', 'paste']) {
      expect(tabGroup.draftEffect(a), a).toBe('mark');
    }
  });

  it('TG-17 clear 销位：没有内容可丢了，保护就该跟着解除', () => {
    expect(tabGroup.draftEffect('clear')).toBe('clear');
  });

  it('TG-18 点击 / 滚动 / 按键不改草稿（它们是页面状态，不是"别人写了一半的东西"）', () => {
    for (const a of ['click', 'scroll', 'hover', 'select', 'submit', 'key', 'upload', '']) {
      expect(tabGroup.draftEffect(a), a).toBe(null);
    }
    expect(tabGroup.draftEffect(undefined)).toBe(null);
    expect(tabGroup.draftEffect(null)).toBe(null);
  });
});
