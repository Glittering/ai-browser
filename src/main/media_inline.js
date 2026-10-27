// main/media_inline.js — 让"能看的东西"直接显示，而不是掉进下载目录
//
// 判据在 shared/media_doc.cjs（那里写了为什么是 Content-Type 白名单）。
// 这个模块只负责把它接到 Electron 的响应链上，并且记住"哪个 tab 刚刚
// 被救回来一张可显示的主框架文档" —— 工具条据此显示「下载」按钮。
//
// # 为什么用 onHeadersReceived 而不是 will-download 里拦
//
// will-download 时下载**已经决定**了：只能整体取消（然后自己重新取一遍再塞进
// 页面），多一次往返、丢认证上下文的风险全靠自己兜。而 Content-Disposition
// 正是在 onHeadersReceived 之后才参与"MIME 嗅探 / 下载判定"的 ——
// 在这里把 attachment 摘掉，Chromium 就会按 image/png 正常显示，走的是浏览器
// 原本的路径，没有任何自行其是的地方。
//
// # 约束
// - 只处理 `resourceType === 'mainFrame'`：子资源本来就是按类型渲染的，
//   摘子资源的头纯属多余，还会把"另存为图片"的行为一起改掉。
// - 只摘 attachment，**不改 Content-Type**。站点把 png 说成 octet-stream 时，
//   改类型去强行渲染，坏了就是一片碎图；那种情况让它下载才是可靠的。
// - 处理不过来就原样放行：这个钩子在任何异常下都不能吞掉响应。
import mediaDoc from '../shared/media_doc.cjs';

const MAX_REMEMBER = 32;

export class MediaInline {
  constructor(opts = {}) {
    this.session = opts.session || null;
    this._resolveTab = opts.resolveTab || (() => undefined);
    this._onMedia = opts.onMedia || (() => {});
    // tabId -> { url, mime, kind, at }：最近一次"被救回来"的主框架文档。
    // 工具条只在**当前页就是它**时才显示下载按钮，所以这里存最近一次即可。
    this._byTab = new Map();
    this._installed = false;
    this.stats = { seen: 0, inlined: 0 };
  }

  install(session) {
    if (session) this.session = session;
    if (this._installed || !this.session || typeof this.session.webRequest !== 'object') return;
    this._installed = true;
    try {
      this.session.webRequest.onHeadersReceived(
        { urls: ['*://*/*'], resourceType: ['mainFrame'] },
        (details, callback) => {
          let out = null;
          try {
            out = this._maybeInline(details);
          } catch (_) {
            out = null;              // 判据出错就放行，绝不吞响应
          }
          callback(out || {});
        }
      );
    } catch (_) {
      // 装不上只是回到"图片被下载"的旧行为，不该让启动失败。
      this._installed = false;
    }
  }

  _maybeInline(details) {
    this.stats.seen++;
    const headers = details.responseHeaders;
    if (!mediaDoc.shouldRenderInline(headers)) return null;

    const stripped = mediaDoc.stripDisposition(headers);
    if (!stripped.changed) return null;

    const mime = mediaDoc.mimeOf(headers);
    const tab = this._resolveTab(details.webContentsId);
    if (tab !== undefined && tab !== null) {
      const rec = {
        tab,
        url: details.url,
        mime,
        kind: mediaDoc.kindOf(mime),
        at: Date.now(),
      };
      this._byTab.set(tab, rec);
      if (this._byTab.size > MAX_REMEMBER) {
        const oldest = this._byTab.keys().next();
        if (!oldest.done) this._byTab.delete(oldest.value);
      }
      try { this._onMedia(rec); } catch (_) { /* UI 更新失败不影响这次响应 */ }
    }
    this.stats.inlined++;
    return { responseHeaders: stripped.headers };
  }

  /**
   * 这个 tab 当前显示的是不是一份"被救回来的"文档。
   * 只在**地址也对得上**时才认：用户从图片页再往下点，旧的记录必须失效，
   * 否则工具条会挂着一个对当前页毫无意义的下载按钮。
   */
  recordOf(tab, currentUrl) {
    const rec = this._byTab.get(tab);
    if (!rec) return null;
    const cur = String(currentUrl || '');
    if (cur && cur !== rec.url) return null;
    return rec;
  }

  forget(tab) { this._byTab.delete(tab); }
  clearAll() { this._byTab.clear(); }
}
