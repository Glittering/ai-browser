import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseScript = readFileSync(path.join(root, 'scripts', 'release.cjs'), 'utf8');

// 为什么这些断言存在（2026-10-24 / 10-25 连续踩坑）：
//
// 发版的失败模式从来不是"命令报错"，而是**某一环没人做，而且不报错**。
//   ① 标签栏修好了、npm/GitHub/MCP 全绿，但打包是手工的 → 桌面 App 还停在 v1.3.1；
//   ② 每个版本都 push 了 tag，但**从没建过 GitHub Release** → /releases 页面
//      停在上一次手工创建的那个版本，看起来"你根本没发版"；
//   ③ 所有 e2e 都 spawn 仓库里的 electron，**没有任何一条断言跑过打包产物** →
//      "dev 绿、用户装的是旧的"这类问题测不出来。
//
// 这三条的共同点：删掉其中任何一步，测试和 CI 都不会变红。所以这里把"发版闭环
// 必须包含哪些环节"钉成断言 —— 有人为了省事把某一步删掉时，先红一次。

describe('release loop is complete (每个渠道都必须被脚本覆盖)', () => {
  it('package.json 暴露了发版闭环需要的全部脚本', () => {
    const scripts = pkg.scripts || {};
    const required = {
      release: 'node scripts/release.cjs',
      build: 'node scripts/build_dmg.cjs',
      'verify:build': 'node scripts/verify_build.cjs',
      'install:app': 'node scripts/install_app.cjs',
      'verify:app': 'node e2e/shipped_ws.cjs',
      dialog: 'node e2e/dialog_ws.cjs',
    };
    for (const [name, expectCmd] of Object.entries(required)) {
      expect(scripts[name], `package.json 缺 scripts["${name}"]（或命令被改成了别的）。${name} 是发版闭环的一环，缺了就只能手工补，而手工补的那一步迟早会被漏掉。`).toBe(expectCmd);
    }
  });

  it('release.cjs 依次覆盖：GitHub Release / dmg / npm / MCP registry / 安装 / 产物验收', () => {
    // 用"关键命令是否出现"来钉，而不是钉步骤顺序的文字（注释会改，命令不该丢）
    const mustHave = [
      ['gh release create', '创建 GitHub Release（只 push tag 不会让 /releases 页面更新）'],
      ['gh release upload', '把 dmg 挂到 Release（否则页面上只有一段 changelog，用户还得自己找 App）'],
      ['npm publish', '发布 npm 包'],
      ['mcp-publisher', '发布 MCP registry'],
      ['install_app.cjs', '把新包装到 /Applications（用户双击的是这个副本）'],
      ['verify_build.cjs', '产物与源码逐字节校验'],
      ['shipped_ws.cjs', '在打包产物上跑验收（不是 dev 树）'],
    ];
    for (const [needle, why] of mustHave) {
      expect(
        releaseScript.includes(needle),
        `scripts/release.cjs 里找不到 "${needle}" —— ${why}。这一步从闭环里消失不会有任何报错，只会在用户那边表现为"你根本没发版/没修好"。`,
      ).toBe(true);
    }
  });

  it('摘要清单覆盖所有渠道（漏项要能看见）', () => {
    // 摘要里的 skipped 列表是"这次发版漏了什么"的唯一出口，渠道名必须都在里面，
    // 否则漏了也不显示 —— 等于没做。
    const listed = ['github release', 'release asset', 'npm publish', 'mcp registry', '安装', '产物验收', '打包校验'];
    const m = releaseScript.match(/const skipped = \[([\s\S]*?)\]/);
    expect(!!m, 'release.cjs 里的 skipped 清单被删掉或改写了 —— 发版摘要将不再报告漏项').toBe(true);
    const body = m[1];
    for (const name of listed) {
      expect(body.includes(`'${name}'`), `发版摘要的 skipped 清单里没有 "${name}"，这一环失败时不会出现在"未完成"里`).toBe(true);
    }
  });

  it('闭环用到的脚本文件都真实存在', () => {
    for (const f of ['scripts/release.cjs', 'scripts/build_dmg.cjs', 'scripts/verify_build.cjs', 'scripts/install_app.cjs', 'e2e/shipped_ws.cjs']) {
      expect(existsSync(path.join(root, f)), `发版脚本引用的 ${f} 不存在`).toBe(true);
    }
  });
});
