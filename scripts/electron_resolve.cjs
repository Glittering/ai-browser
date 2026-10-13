// scripts/electron_resolve.cjs — resolve a runnable Electron binary, self-healing.
//
// Why this exists (2026-10-13, npm 11 + Node 26):
//
// ① npm 11 blocks dependency install scripts by default. The `electron`
//    package's postinstall (install.js) is what downloads the ~100 MB Chromium
//    binary and writes path.txt. With the script blocked — the default for
//    plain `npm install`, `npm install -g`, and `npx` on npm >= 11 —
//    require('electron') throws "Electron failed to install correctly".
//    Making the postinstall a hard requirement would break every MCP client's
//    `npx -y @glittering0717/ai-browser mcp`.
//
// ② Even when install.js runs, its extract-zip/yauzl pipeline silently
//    truncates on Node 26 (observed: 21 of 255 entries, exit code 0, no
//    Frameworks/). The zip itself is fine. So after the official installer we
//    VERIFY the result and, if incomplete, re-extract the already-downloaded
//    cached zip with the platform's native archiver, which preserves symlinks
//    and permissions (ditto/unzip/bsdtar).
//
// Strategy (same idea as Playwright's on-demand browser download): detect the
// missing binary on first launch, let electron's installer download, then make
// extraction reliable. ELECTRON_MIRROR is honored by the download step, so
// users on slow networks can point it at a mirror exactly like the git path.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Return the absolute path to the Electron binary, running electron's bundled
 * installer first if the binary is missing.
 *
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]  sink for progress lines (stderr-safe)
 * @returns {string} absolute path to the electron executable
 */
