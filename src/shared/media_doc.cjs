// shared/media_doc.cjs — 「这条响应到底该显示，还是该下载」
//
// # 为什么需要它（2026-10-27 用户报"点证书下载 → 正在打开… → 一坨 png 链接"）
//
// 沧州教师继续教育网的证书地址回的是：
//   Content-Type: image/png
//   Content-Disposition: attachment;filename=<uuid>.png
// 站点用新标签打开它，于是 Electron 把它当下载处理 —— **导航永远不会提交**，
// 那个标签就停在 loading.html「正在打开…」上，把 URL 明晃晃地摆着；
// 文件本身倒是落盘了，但落在 ~/.ai-browser/downloads/<tab>/ 里，界面上没有任何回执。
//
// 唯一的"别扭"源头是：**能看的东西被当成文件丢进了黑洞**。所以这里给出
// 一个纯函数判据 —— 主框架响应只要（a）浏览器能直接渲染，（b）服务端挂了
// attachment，就把 attachment 摘掉，让它按内容类型正常显示。
//
// 为什么按**内容类型白名单**而不是按 URL 后缀：后缀是站点随口写的，
// `?id=123`、`.do`、`.ashx` 到处都是；Content-Type 才是浏览器的判据。
// 白名单只收"人眼能直接看"的四类，其余（zip/dmg/exe/docx/xlsx…）保持下载，
// 这是浏览器的既有语义，不该被我们改写。
//
// 刻意**不含** text/plain、application/json、text/csv：
// 它们技术上能内联，但实践中"点导出"的语义就是"给我文件"，
// 把 CSV 铺满一屏反而是帮倒忙。

/** 可以直接在标签页里显示的主框架内容类型。 */
const RENDERABLE = [
  /^image\/[a-z0-9.+-]+$/i,
  /^video\/[a-z0-9.+-]+$/i,
  /^audio\/[a-z0-9.+-]+$/i,
  /^application\/pdf$/i,
];

// application/octet-stream 永不视为可显示：站点把 png 说成二进制流时，
// 改 Content-Type 去强行渲染，坏了就是一片碎图 —— 下载反而是可靠的那条路。

/**
 * 在 Electron 的 responseHeaders（Record<string, string[]>）里按名字取值。
 * 键名大小写由服务端决定（`Content-Disposition` / `content-disposition` 都见过），
 * 所以必须不区分大小写地找。
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() !== want) continue;
    const v = headers[k];
    if (Array.isArray(v)) return v.length ? String(v[0]) : '';
    return v === undefined || v === null ? '' : String(v);
  }
  return '';
}

/** `image/png;charset=UTF-8` → `image/png`。没有 Content-Type 时给空串。 */
function mimeOf(headers) {
  const raw = headerValue(headers, 'content-type');
  if (!raw) return '';
  return raw.split(';')[0].trim().toLowerCase();
}

/**
 * 主框架内容的处置方式：'attachment' | 'inline' | 'none'。
 * 没有 Content-Disposition 就是 'none'（浏览器按内容类型自己决定）。
 */
function dispositionOf(headers) {
  const raw = headerValue(headers, 'content-disposition').toLowerCase();
  if (!raw) return 'none';
  if (raw.indexOf('attachment') === 0) return 'attachment';
  if (raw.indexOf('inline') === 0) return 'inline';
  // `form-data; name="file"` 这种出现在响应头里是没有意义的，别当成 attachment。
  return 'none';
}

function isRenderableMime(mime) {
  if (!mime) return false;
  return RENDERABLE.some((re) => re.test(mime));
}

/** 这份主框架响应该不该被"救回来"直接显示。 */
function shouldRenderInline(headers) {
  return isRenderableMime(mimeOf(headers)) && dispositionOf(headers) === 'attachment';
}

/**
 * 去掉 Content-Disposition，返回**新对象**（不改入参：Electron 可能缓存，
 * 原地改动在重试/缓存命中时表现不一致）。第二个返回值表示是否真的改了。
 */
function stripDisposition(headers) {
  if (!headers || typeof headers !== 'object') return { headers, changed: false };
  const out = {};
  let changed = false;
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === 'content-disposition') { changed = true; continue; }
    out[k] = headers[k];
  }
  return { headers: changed ? out : headers, changed };
}

/** 展示用分类，决定结果页画缩略图还是图标。 */
function kindOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('video/') === 0) return 'video';
  if (m.indexOf('audio/') === 0) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  return 'file';
}

/** 562KB / 1.2MB / 3.4GB —— 结果页和回执都只用到这一种写法。 */
function humanSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  return s + units[i];
}

/** 这个 URL 是不是我们自己的"正在打开…"占位页（file:///…/loading.html?url=…）。 */
function isPlaceholderUrl(url) {
  return /\/renderer\/loading\.html(\?|$)/.test(String(url || ''));
}

/** 占位页 query 里带的目标地址（用于核对"这次下载是不是这个 tab 存在的理由"）。 */
function placeholderTarget(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  if (i < 0) return '';
  try {
    const q = new URLSearchParams(s.slice(i + 1));
    return q.get('url') || '';
  } catch (_) {
    return '';
  }
}

/** 这个 URL 是不是我们自己的界面页（download/loading/error_page）。 */
function isChromePageUrl(url) {
  return /^file:\/\/.*\/renderer\/(download|loading|error_page|error_banner|tab_bar)\.html/.test(String(url || ''));
}

module.exports = {
  headerValue,
  mimeOf,
  dispositionOf,
  isRenderableMime,
  shouldRenderInline,
  stripDisposition,
  kindOf,
  humanSize,
  isPlaceholderUrl,
  placeholderTarget,
  isChromePageUrl,
};
