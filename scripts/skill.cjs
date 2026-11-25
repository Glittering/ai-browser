// scripts/skill.cjs — 把随包分发的 skills/ 装进 agent 客户端的技能目录
//
// 为什么需要它：技能只有被客户端**发现并自动加载**才有价值。放在 npm 包里
// 不等于装上了——用户的 ~/.claude/skills 或 ~/.workbuddy/skills 里没有文件，
// agent 每次开新会话就只能靠人贴说明书（这就是"每次都要重新学"的真相）。
//
// 设计取舍：
//  - 只写自己管理的目录，靠 .ai-browser-skill 标记文件区分"我装的"和"用户自己写的"。
//    没有标记就跳过并提示，绝不覆盖用户手改的技能。
//  - 不猜路径：每个客户端一个明确常量，装不装得上让用户看见。

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pkg = require('../package.json');

const SKILLS_ROOT = path.join(__dirname, '..', 'skills');
const MARKER = '.ai-browser-skill';

// 已知客户端的技能目录。宁可只列确定正确的几个，也不猜。
const TARGETS = [
  { id: 'workbuddy', label: 'WorkBuddy', dir: path.join(os.homedir(), '.workbuddy', 'skills') },
  { id: 'claude', label: 'Claude Code', dir: path.join(os.homedir(), '.claude', 'skills') },
  { id: 'codex', label: 'Codex', dir: path.join(os.homedir(), '.codex', 'skills') },
];

function listSkills() {
  if (!fs.existsSync(SKILLS_ROOT)) return [];
  return fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, 'SKILL.md')))
    .map((d) => d.name);
}

function detectTargets() {
  return TARGETS.map((t) => ({
    ...t,
    exists: fs.existsSync(t.dir),
    installed: listSkills().filter((s) => fs.existsSync(path.join(t.dir, s, MARKER))),
  }));
}

