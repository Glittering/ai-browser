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

function installOne(skill, targetDir) {
  const src = path.join(SKILLS_ROOT, skill);
  const dest = path.join(targetDir, skill);
  const marker = path.join(dest, MARKER);

  if (fs.existsSync(dest) && !fs.existsSync(marker)) {
    return { skill, status: 'skipped-user-owned' };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  fs.writeFileSync(marker, `ai-browser ${pkg.version}\n`, 'utf8');
  return { skill, status: 'installed' };
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
  for (const t of dirs) {
    console.log(`\n→ ${t.label} (${t.dir})`);
    for (const s of skills) {
      const r = installOne(s, t.dir);
      const note =
        r.status === 'installed'
          ? `✓ ${s}`
          : `! ${s} —— 这个目录已有同名技能且不是本工具装的，跳过（要覆盖请先手动删掉）`;
      console.log('  ' + note);
    }
  }
  console.log(`\n装了 ${skills.length} 个技能。新开会话时客户端会自动发现它们，不需要再贴说明书。`);
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

module.exports = { run, listSkills, detectTargets, SKILLS_ROOT };
