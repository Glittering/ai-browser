// main/download_monitor.js — 让"点导出"真的落盘，并且 agent 找得到文件。
//
// # 为什么需要它（2026-10-12 审计发现）
// src/ 里没有任何 `will-download` 处理器。Electron 的默认行为是**取消下载**：
// agent 点"导出 CSV"，ui.act 返回 success，然后什么都没有发生 —— 又一处
// `success ≠ 做成了`，而且比动作失败更隐蔽，因为连错误都没有。
//
// # 设计约束
// 1. 落盘路径必须**可预期**：`<userData>/downloads/<tabId>/<文件名>`，可用
//    AI_BROWSER_DOWNLOAD_DIR 覆盖。随机临时目录对 agent 没用 —— 它得能告诉用户
//    "文件在这儿"。
// 2. 每个 tab 独立子目录：多 tab 并发导出时不会互相覆盖，也能按 tab 清理。
// 3. 状态机完整：progressing → completed / cancelled / interrupted。
//    只记 completed 会在"下载到一半被取消"时给 agent 一个不存在的文件。
// 4. 关应用要清空：与 _snapshots 同理，长会话不能无限累积。
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../shared/config.js';

const MAX_RECORDS_PER_TAB = 200;

export class DownloadMonitor {
  constructor(session, opts = {}) {
    this.session = session;
    this.baseDir = opts.dir || process.env.AI_BROWSER_DOWNLOAD_DIR
      || path.join(config.userDataDir, 'downloads');
    // tabId -> Map<downloadId, record>（Map 保序，便于"最近的在后面"）
    this._byTab = new Map();
    this._seq = 0;
    this._broadcast = opts.broadcast || (() => {});
    // 下载**开始**时的钩子（不是 done）：调用方据此判断"这个 tab 是不是就为了
    // 这次下载而开的"—— 那种 tab 永远等不到导航提交，会一直停在占位页上。
    this._onStart = opts.onStart || null;
    this._installed = false;
  }

  install() {
    if (this._installed || !this.session || typeof this.session.on !== 'function') return;
    this._installed = true;
    // ⚠️ 第三个参数才是发起下载的 webContents。漏掉它就没办法把下载归属到 tab，
    // 于是所有记录都落到 'unknown' 下，而按 tab 查询（ui.downloads 的默认行为）
    // 会返回空 —— 表现就是"下载明明发生了却查不到"。
    this.session.on('will-download', (_event, item, webContents) => this._onWillDownload(item, webContents));
  }

  _onWillDownload(item, webContents) {
    const tabId = this._tabIdOf(item, webContents);
    const id = 'dl-' + (++this._seq);
    // 文件名要净化：站点可能给出含路径分隔符或 `..` 的名字，直接拼会写到目录外。
    const raw = String(item.getFilename() || 'download');
    const safe = path.basename(raw).replace(/[\u0000-\u001f"*/:<>?\\|]/g, '_') || 'download';
    const dir = path.join(this.baseDir, String(tabId));
    const savePath = path.join(dir, safe);

    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 落盘失败在下面体现 */ }
    item.setSavePath(savePath);

    const rec = {
      id,
      tab: tabId,
      filename: safe,
      path: savePath,
      url: item.getURL(),
      mime: item.getMimeType(),
      total_bytes: item.getTotalBytes(),
      received_bytes: 0,
      state: 'progressing',
      started_at: new Date().toISOString(),
    };
    this._push(tabId, rec);
    if (typeof this._onStart === 'function') {
      // 这个钩子绝不能拖垮下载本身：它只做 UI 接管，出错就当地不存在。
      try { this._onStart(rec, tabId); } catch (_) { /* ignore */ }
    }

    item.on('updated', (_e, state) => {
      rec.received_bytes = item.getReceivedBytes();
      rec.total_bytes = item.getTotalBytes();
      // 'progressing' 是唯一值得反复推的状态；interrupted 会紧跟一个 done。
      if (state === 'interrupted') rec.state = 'interrupted';
    });
    item.on('done', (_e, state) => {
      rec.received_bytes = item.getReceivedBytes();
      rec.total_bytes = item.getTotalBytes();
      rec.state = state;                       // completed | cancelled | interrupted
      rec.finished_at = new Date().toISOString();
      if (state === 'completed') {
        // 报告"文件在哪儿"才是终点。setSavePath 之后 Electron 可能因重名改名，
        // 所以用回读的 getSavePath()，而不是我们自己拼的那个。
        rec.path = item.getSavePath() || savePath;
        rec.filename = path.basename(rec.path);
      }
      this._broadcast('download', { ...rec });
    });
  }

  /**
   * 决定这条下载归属哪个 tab。
   *
   * webContents 来自 will-download 的第三个参数（**不是** item.webContents ——
   * DownloadItem 上并没有可靠的公开属性）。由 PageManager 注入解析器做
   * webContents → tabId。查不到就归到 'unknown' —— **不能因此丢掉记录**，
   * 丢掉就等于回到"静默失败"，那正是这个模块要消灭的东西。
   */
  _tabIdOf(item, webContents) {
    const wc = webContents || (item && item.webContents) || null;
    try {
      if (typeof this._resolveTab === 'function') {
        const t = this._resolveTab(wc);
        if (t !== undefined && t !== null) return t;
      }
    } catch (_) { /* ignore */ }
    return 'unknown';
  }

  _push(tabId, rec) {
    if (!this._byTab.has(tabId)) this._byTab.set(tabId, new Map());
    const m = this._byTab.get(tabId);
    m.set(rec.id, rec);
    while (m.size > MAX_RECORDS_PER_TAB) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }

  list(tabId) {
    if (tabId === undefined || tabId === null) {
      const all = [];
      for (const m of this._byTab.values()) for (const r of m.values()) all.push(r);
      return { ok: true, downloads: all, dir: this.baseDir };
    }
    const m = this._byTab.get(tabId);
    return { ok: true, downloads: m ? Array.from(m.values()) : [], dir: this.baseDir };
  }

  clearTab(tabId) {
    this._byTab.delete(tabId);
  }

  clearAll() {
    this._byTab.clear();
  }
}
