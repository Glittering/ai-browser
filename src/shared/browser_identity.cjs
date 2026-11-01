// shared/browser_identity.cjs — 浏览器身份的唯一来源：UA、UA-CH 元数据、域名开关表。
//
// 为什么要有这个文件（2026-11-01 实测）：UA 之前写死成 macOS 的 Chrome/130，
// 而 navigator.platform=Win32、sec-ch-ua-platform="Windows"、WebGL 走的是
// Windows 的 D3D11 —— 三处互相打脸。风控看到的不是"这是个 Mac 浏览器"，
// 而是"这个浏览器的 UA 被改过"。改 UA 本来是为了藏自动化指纹，结果它自己
// 成了最响的指纹。
//
// 这里的规矩只有一条：**所有身份字段由同一个函数按真实运行时算出来**。
// 版本不撒谎（chromeVersion 就是内核的 Chromium 版本），平台不撒谎，
// 品牌列表和 UA 字符串同源。这样 header 与页面内 JS 读到的永远一致。
'use strict';

// 内核版本号在纯 Node（单测）里拿不到 process.versions.chrome，兜底值必须和
// package.json 里的 Electron 大版本对得上，否则单测和生产会测两套东西。
const FALLBACK_CHROME_VERSION = '130.0.0.0';

// UA 里的平台 token 与 UA-CH 的 platform 名必须成对出现：
// Chrome/130 在 Windows 上发的就是这两行，抄错一个字符就是新的矛盾。
const PLATFORMS = {
  win32: { uaToken: 'Windows NT 10.0; Win64; x64', chPlatform: 'Windows' },
  darwin: { uaToken: 'Macintosh; Intel Mac OS X 10_15_7', chPlatform: 'macOS' },
  linux: { uaToken: 'X11; Linux x86_64', chPlatform: 'Linux' },
};

// UA-CH 的 architecture 用的是 CPU 家族名，不是 Node 的 process.arch：
// x64 在 Chrome 里报 "x86"（64 位由 bitness 表达），arm64 报 "arm"。
const ARCHITECTURE = { x64: 'x86', ia32: 'x86', arm64: 'arm', arm: 'arm' };

function chromeFullVersion(runtime) {
  const v = runtime && runtime.chrome;
  return typeof v === 'string' && v.length > 0 ? v : FALLBACK_CHROME_VERSION;
}

function osRelease() {
  try {
    return require('node:os').release();
  } catch (_) {
    return '';
  }
}

function majorOf(fullVersion) {
  const head = String(fullVersion).split('.')[0];
  return /^\d+$/.test(head) ? head : '0';
}

/** Windows 的 UA-CH platformVersion 是 NT 版本（10.0.x 与 11 都是 "10.0.0"）。 */
function platformVersionOf(platform, release) {
  const parts = String(release || '').split('.');
  if (platform === 'win32') return `${parts[0] || '10'}.0.0`;
  if (platform === 'darwin') {
    // Darwin 内核版本 → macOS 市场版本（Darwin 24 = macOS 15）；只拿得到大版本，
    // 就报大版本，不要编一个小版本号出来。
    const major = Number(parts[0]) - 9;
    return `${major > 0 ? major : 10}.0.0`;
  }
  return release ? String(release) : '';
}

/**
 * 按真实运行时算出整套身份。入参全部可注入（单测不依赖 Electron）。
 * @returns {{userAgent:string, metadata:object, chromeVersion:string, chromeMajor:string, platform:string}}
 */