// 标记文件里记的是"装它的那个包版本"。返回值语义必须分清：
//   null = 这个目录没有标记（不是本工具装的，绝不碰）
//   ''   = 有标记但读不出/格式旧（当作需要重装，不要当成"已是最新"）
function readMarker(dest) {
  const marker = path.join(dest, MARKER);
  if (!fs.existsSync(marker)) return null;
  try {
    const m = fs.readFileSync(marker, 'utf8').match(/ai-browser\s+(\S+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// 内容指纹。为什么需要它（2026-11-25 当晚就踩到）：
// 只比版本号时，"同一版本里改了技能文案"这类改动永远装不上去 —— install 判定
// up-to-date 直接跳过，用户看到的是"改了描述但 agent 行为没变"，而且没有任何
// 报错。所以标记里再存一份内容 hash，版本相同但内容变了也要重装。
function skillSignature(dir) {
  if (!fs.existsSync(dir)) return '';
  const h = crypto.createHash('sha256');
  const walk = (cur) => {
    const entries = fs.readdirSync(cur, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.name === MARKER) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(dir, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 8);
}

function readSignature(dest) {
  const marker = path.join(dest, MARKER);
  if (!fs.existsSync(marker)) return null;
  try {
    const m = fs.readFileSync(marker, 'utf8').match(/ai-browser\s+\S+\s+([0-9a-f]{4,})/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function markerText(sig) {
  return `ai-browser ${pkg.version} ${sig}\n`;
}

// 已装副本与当前包的版本差。为什么需要它（2026-11-25）：
// install 只在有人手动跑的时候写盘，`npm i -g` / `npx` 升级都不会碰用户目录，
// 于是"包装到了 2.4.1、技能还停在 2.1.1"是**静默**发生的 —— 用户看到的现象是
// "模型还是照着旧说明乱来"，而没有任何地方提示这件事。实测就有一台机器停在
// 2.1.1，缺 references/tabs.md 整节。
function drift() {
  const out = [];
  for (const t of detectTargets()) {
    if (!t.exists) continue;
    for (const s of t.installed) {
      const dest = path.join(t.dir, s);
      const v = readMarker(dest);
      const sig = readSignature(dest);
      const want = skillSignature(path.join(SKILLS_ROOT, s));
      if (v !== pkg.version || sig !== want) {
        out.push({
          target: t.label,
          dir: t.dir,
          skill: s,
          from: v || '?',
          contentOnly: v === pkg.version,
        });
      }
    }
  }
  return out;
}

function installOne(skill, targetDir) {
  const src = path.join(SKILLS_ROOT, skill);
  const dest = path.join(targetDir, skill);

  const installedVersion = fs.existsSync(dest) ? readMarker(dest) : null;

  // 没有标记 = 用户自己写的同名技能，跳过（这条永远优先）
  if (fs.existsSync(dest) && installedVersion === null) {
    return { skill, status: 'skipped-user-owned' };
  }

  const srcSig = skillSignature(src);
  // 版本 + 内容都一致才算最新：只比版本会把"同版本改了文案"判成 up-to-date，
  // 改动永远装不上去，而且不报错。
  if (installedVersion === pkg.version && readSignature(dest) === srcSig) {
    return { skill, status: 'up-to-date' };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  // 必须先删干净再拷：cpSync 只会覆盖同名文件，包里**已经删掉**的文件会一直
  // 留在用户目录里。那样"升级成功"和"还是旧版"在文件系统上无法区分，
  // 而且 agent 会继续读到已经作废的 reference。
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, MARKER), markerText(srcSig), 'utf8');

  const status = installedVersion ? 'upgraded' : 'installed';
  return { skill, status, from: installedVersion || null };
}

function install({ dir, all }) {
  const skills = listSkills();
  if (!skills.length) {
    console.error('[skill] 包里没有 skills/ 目录，这个构建是坏的');
    return 1;
  }

  let dirs;
  if (dir) {
    dirs = [{ id: 'custom', label: dir, dir: path.resolve(dir), exists: true }];
  } else {
    dirs = detectTargets().filter((t) => all || t.exists);
    if (!dirs.length) {
      console.error('[skill] 没找到任何已知客户端的技能目录。用 --dir <path> 指定，或加 --all 强行创建。');
      console.error('        已知位置：' + TARGETS.map((t) => `${t.label} → ${t.dir}`).join('；'));
      return 1;
    }
  }

  let failed = 0;
  let changed = 0;
  for (const t of dirs) {
    console.log(`\n→ ${t.label} (${t.dir})`);
    for (const s of skills) {
      const r = installOne(s, t.dir);
      let note;
      if (r.status === 'installed') {
        note = `✓ ${s}`;
        changed++;
      } else if (r.status === 'upgraded') {
        note =
          r.from === pkg.version
            ? `↻ ${s}  内容变了（版本仍是 ${pkg.version}）`
            : `↑ ${s}  ${r.from} → ${pkg.version}`;
        changed++;
      } else if (r.status === 'up-to-date') {
        note = `· ${s}  已是最新（${pkg.version}）`;
      } else {
        note = `! ${s} —— 这个目录已有同名技能且不是本工具装的，跳过（要覆盖请先手动删掉）`;
      }
      console.log('  ' + note);
    }
  }
  if (changed) {
    console.log(`\n更新了 ${changed} 个技能（共 ${skills.length} 个 × ${dirs.length} 个位置）。新开会话时客户端会自动发现它们。`);
  } else {
    console.log('\n全部已是最新，没有写盘。');
  }
  return failed;
}

function printEntry() {
  const entry = path.join(SKILLS_ROOT, 'ai-browser', 'SKILL.md');
  if (!fs.existsSync(entry)) {
    console.error('[skill] 找不到 skills/ai-browser/SKILL.md');
    return 1;
  }
  process.stdout.write(fs.readFileSync(entry, 'utf8'));
  return 0;
}

function run(argv) {
  const sub = argv[0] || 'list';

  if (sub === 'list') {
    const skills = listSkills();
    console.log(`ai-browser ${pkg.version} 附带 ${skills.length} 个技能：${skills.join(', ')}\n`);
    const rows = detectTargets();
    for (const t of rows) {
      const state = !t.exists ? '目录不存在' : t.installed.length ? `已装 ${t.installed.length} 个` : '未装';
      console.log(`  ${t.label.padEnd(12)} ${state.padEnd(12)} ${t.dir}`);
    }
    // 版本漂移必须在人主动查看时就能看见，而不是等 agent 用旧技能出错。
    const stale = drift();
    if (stale.length) {
      console.log(`\n! ${stale.length} 个副本需要刷新：`);
      for (const d of stale) {
        const why = d.contentOnly ? `内容变了（版本仍是 ${pkg.version}）` : `${d.from} → ${pkg.version}`;
        console.log(`    ${d.target}/${d.skill}  ${why}`);
      }
      console.log('  运行 `ai-browser skill install` 刷新。');
    }
    console.log('\n装上：ai-browser skill install        只装到已存在的客户端目录');
    console.log('      ai-browser skill install --all  三个位置都装');
    console.log('      ai-browser skill print          打印入口 SKILL.md（手动粘贴用）');
    return 0;
  }

  if (sub === 'install') {
    const dirIdx = argv.indexOf('--dir');
    return install({ dir: dirIdx >= 0 ? argv[dirIdx + 1] : null, all: argv.includes('--all') });
  }

  if (sub === 'print') return printEntry();

  console.error(`[skill] 未知子命令: ${sub}\n用法: ai-browser skill [list|install|print] [--dir <path>] [--all]`);
  return 2;
}

module.exports = {
  run,
  listSkills,
  detectTargets,
  drift,
  readMarker,
  readSignature,
  skillSignature,
  installOne,
  SKILLS_ROOT,
  MARKER,
};
