// tests/test_skill_upgrade.js — 技能副本的版本漂移必须可被发现、可被修好
//
// 起源（2026-11-25）：一台机器上 ~/.workbuddy/skills/ai-browser 停在 2.1.1，
// 而包已经是 2.4.1 —— 缺 references/tabs.md 整节。原因不是 install 写错了，
// 而是 install **只在有人手动跑的时候**写盘：`npm i -g` / `npx` 升级都不会碰
// 用户目录，于是"技能是旧的"完全静默。用户看到的现象是"模型照着旧说明乱来"，
// 没有任何地方提示过他。
//
// 这里钉三件事：
//   U-1 升级要幂等：同版本不重复写盘，不同版本才覆盖
//   U-2 升级必须先删再拷：包里已删掉的文件不能留在用户目录（否则"升没升上去"
//       在文件系统上无法区分，agent 还会读到作废的 reference）
//   U-3 用户自己写的同名技能永远不碰（没有 .ai-browser-skill 标记）
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const skill = require('../scripts/skill.cjs');
const pkg = require('../package.json');

const SKILL = 'ai-browser';
const MARKER = skill.MARKER;

function freshTarget() {
  return mkdtempSync(join(tmpdir(), 'aib-skill-'));
}

describe('技能安装：版本漂移与幂等', () => {
  it('U-1a: 目标目录已有旧版副本 → 升级到当前版本', () => {
    const target = freshTarget();
    try {
      const dest = join(target, SKILL);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), '旧版入口', 'utf8');
      writeFileSync(join(dest, MARKER), 'ai-browser 0.0.1\n', 'utf8');

      const r = skill.installOne(SKILL, target);
      expect(r.status, '旧版副本必须被识别成 upgraded，而不是跳过').toBe('upgraded');
      expect(r.from).toBe('0.0.1');
      expect(skill.readMarker(dest)).toBe(pkg.version);
      // 内容确实换成了包里的
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).not.toBe('旧版入口');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-1b: 同版本再装一次 → up-to-date，不写盘', () => {
    const target = freshTarget();
    try {
      skill.installOne(SKILL, target);
      const dest = join(target, SKILL);
      const markerPath = join(dest, MARKER);
      const before = readFileSync(markerPath, 'utf8');
      // 塞一个哨兵文件：如果第二次真的重写了目录，它会被删掉
      writeFileSync(join(dest, 'SENTINEL'), 'x', 'utf8');

      const r = skill.installOne(SKILL, target);
      expect(r.status).toBe('up-to-date');
      expect(existsSync(join(dest, 'SENTINEL')), 'up-to-date 不该重写目录').toBe(true);
      expect(readFileSync(markerPath, 'utf8')).toBe(before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-2: 升级必须清掉包里已删除的旧文件（cpSync 只覆盖不删除）', () => {
    const target = freshTarget();
    try {
      const dest = join(target, SKILL);
      mkdirSync(join(dest, 'references'), { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), 'old', 'utf8');
      writeFileSync(join(dest, 'references', 'obsolete.md'), '已经作废的参考', 'utf8');
      writeFileSync(join(dest, MARKER), 'ai-browser 2.1.1\n', 'utf8');

      skill.installOne(SKILL, target);
      expect(
        existsSync(join(dest, 'references', 'obsolete.md')),
        '旧文件还在 —— agent 会继续读作废的 reference，而"升没升上去"看不出来'
      ).toBe(false);
      // 当前包里真实存在的 reference 应该在
      expect(existsSync(join(dest, 'references', 'tabs.md')), '2.2+ 引入的 tabs.md 没装上').toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-3: 没有标记的同名技能属于用户，永远跳过', () => {
    const target = freshTarget();
    try {
      const dest = join(target, SKILL);
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), '我自己写的', 'utf8');

      const r = skill.installOne(SKILL, target);
      expect(r.status).toBe('skipped-user-owned');
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('我自己写的');
      expect(skill.readMarker(dest)).toBe(null);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-4: readMarker 区分「没有标记」和「标记读不出」', () => {
    const target = freshTarget();
    try {
      const dest = join(target, SKILL);
      mkdirSync(dest, { recursive: true });
      expect(skill.readMarker(dest), '没有标记必须是 null（= 用户的）').toBe(null);

      writeFileSync(join(dest, MARKER), 'garbage', 'utf8');
      expect(skill.readMarker(dest), '有标记但读不出版本必须是空串（= 需要重装）').toBe('');

      writeFileSync(join(dest, MARKER), `ai-browser ${pkg.version}\n`, 'utf8');
      expect(skill.readMarker(dest)).toBe(pkg.version);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-5: drift() 返回结构可被判读（不会因为目录不存在而抛）', () => {
    const d = skill.drift();
    expect(Array.isArray(d)).toBe(true);
    for (const row of d) {
      expect(typeof row.target).toBe('string');
      expect(typeof row.skill).toBe('string');
      // contentOnly 的行 from 就是当前版本（版本对、内容不对），那是合法的
      if (!row.contentOnly) expect(row.from).not.toBe(pkg.version);
    }
  });

  it('U-6: 版本没变但内容变了 → 仍然重装（只比版本号会漏掉"同版本改文案"）', () => {
    const target = freshTarget();
    try {
      skill.installOne(SKILL, target);
      const dest = join(target, SKILL);
      // 模拟"包里的技能文案改过、但版本号没动"：标记里版本对、指纹不对
      writeFileSync(join(dest, MARKER), `ai-browser ${pkg.version} deadbeef\n`, 'utf8');
      writeFileSync(join(dest, 'STALE_MARKER.md'), 'x', 'utf8');

      const r = skill.installOne(SKILL, target);
      expect(r.status, '内容指纹不同必须重装，否则改了描述永远装不上去').toBe('upgraded');
      expect(r.from).toBe(pkg.version);
      expect(existsSync(join(dest, 'STALE_MARKER.md')), '重装要先删再拷').toBe(false);
      expect(skill.readSignature(dest)).toBe(skill.skillSignature(join(skill.SKILLS_ROOT, SKILL)));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('U-7: 包里已删掉的技能，install 时要被清走（否则它继续按旧描述触发）', () => {
    const target = freshTarget();
    try {
      // 一个"以前装过、现在包里没有"的技能
      const gone = join(target, 'removed-skill');
      mkdirSync(gone, { recursive: true });
      writeFileSync(join(gone, 'SKILL.md'), '---\nname: removed-skill\n---\n旧的', 'utf8');
      writeFileSync(join(gone, MARKER), 'ai-browser 1.0.0 aaaaaaaa\n', 'utf8');

      // 一个用户自己写的同名目录（没有 marker）
      const mine = join(target, 'my-own-skill');
      mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, 'SKILL.md'), '---\nname: my-own-skill\n---\n', 'utf8');

      const removed = skill.removeOrphans(target);
      expect(removed).toEqual(['removed-skill']);
      expect(existsSync(gone), '包里没有的旧技能必须删掉').toBe(false);
      expect(existsSync(mine), '没有 marker 的是用户的，绝不能删').toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