function buildIdentity(opts = {}) {
  const platformKey = opts.platform || process.platform;
  const plat = PLATFORMS[platformKey] || PLATFORMS.linux;
  const chromeVersion = opts.chromeVersion || chromeFullVersion(process.versions);
  const major = majorOf(chromeVersion);
  const userAgent = opts.userAgent ||
    `Mozilla/5.0 (${plat.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

  // AI_BROWSER_UA 给了自定义 UA 时，UA-CH 的 platform 跟着**UA 里写的平台**走。
  // 否则自定义 UA 与 sec-ch-ua-platform 会各说一套 —— 那正是这次要修的病。
  const overridePlat = Object.keys(PLATFORMS).find((k) => userAgent.includes(PLATFORMS[k].uaToken));
  const chPlatform = overridePlat ? PLATFORMS[overridePlat].chPlatform : plat.chPlatform;
  const chPlatformKey = overridePlat || platformKey;

  // 品牌顺序里 GREASE 那一项必须留在内核自己报的那个值上（Chromium 130 = "99"）。
  // 它是随内核版本冻结的，编一个别的名或号都会和 sec-ch-ua 的正常值不一致。
  const grease = { brand: 'Not?A_Brand', version: '99' };
  return {
    userAgent,
    chromeVersion,
    chromeMajor: major,
    platform: chPlatform,
    metadata: {
      brands: [grease, { brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }],
      fullVersionList: [
        { brand: 'Not?A_Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: chromeVersion },
        { brand: 'Google Chrome', version: chromeVersion },
      ],
      mobile: false,
      platform: chPlatform,
      // 内核版本（os.release()）而不是"市场版本"：Chrome 在 Windows 上发的
      // platformVersion 就是 NT 版本，Win10/Win11 都是 10.0.0。
      platformVersion: platformVersionOf(chPlatformKey, opts.release || osRelease()),
      architecture: ARCHITECTURE[opts.arch || process.arch] || 'x86',
      model: '',
    },
  };
}

// === 域名开关表 ===
// canvas hook、window.open 垫片这类"改页面原生 API"的能力，代价是站点一行
// Function.prototype.toString 就能看见。所以它们默认**不开**，并且支持三种写法：
//   off / 0 / 空          → 全关
//   on / 1 / all          → 全开
//   a.com,b.chaoxing.com  → 只在这些域（含子域）开
function parseHostSwitch(value) {
  const raw = (value === undefined || value === null) ? '' : String(value).trim();
  if (!raw) return { mode: 'off', hosts: [] };
  const low = raw.toLowerCase();
  if (low === '0' || low === 'off' || low === 'false' || low === 'no') return { mode: 'off', hosts: [] };
  if (low === '1' || low === 'on' || low === 'true' || low === 'yes' || low === 'all') return { mode: 'all', hosts: [] };
  return { mode: 'hosts', hosts: raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) };
}

/** host 命中列表要求是**后缀相等**：`a.com` 命中 `x.a.com`，不命中 `xa.com`。 */
function hostMatches(host, list) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return (list || []).some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * **默认开**的开关：没设置 → 开；`0/off/false/no` → 关；其余 → 开。
 *
 * 和 parseHostSwitch 的区别是缺省值：那条给"改了页面原生 API 的能力"用，
 * 默认必须关；这条给"补上本该有的东西"用（UA-CH header），默认应该开，
 * 关它只为了二分定位"这个站点的问题是这层造成的吗"。
 */
function isEnabledByDefault(envValue) {
  if (envValue === undefined || envValue === null) return true;
  const raw = String(envValue).trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

/**
 * UA-CH 的三个 critical client hints，按 Chrome 的 header 形状序列化。
 *
 * 为什么还要手工补这一层（2026-11-01 实测）：Electron 33 的**文档导航请求**
 * 根本不发 sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform，而同源的页面内
 * fetch 会发。逐条排除过的可能：
 *   - 不是 setUserAgent 造成的：什么都不覆盖（基线）也没有这三个头；
 *   - 不是元数据没给：CDP `Network.setUserAgentOverride` 带上 userAgentMetadata
 *     之后 `navigator.userAgentData.brands` 立刻多出 `Google Chrome`（证明元数据
 *     进了内核），导航头依旧为空；`Emulation.setUserAgentOverride` 同样无效，
 *     先 `Network.enable` 再覆盖也无效；
 *   - 是真差异：同一台机器上的 Chrome 156 无头访问同一个 echo 服务，
 *     文档导航请求里三个头齐全。
 * 所以这一层在内核里补不上，只能在主进程的请求出口补。值仍然由**同一份
 * metadata** 算出来，不会出现"UA 说一套、header 说另一套"。
 * 只在缺失时补 —— Blink 自己会发的请求（XHR/fetch/子资源）保持内核的输出。
 */
function uaClientHintsOf(metadata) {
  const md = metadata || {};
  const fmt = (list) => (list || []).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  return {
    'sec-ch-ua': fmt(md.brands),
    'sec-ch-ua-mobile': md.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${md.platform || ''}"`,
  };
}

/**
 * Accept-Language 的首选语言列表，**不带 q 值**：`zh-CN` → `zh-CN,zh`。
 *
 * 为什么要管这一条：实测本浏览器发的是 `zh-CN`（一个值），页面里
 * `navigator.languages` 却是 `["zh-CN","zh-Hans-CN"]` —— header 和 JS 对不上，
 * 而真 Chrome 两边是同一条链算出来的。又是一处"改过痕迹"。
 *
 * ⚠️ 为什么不能写成 `zh-CN,zh;q=0.9`：CDP 的 `Network.setUserAgentOverride`
 * 只有**一个** acceptLanguage 字段，内核把这一条字符串同时喂给两处 ——
 * 请求头（它自己会在最后一项后面补 `;q=0.9`）和 `navigator.languages`
 * （原样拆成数组）。带上 q 的写法实测产出：
 *   header  → `zh-CN,zh;q=0.9;q=0.9`（q 叠了两层）
 *   languages → `["zh-CN","zh;q=0.9"]`（一个带分号的假 BCP47 标签，
 *              任何页面脚本 `lang.split('-')` 都会拿到 `zh;q=0.9`）
 * 不带 q 时两边各归各位：header 由内核补成 `zh-CN,zh;q=0.9`，languages 是
 * 干净的 `["zh-CN","zh"]` —— 正好是真 Chrome 的形状。
 */
function acceptLanguageOf(locale) {
  const base = String(locale || '').trim().replace(/_/g, '-');
  if (!base) return '';
  const primary = base.split('-')[0].toLowerCase();
  if (!primary || primary === base.toLowerCase()) return `${base},en`;
  return `${base},${primary}`;
}

module.exports = {
  buildIdentity,
  parseHostSwitch,
  hostMatches,
  isEnabledByDefault,
  acceptLanguageOf,
  uaClientHintsOf,
  platformVersionOf,
  chromeFullVersion,
  majorOf,
  FALLBACK_CHROME_VERSION,
};