function resolveElectronBinary(opts = {}) {
  const log = opts.log || ((m) => console.error(m));

  const direct = tryReadElectronPath();
  if (direct) return direct;

  // Locate the electron package alongside this package. It may be hoisted to
  // a parent node_modules — require.resolve walks the same chain Node uses.
  let electronDir;
  let electronVersion;
  try {
    const pkgJsonPath = require.resolve('electron/package.json');
    electronDir = path.dirname(pkgJsonPath);
    electronVersion = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  } catch (e) {
    throw new Error(
      'the "electron" package is not installed — the @glittering0717/ai-browser ' +
      'installation is incomplete. Reinstall the package. Underlying error: ' + e.message
    );
  }

  const installer = path.join(electronDir, 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(
      `electron's installer is missing (${installer}) — the package install is corrupt. ` +
      'Reinstall @glittering0717/ai-browser.'
    );
  }

  log('[ai-browser] Electron binary missing (npm 11+ skips dependency install scripts by default).');
  log('[ai-browser] Preparing the Electron engine now (~100 MB download, once). Slow network? Set:');
  log('[ai-browser]   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/');

  const env = { ...process.env };
  // If we ourselves are running under an Electron-as-Node shim, the installer
  // would run with the wrong runtime. Not present in real-user shells.
  delete env.ELECTRON_RUN_AS_NODE;

  // Step 1: electron's own installer — downloads the zip and (usually) extracts.
  const result = spawnSync(process.execPath, [installer], {
    cwd: electronDir,
    stdio: 'inherit',
    env,
  });

  if (result.error) throw new Error(`failed to run the Electron installer: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `Electron installer exited with code ${result.status}. ` +
      'If the download from GitHub releases is blocked/slow, retry with ' +
      'ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ set in the environment.'
    );
  }

  // Step 2: verify. extract-zip can silently leave a partial app bundle.
  let resolved = tryReadElectronPath();
  if (!resolved || !installLooksComplete(electronDir)) {
    log('[ai-browser] The official installer left a partial app bundle (known extract-zip issue on newer Node).');
    log('[ai-browser] Re-extracting with the native system archiver…');
    nativeReextract({ electronDir, electronVersion, env, log });
    resolved = tryReadElectronPath();
  }

  if (!resolved || !installLooksComplete(electronDir)) {
    throw new Error(
      'could not prepare a runnable Electron binary under ' +
      path.join(electronDir, 'dist') +
      '. Check network access (or set ELECTRON_MIRROR) and disk space, then retry.'
    );
  }
  return resolved;
}

/**
 * Mirror electron/index.js without throwing: read path.txt and verify the
 * binary actually exists. Returns null when the install is incomplete.
 */
function tryReadElectronPath() {
  try {
    const electronDir = path.dirname(require.resolve('electron/package.json'));
    const pathFile = path.join(electronDir, 'path.txt');
    if (!fs.existsSync(pathFile)) return null;
    const executable = fs.readFileSync(pathFile, 'utf8').trim();
    if (!executable) return null;
    const full = process.env.ELECTRON_OVERRIDE_DIST_PATH
      ? path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executable)
      : path.join(electronDir, 'dist', executable);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

/**
 * Platform-specific completeness checks. The launcher binary existing is not
 * enough — on macOS the multi-hundred-MB framework lives under Frameworks/.
 */
function installLooksComplete(electronDir) {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(dist, 'Electron.app', 'Contents', 'Frameworks'));
  }
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(dist, 'electron.exe')) && fs.existsSync(path.join(dist, 'resources'));
  }
  return fs.existsSync(path.join(dist, 'electron')) && fs.existsSync(path.join(dist, 'resources'));
}

/**
 * Find the zip @electron/get just downloaded. Layout (v2 get):
 *   <cacheRoot>/<sha>/electron-v<version>-<platform>-<arch>.zip
 * cacheRoot honors electron_config_cache (what install.js itself reads), then
 * the per-OS env-paths default.
 */
function findCachedZip(version) {
  const roots = [];
  if (process.env.electron_config_cache) roots.push(process.env.electron_config_cache);
  if (process.env.ELECTRON_CACHE) roots.push(process.env.ELECTRON_CACHE);
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
  else if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'));
  else roots.push(path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron'));

  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  // Mirror install.js: x64 darwin under Rosetta should use arm64.
  if (platform === 'darwin' && arch === 'x64' && process.env.npm_config_arch === undefined) {
    try {
      const r = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim() === '1') arch = 'arm64';
    } catch { /* assume x64 */ }
  }
  const wanted = `electron-v${version}-${platform}-${arch}.zip`;

  const hits = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    walk(root, (file) => {
      if (path.basename(file) === wanted) {
        try { hits.push({ file, mtime: fs.statSync(file).mtimeMs }); } catch { /* race */ }
      }
    });
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.file || null;
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

/**
 * Re-extract the cached zip with a native archiver into electron/dist and
 * write the path.txt electron/index.js expects.
 */
function nativeReextract({ electronDir, electronVersion, env, log }) {
  const zip = findCachedZip(electronVersion);
  if (!zip) {
    throw new Error(
      'the Electron zip was not found in the download cache — the download step did not complete. ' +
      'Check the network (or set ELECTRON_MIRROR) and retry.'
    );
  }

  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', env });
    if (r.error) throw new Error(`${cmd} is not available: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`${cmd} failed with exit code ${r.status}`);
  };

  if (process.platform === 'darwin') {
    // ditto preserves symlinks (Electron Framework.framework/Versions/Current)
    // and executable bits; it is the canonical macOS zip tool.
    run('ditto', ['-x', '-k', zip, dist]);
  } else if (process.platform === 'win32') {
    // bsdtar ships built-in on Windows 10+ and handles zip.
    run('tar', ['-xf', zip, '-C', dist]);
  } else {
    // Prefer unzip; fall back to bsdtar where unzip is absent.
    try {
      run('unzip', ['-q', '-o', zip, '-d', dist]);
    } catch (e) {
      log(`[ai-browser] unzip unavailable (${e.message}), trying tar…`);
      run('tar', ['-xf', zip, '-C', dist]);
    }
  }

  const subPath = process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron';
  fs.writeFileSync(path.join(electronDir, 'path.txt'), subPath);
}

module.exports = { resolveElectronBinary, tryReadElectronPath };
