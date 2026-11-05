// shared/browser_identity.cjs — 浏览器身份的唯一来源：UA、UA-CH 元数据、域名开关表。
//
// 为什么要有这个文件（2026-11-01 实测）：UA 之前写死成 macOS 的 Chrome/130，
// 而 navigator.platform=Win32、sec-ch-ua-platform="Windows"、WebGL 走的是
// Windows 的 D3D11 —— 三处互相打脸。风控看到的不是"这是个 Mac 浏览器"，
// 而是"这个浏览器的 UA 被改过"。改 UA 本来是为了藏自动化指纹，结果它自己
// 成了最响的指纹。
//
// 这里的规矩有两条：**所有身份字段由同一个函数按真实运行时算出来**，以及
// **不许说一句自己兑现不了的话**（最贵的一句是"我是 Google Chrome"）。
// 版本不撒谎（chromeVersion 就是内核的 Chromium 版本），平台不撒谎，
// 品牌列表和 UA 字符串同源。这样 header 与页面内 JS 读到的永远一致。
//
// 2026-11-05 追加的第二条规矩：**不许声称自己是 Google Chrome**。
// 实测（同一台机器、同一个账号、只输邮箱就停）：
//   - UA 写成纯 Chrome（`… Chrome/130.0.0.0 Safari/537.36`）、brands 带
//     "Google Chrome" → Google 登录页判 `/v3/signin/rejected?rrk=46`；
//   - 同上但 brands 只报 Chromium → 还是 rrk=46（UA 仍然"是 Chrome"）；
//   - UA 里带上自家产品 token（`ai-browser/2.5.2 Chrome/130.0.0.0`）、brands 只报
//     Chromium → 直接进密码步（`/v3/signin/challenge/pwd`）。
// 读法：Google 对"声称是 Chrome 的浏览器"要 Chrome 浏览器层的自证（`window.chrome`
// 那几个 Gaia 绑定），Electron 壳给不出，于是拒绝；而一个**明说自己不是 Chrome** 的
// 浏览器走的是普通流程。冒名越像，判得越死 —— 这和"字段互相打脸"是同一类错误的两个面。
// 所以 UA 必须带产品 token（Edge 带 `Edg/`、Vivaldi 带 `Vivaldi/`，都是这个道理），
// 品牌列表默认只报 Chromium。想复现旧形状做对照：AI_BROWSER_BRANDS=chrome。
'use strict';

// 产品 token 进 UA。版本取自 package.json（唯一来源），读不到就不加 token ——
// 宁可少一段，也不要编一个版本号。
function productToken() {
  try {
    const pkg = require('../../package.json');
    const v = pkg && pkg.version;
    return v ? `ai-browser/${v}` : '';
  } catch (_) {
    return '';
  }
}

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

// bitness 是"指针宽度"，与 architecture（CPU 家族）是两条独立的轴：
// Chrome 在 64 位 Windows 上报 architecture="x86" + bitness="64"，实测读数为证。
const BITNESS = { x64: '64', arm64: '64', ia32: '32', arm: '32' };

// GREASE 品牌表：见 buildIdentity 里那段说明 —— 只收实测过的内核大版本。
const GREASE_BRANDS = {
  130: { brand: 'Not?A_Brand', version: '99' },
  156: { brand: 'Not:A-Brand', version: '8' },
};

/** 已知内核大版本 → 它的 GREASE 品牌；表里没有就返回 null（让内核自己算）。 */
function greaseFor(major) {
  return GREASE_BRANDS[String(major)] || null;
}

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
 *
 * 一条**只用于二分定位**的口子（默认不改变任何行为）：
 *   - claimedVersion / AI_BROWSER_CHROME_VERSION：把"声称的内核版本"换成别的值。
 *       它同时改掉 UA major、brands、fullVersionList 三处 —— 必须同源，否则测出来
 *       的结论会被"自相矛盾"污染，而不是回答"站点是不是按版本号做的决定"。
 *       `chromeVersion` 仍然报**真实**内核版本，诊断口不许跟着撒谎。
 *   - brands / AI_BROWSER_BRANDS=chrome：**重新**声明 "Google Chrome" 品牌（旧形状）。
 *       默认不声明。这条存在的唯一用途是复现"冒名 Chrome"那一组对照实验 ——
 *       Google 登录在这个形状下必被拒（rrk=46），别在线上打开。
 *   - product / AI_BROWSER_PRODUCT_TOKEN：UA 里的产品 token（默认 ai-browser/<版本>）。
 * @returns {{userAgent:string, metadata:object, chromeVersion:string, claimedVersion:string, chromeMajor:string, platform:string, brands_mode:string}}
 */
