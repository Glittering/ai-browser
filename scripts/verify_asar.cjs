// scripts/verify_asar.cjs — 打包后自检：asar 里的依赖必须自洽。
//
// # 为什么需要这一步（2026-10-30 实测）
//
// IGNORE 是一个**按路径删除**的黑名单。写宽了就把依赖的代码删掉，而构建照样
// 报"成功"：实测已发布 v2.4.3 的 app.asar 里，@modelcontextprotocol/sdk 的
// 677 个文件只剩 3 个（package.json / README / LICENSE），ajv 缺 337/466，
// hono 缺 559/562 —— `prune` 认为它们是生产依赖要留着，黑名单却把内容删了。
// 这种包内依赖树不自洽的产物，只有真正 `require` 到它的那一刻才炸，
// 而那时用户已经装上了。
//
// # 判据
//
// 对 asar 里出现的每个包（有 package.json 的），把它声明的入口（main / exports
// 的 '.' 条件导出）解析成相对路径，然后要求 at least one 候选**真的在包里**；
// 一个都不在就判违规。不猜语义、不看体积，只问"你说你有入口，那个文件在哪"。
//
// 用法（也可单独跑）：
//   node scripts/verify_asar.cjs "dist/AI Browser-darwin-arm64/AI Browser.app"
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 在给定目录里找 app.asar（mac 是 Contents/Resources，win/linux 是 resources）。 */
function findAsar(dir) {
  const direct = [
    path.join(dir, 'Contents', 'Resources', 'app.asar'),
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, 'app.asar'),
  ].find((p) => fs.existsSync(p));
  if (direct) return direct;
  // 兜底：向下找两层（packager 的外层目录里套着 .app / 应用目录）
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name === 'app.asar') return full;
      if (e.isDirectory() && depth < 3) stack.push({ d: full, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * 把 package.json 的入口声明解析成相对路径候选（去掉 './' 前缀）。
 *
 * 必须**递归**条件导出：`exports['.']` 既可能是字符串，也可能是
 * `{node:{require,import}}` 这种嵌套条件对象（pkce-challenge 就是），
 * 只取一层会把一个完全正常的包报成"缺入口"。
 */
function entryCandidates(pkg) {
  const out = [];
  const norm = (v) => String(v).replace(/^\.\//, '').replace(/^\/+/, '');
  const walk = (v, depth) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') { out.push(norm(v)); return; }
    if (typeof v !== 'object') return;
    for (const k of ['node', 'require', 'import', 'default', 'browser']) {
      if (v[k] !== undefined) walk(v[k], depth + 1);
    }
  };
  if (typeof pkg.main === 'string') out.push(norm(pkg.main));
  const ex = pkg.exports;
  if (typeof ex === 'string') out.push(norm(ex));
  else if (ex && typeof ex === 'object') {
    const dot = ex['.'] !== undefined ? ex['.'] : null;
    walk(dot, 0);
  }
  return [...new Set(out)].filter(Boolean);  // "" / undefined 不算入口
}

/**
 * @param {string} target 打包产物目录（.app 或 win 的便携目录）
 * @param {{sourceNodeModules?: string}} [opts] 源 node_modules（默认 <cwd>/node_modules）
 * @returns {{ok:boolean, asar:string|null, checked:number, typesOnly:number, violations:Array, skippedReason?:string}}
 *
 * 两条判据，都必须与**源 node_modules 对照**才准：
 *   A. 声明了入口（main / exports '.'）、源目录里确实有、包里却没有 → 是我们删的。
 *      反过来"源里也没有"是包自己的事（实测 @modelcontextprotocol/sdk 1.29 声明了
 *      dist/cjs/index.js 但根本没发这个文件，我们只走子路径导入，报它就是误报）。
 *   B. 内容塌缩：源里有 N 个运行时文件，包里剩不到一半 → 被黑名单删掉一大片。
 *      这条专门对付历史事故那种形态（677 个文件只剩 3 个），而且不依赖入口声明。
 */
function verifyAsarDeps(target, opts = {}) {
  let asarMod = null;
  try {
    asarMod = require('@electron/asar');
  } catch (_) {
    return { ok: true, asar: null, checked: 0, typesOnly: 0, violations: [], skippedReason: '缺少 @electron/asar，跳过校验' };
  }

  const srcNM = opts.sourceNodeModules || path.join(process.cwd(), 'node_modules');
  const asarPath = findAsar(target);
  if (!asarPath) {
    return { ok: false, asar: null, checked: 0, typesOnly: 0, violations: [{ pkg: '(app.asar)', entry: '找不到 app.asar', why: '' }] };
  }

  const entries = new Set(asarMod.listPackage(asarPath).map((p) => p.replace(/^\//, '')));

  // 与 Node 的解析规则一致：无扩展名要试 .js/.json/.node，目录要退到 index.*
  const SUFFIX = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
  const asarHas = (rel) => {
    for (const sfx of SUFFIX) {
      if (entries.has(rel + sfx)) return true;
      const prefix = rel + sfx + '/';
      for (const e of entries) if (e.startsWith(prefix)) return true;
    }
    return false;
  };
  const toSrc = (rel) => path.join(srcNM, rel.replace(/^node_modules\//, ''));
  const srcHas = (rel) => {
    for (const sfx of SUFFIX) {
      if (fs.existsSync(toSrc(rel + sfx))) return true;
    }
    return false;
  };

  // 运行时文件数（.js/.cjs/.mjs/.node）—— 只数代码，不数 README/类型声明，
  // 否则"删掉代码但留下文档"这种形态会被平均数掩盖。
  const isRuntime = (p) => /\.(js|cjs|mjs|node)$/.test(p);
  const asarRuntimeCount = (pkgDir) => {
    let n = 0;
    const prefix = pkgDir + '/';
    for (const e of entries) if (e.startsWith(prefix) && isRuntime(e)) n++;
    return n;
  };
  const srcRuntimeCount = (pkgDir) => {
    const base = toSrc(pkgDir);
    let n = 0;
    const stack = [base];
    while (stack.length) {
      const d = stack.pop();
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (isRuntime(e.name)) n++;
      }
    }
    return n;
  };

  const violations = [];
  let checked = 0;
  let typesOnly = 0;
  const pkgJsonPaths = [...entries].filter((p) => /^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(p));
  for (const pj of pkgJsonPaths) {
    const pkgDir = pj.slice(0, -'/package.json'.length);
    const pkgName = pkgDir.replace(/^node_modules\//, '');
    checked++;
    let meta = null;
    try {
      meta = JSON.parse(asarMod.extractFile(asarPath, pj).toString('utf8'));
    } catch (_) {
      violations.push({ pkg: pkgName, entry: '(package.json 无法解析)', why: '' });
      continue;
    }

    // A：入口文件被我们删了
    const cands = entryCandidates(meta);
    if (cands.length) {
      const inSrc = cands.some((c) => srcHas(pkgDir + '/' + c));
      const inAsar = cands.some((c) => asarHas(pkgDir + '/' + c));
      if (inSrc && !inAsar) {
        violations.push({ pkg: pkgName, entry: cands.join(' | '), why: '入口在 node_modules 里有，没进包' });
      } else if (!cands.length) {
        typesOnly++;
      }
    } else {
      typesOnly++;   // 没声明根入口（纯类型包 / 只暴露子路径）：无根入口可验
    }

    // B：内容塌缩
    const sc = srcRuntimeCount(pkgDir);
    const ac = asarRuntimeCount(pkgDir);
    if (sc >= 5 && ac < sc * 0.5) {
      violations.push({ pkg: pkgName, entry: '运行时文件 ' + ac + '/' + sc, why: '被删掉一大半' });
    }
  }

  return { ok: violations.length === 0, asar: asarPath, checked, typesOnly, violations, skippedReason: undefined };
}

/** 供构建脚本调用：违规就抛，附上前 10 条便于当场定位。 */
function assertAsarDeps(target) {
  const r = verifyAsarDeps(target);
  if (r.skippedReason) {
    console.log(`[verify] ${r.skippedReason}`);
    return r;
  }
  const rel = r.asar ? path.relative(process.cwd(), r.asar) : '(未找到)';
  if (r.ok) {
    console.log(`[verify] asar 依赖自洽：${r.checked} 个包，入口与内容都对得上 node_modules（其中 ${r.typesOnly} 个无根入口，按规则跳过）（${rel}）`);
    return r;
  }
  const head = r.violations.slice(0, 10).map((v) => `  - ${v.pkg} → ${v.entry}${v.why ? '  [' + v.why + ']' : ''}`).join('\n');
  throw new Error(
    `asar 里有 ${r.violations.length} 个依赖缺入口文件（声明了入口但包里没有）：\n${head}`
    + '\n这通常是 IGNORE 黑名单写宽了（按目录名删到了依赖自己的产物目录）。'
    + '\n检查 scripts/build_*.cjs 的 IGNORE：顶层目录名必须用 ^ 锚死。'
  );
}

module.exports = { findAsar, entryCandidates, verifyAsarDeps, assertAsarDeps };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('用法: node scripts/verify_asar.cjs <产物目录>');
    process.exit(2);
  }
  try {
    assertAsarDeps(path.resolve(target));
  } catch (e) {
    console.error('[verify] FAILED: ' + e.message);
    process.exit(1);
  }
}