function buildIdentity(opts = {}) {
  const platformKey = opts.platform || process.platform;
  const plat = PLATFORMS[platformKey] || PLATFORMS.linux;
  const realVersion = opts.chromeVersion || chromeFullVersion(process.versions);
  const claimedVersion = opts.claimedVersion || process.env.AI_BROWSER_CHROME_VERSION || realVersion;
  const brandsMode = String(opts.brands || process.env.AI_BROWSER_BRANDS || '').trim().toLowerCase();
  // 默认只报 Chromium：我们是 Chromium 内核，这是真话；"Google Chrome" 是别人的品牌。
  const claimChromeBrand = brandsMode === 'chrome' || brandsMode === 'google-chrome';
  const major = majorOf(claimedVersion);
  const product = opts.product === undefined
    ? String(process.env.AI_BROWSER_PRODUCT_TOKEN || productToken() || '')
    : String(opts.product || '');
  const userAgent = opts.userAgent ||
    `Mozilla/5.0 (${plat.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `${product ? product + ' ' : ''}Chrome/${major}.0.0.0 Safari/537.36`;

  // AI_BROWSER_UA 给了自定义 UA 时，UA-CH 的 platform 跟着**UA 里写的平台**走。
  // 否则自定义 UA 与 sec-ch-ua-platform 会各说一套 —— 那正是这次要修的病。
  const overridePlat = Object.keys(PLATFORMS).find((k) => userAgent.includes(PLATFORMS[k].uaToken));
  const chPlatform = overridePlat ? PLATFORMS[overridePlat].chPlatform : plat.chPlatform;
  const chPlatformKey = overridePlat || platformKey;

  // 品牌顺序里 GREASE 那一项必须留在内核自己报的那个值上（Chromium 130 = "99"）。
  // 它是随内核版本冻结的，编一个别的名或号都会和 sec-ch-ua 的正常值不一致。
  // GREASE 品牌不是算出来的，是 Chromium **每个大版本冻结的一对字面量**，抄错就等于自己
  // 造一个矛盾（内核报 130 的形状、我们报 156 的，两头都能被站点读到）。表里两条都是**量**出
  // 来的：130 → Not?A_Brand;99（本机 Electron 33 不覆盖时的自报值）；156 → Not:A-Brand;8
  // （本机真 Chrome 156.0.8078.80 的 sec-ch-ua 头）。大版本不在表里（升了内核还没补表）就
  // **不下发 brands**，让内核自己算 —— 内核那份永远和 UA 同源，比我们猜一个值安全。
  const grease = greaseFor(major);
  const chromium = { brand: 'Chromium', version: major };
  const googleChrome = { brand: 'Google Chrome', version: major };
  const greaseFull = grease ? { brand: grease.brand, version: grease.version + '.0.0.0' } : null;
  const chromiumFull = { brand: 'Chromium', version: claimedVersion };
  const googleChromeFull = { brand: 'Google Chrome', version: claimedVersion };
  return {
    userAgent,
    chromeVersion: realVersion,
    claimedVersion,
    chromeMajor: major,
    // 诊断口径：brands/fullVersionList 是我们下发的，还是内核自己算的。
    brands_overridden: !!grease,
    // 诊断口径：品牌列表里有没有冒名 "Google Chrome"。线上必须是 'chromium'。
    brands_mode: claimChromeBrand ? 'chrome' : 'chromium',
    // 诊断口径：UA 里的产品 token。空串 = 这条 UA 在自称"纯 Chrome"（Google 会按
    // Chrome 的自证标准判），自定义 AI_BROWSER_UA 时最容易踩到。
    product,
    platform: chPlatform,
    metadata: {
      brands: grease ? (claimChromeBrand ? [grease, chromium, googleChrome] : [grease, chromium]) : undefined,
      fullVersionList: grease ? (claimChromeBrand
        ? [greaseFull, chromiumFull, googleChromeFull]
        : [greaseFull, chromiumFull]) : undefined,
      mobile: false,
      platform: chPlatform,
      // 内核版本（os.release()）而不是"市场版本"：Chrome 在 Windows 上发的
      // platformVersion 就是 NT 版本，Win10/Win11 都是 10.0.0。
      platformVersion: platformVersionOf(chPlatformKey, opts.release || osRelease()),
      architecture: ARCHITECTURE[opts.arch || process.arch] || 'x86',
      // 下面四项是 2026-11-05 实测补的：真 Chrome 在同一台机器上被 Accept-CH
      // 授权后一共上 11 个 sec-ch-ua* 头，我们只有 3 个 —— 缺的正是这几项对应的
      // 高熵头。元数据里没这几项，出口那一层就**无法**把它们补成和页面 JS 一致的值。
      // （CDP 的 userAgentMetadata 接受这些字段：实测 Chromium 130 照收，
      // 收下去之后 navigator.userAgentData.getHighEntropyValues 也报同一套。）
      bitness: BITNESS[opts.arch || process.arch] || '64',
      wow64: false,
      // formFactors **故意不给**（2026-11-05 实测）：元数据里写 ['Desktop'] 之后，出口那层
      // 会照它发 `sec-ch-ua-form-factors: "Desktop"`，而页面里
      // `navigator.userAgentData.getHighEntropyValues(['formFactors'])` 读回来是 **[]**
      // —— 内核压根没把这一项供给 JS。头说 Desktop、JS 说空数组，这就是一处新的自相矛盾，
      // 比"少一个头"响得多。等内核哪天两边一起报，再把这一项加回来。
      // 同一个坑的其它项都验过：architecture / bitness / fullVersionList / model / wow64 /
      // platformVersion 页面读回来的值与这里逐字段相等。
      fullVersion: claimedVersion,
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
  const out = {};
  // brands 缺（内核大版本不在 GREASE 表里，元数据交给内核自己算）时**不发**这一项：
  // 发一个空 sec-ch-ua 比不发更响，等于把"我们不知道自己的品牌"写在请求上。
  if (md.brands && md.brands.length) out['sec-ch-ua'] = fmt(md.brands);
  out['sec-ch-ua-mobile'] = md.mobile ? '?1' : '?0';
  out['sec-ch-ua-platform'] = `"${md.platform || ''}"`;
  return out;
}

/**
 * 高熵 UA-CH 头（服务端用 Accept-CH 授权之后才许发的那一批）。
 *
 * 为什么这一份必须存在（2026-11-05 实测）：同一台机器、同一个 Chromium 156 ——
 * 真 Chrome 在拿到 `Accept-CH: Sec-CH-UA-Arch, ...` 授权后的请求里带 **11** 个
 * sec-ch-ua* 头；Electron 无论用 CDP 下发多完整的 userAgentMetadata 都只带 **3** 个。
 * 发高熵头的那段代码在 Chrome 浏览器层（components/embedder_support 的 UA-CH 管理器
 * + Accept-CH 缓存），Electron 没带它 —— 所以内核这条路是死的，只能在请求出口补。
 *
 * 每个值都取自 config.identity.metadata，与 UA、navigator.userAgentData 同源：
 * 补出去的头和页面里读到的必须是同一套数字，否则修好一个矛盾又造出一个矛盾。
 *
 * @param {object} metadata buildIdentity().metadata
 * @returns {Object<string,string>} 头名 → 值（Chrome 的引号/?0?1 形状）
 */
function highEntropyClientHintsOf(metadata) {
  const md = metadata || {};
  const fmt = (list) => (list || []).map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
  const out = {};
  if (md.architecture) out['sec-ch-ua-arch'] = `"${md.architecture}"`;
  if (md.bitness) out['sec-ch-ua-bitness'] = `"${md.bitness}"`;
  if (md.fullVersion) out['sec-ch-ua-full-version'] = `"${md.fullVersion}"`;
  if (md.fullVersionList && md.fullVersionList.length) out['sec-ch-ua-full-version-list'] = fmt(md.fullVersionList);
  // model 在桌面上就是空串，但**必须有这个头**：真 Chrome 带 `""`，缺头本身就是差异。
  if (typeof md.model === 'string') out['sec-ch-ua-model'] = `"${md.model}"`;
  out['sec-ch-ua-wow64'] = md.wow64 ? '?1' : '?0';
  if (md.platformVersion) out['sec-ch-ua-platform-version'] = `"${md.platformVersion}"`;
  // form-factors 多个值用 "; " 分隔（UA-CH 规范），桌面只有一个。
  if (md.formFactors && md.formFactors.length) out['sec-ch-ua-form-factors'] = md.formFactors.map((f) => `"${f}"`).join('; ');
  return out;
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
  highEntropyClientHintsOf,
  platformVersionOf,
  chromeFullVersion,
  majorOf,
  greaseFor,
  GREASE_BRANDS,
  FALLBACK_CHROME_VERSION,
};
