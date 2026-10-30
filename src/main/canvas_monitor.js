// main/canvas_monitor.js — canvas 绘制调用的有界存储与聚合（纯逻辑，不依赖 Electron）
//
// 数据流：页面 main world 的 hook（canvas_hook_source.js）通过
// window[bindingName](payload) 回传 { v, nav, frame, calls: [...] }，
// 主进程在 CDP 的 Runtime.bindingCalled 里收到后调用 ingest()。
//
// 有界是硬要求：canvas 密集的页面（游戏、图表）每帧几十次调用，不设上限
// 会直接把内存吃光。超出时淘汰最旧的记录，并在 dropped_calls 里如实累计。

const MAX_CALLS_PER_TAB = 5000;
const MAX_BYTES_PER_TAB = 4 * 1024 * 1024;

// kind → 可读性。2D 能给语义；WebGL 拿不到业务语义，必须诚实标记。
// 出现这些 kind 就说明这个 canvas 走的是 2D 上下文
const r2dKinds = new Set(['text', 'rect', 'clear', 'image', 'path', 'pixel']);

function readabilityFor(kind) {
  if (kind === '2d') return 'semantic';
  if (kind === 'webgl' || kind === 'webgl2') return 'opaque';
  return 'partial';
}

function approxBytes(rec) {
  try {
    return JSON.stringify(rec).length;
  } catch {
    return 64;
  }
}

class TabCanvasState {
  constructor(mode) {
    this.mode = mode || 'semantic';
    this.hookInstalled = false;
    this.warnings = [];
    this.seq = 0;
    this.calls = []; // { seq, rec }
    this.bytes = 0;
    this.droppedCalls = 0;
    this.canvases = new Map(); // id -> { id, kind, firstSeq, lastSeq, calls, kindLocked }
  }
}

export class CanvasMonitor {
  constructor(opts = {}) {
    this.maxCalls = Number(opts.maxCalls) || MAX_CALLS_PER_TAB;
    this.maxBytes = Number(opts.maxBytes) || MAX_BYTES_PER_TAB;
    this.tabs = new Map();
  }

  _tab(tabId) {
    let st = this.tabs.get(tabId);
    if (!st) {
      st = new TabCanvasState(this.defaultMode || 'semantic');
      this.tabs.set(tabId, st);
    }
    return st;
  }

  setDefaultMode(mode) {
    if (mode === 'off' || mode === 'semantic' || mode === 'trace') this.defaultMode = mode;
  }

  markHook(tabId, installed, warnings) {
    const st = this._tab(tabId);
    st.hookInstalled = !!installed;
    if (Array.isArray(warnings) && warnings.length) {
      for (const w of warnings) if (!st.warnings.includes(w)) st.warnings.push(w);
    }
  }

  setMode(tabId, mode) {
    const st = this._tab(tabId);
    if (mode === 'off' || mode === 'semantic' || mode === 'trace') st.mode = mode;
    return st.mode;
  }

  getMode(tabId) {
    return this.tabs.get(tabId) ? this.tabs.get(tabId).mode : (this.defaultMode || 'semantic');
  }

  /**
   * 接收一次 flush 的上报。
   * @returns {{accepted:number, dropped:number}} 便于调用方观测
   */
  ingest(tabId, payload) {
    const st = this._tab(tabId);
    if (!payload || !Array.isArray(payload.calls)) return { accepted: 0, dropped: 0 };
    let accepted = 0;
    let dropped = 0;
    for (const rec of payload.calls) {
      if (!rec || typeof rec !== 'object') continue;
      const canvasId = typeof rec.c === 'string' ? rec.c : 'canvas:unknown';
      const kind = typeof rec.k === 'string' && (rec.k === 'text' || rec.k === 'image') ? rec.k : null;
      // kind 由 hook 在 wrapGetContext 时上报（m:getContext, k:'2d'/'webgl'）
      let cv = st.canvases.get(canvasId);
      if (!cv) {
        cv = { id: canvasId, kind: 'unknown', firstSeq: st.seq + 1, lastSeq: st.seq + 1, calls: 0 };
        st.canvases.set(canvasId, cv);
      }
      // kind 推断：优先认 getContext 记录；但那条不一定录到（实测首帧就可能没有），
      // 因此再从调用本身反推 —— 出现过 2D 绘制类调用就一定是 2D canvas。
      if (rec.m === 'getContext' && (rec.k === '2d' || rec.k === 'webgl' || rec.k === 'webgl2')) {
        cv.kind = rec.k;
      } else if (cv.kind === 'unknown') {
        if (r2dKinds.has(rec.k)) cv.kind = '2d';
        else if (rec.k === 'gl' || (typeof rec.m === 'string' && rec.m.indexOf('gl') === 0)) cv.kind = 'webgl';
      }
      cv.lastSeq = st.seq + 1;
      cv.calls += 1;

      st.seq += 1;
      st.calls.push({ seq: st.seq, rec });
      st.bytes += approxBytes(rec);
      accepted += 1;
      void kind;
    }
    // 有界：先按条数，再按字节
    while (st.calls.length > this.maxCalls) {
      const gone = st.calls.shift();
      st.bytes -= approxBytes(gone.rec);
      st.droppedCalls += 1;
      dropped += 1;
    }
    while (st.bytes > this.maxBytes && st.calls.length) {
      const gone = st.calls.shift();
      st.bytes -= approxBytes(gone.rec);
      st.droppedCalls += 1;
      dropped += 1;
    }
    return { accepted, dropped };
  }

  /**
   * 只丢抓取到的**数据**，保留该 tab 的配置（mode / hook / warnings）。
   * `canvas_configure{clear:true}` 走这里 —— 它要的是"从零开始记"，
   * 不是"顺手把我刚设的 mode 也忘掉"。
   */
  clear(tabId) {
    const st = this.tabs.get(tabId);
    if (!st) return { cleared_calls: 0 };
    const n = st.calls.length;
    st.calls = [];
    st.bytes = 0;
    st.droppedCalls = 0;
    st.canvases = new Map();
    return { cleared_calls: n };
  }

  /**
   * 彻底忘掉一个 tab（关 tab 时调用）。与 clear 的区别：
   * 连 mode / hookInstalled / warnings 一起丢，并把 tabs 里的条目**删掉**。
   *
   * 为什么必须删条目：这个 Map 没有任何淘汰上限，而此前关 tab 只清数据、
   * 留一个空 state 对象 —— 每关一页就多一条，长会话下无界累积（TODO 里
   * "关掉的 tab 保留 canvas 抓取状态"指的就是这里）。之后 list/read 会按需重建，
   * 行为不变。
   */
  forget(tabId) {
    const had = this.tabs.delete(tabId);
    return { forgotten: !!had };
  }

  /** 列出该 tab 的 canvas。 */
  list(tabId) {
    const st = this._tab(tabId);
    const canvases = [];
    for (const cv of st.canvases.values()) {
      canvases.push({
        canvas_id: cv.id,
        kind: cv.kind,
        readability: readabilityFor(cv.kind),
        calls_retained: cv.calls,
        first_retained_seq: cv.firstSeq,
        last_seq: cv.lastSeq,
      });
    }
    canvases.sort((a, b) => a.canvas_id.localeCompare(b.canvas_id));
    return {
      canvases,
      retention: {
        calls: st.calls.length,
        bytes: st.bytes,
        max_calls: this.maxCalls,
        max_bytes: this.maxBytes,
        dropped_calls: st.droppedCalls,
      },
      mode: st.mode,
      hook_installed: st.hookInstalled,
      warnings: st.warnings.slice(),
    };
  }

  /**
   * 读取某个 canvas 的内容。
   * view='summary' 给出 texts[] / regions[]；view='calls' 给原始调用明细。
   */
  read(tabId, opts = {}) {
    const st = this._tab(tabId);
    const canvasId = opts.canvasId;
    const view = opts.view === 'calls' ? 'calls' : 'summary';
    const sinceSeq = Number.isFinite(opts.sinceSeq) ? opts.sinceSeq : 0;
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);

    let rows = st.calls.filter((e) => e.seq > sinceSeq);
    if (canvasId) rows = rows.filter((e) => e.rec && e.rec.c === canvasId);
    const raw = rows.slice(0, limit);

    const cv = canvasId ? st.canvases.get(canvasId) : null;
    const kind = cv ? cv.kind : (rows.length && rows[0].rec.k === 'text' ? '2d' : 'unknown');

    const out = {
      canvas_id: canvasId || null,
      kind,
      readability: readabilityFor(kind),
      mode: st.mode,
      hook_installed: st.hookInstalled,
      pagination: {
        returned: raw.length,
        next_seq: raw.length ? raw[raw.length - 1].seq : null,
        has_more: rows.length > raw.length,
      },
      warnings: st.warnings.slice(),
    };

    if (view === 'calls') {
      out.calls = raw.map((e) => ({ seq: e.seq, ...e.rec }));
      out.texts = null;
      out.regions = null;
      return out;
    }

    const texts = [];
    const regions = [];
    for (const e of raw) {
      const r = e.rec;
      if (r.k === 'text') {
        texts.push({
          seq: e.seq,
          method: r.m,
          text: r.t == null ? '' : String(r.t),
          truncated: !!r.tt,
          full_length: typeof r.tl === 'number' ? r.tl : null,
          bounds_canvas: r.b || null,
          style: r.st || null,
        });
      } else if (r.k === 'rect' || r.k === 'clear' || r.k === 'image' || r.k === 'path' || r.k === 'pixel') {
        regions.push({
          seq: e.seq,
          kind: r.k,
          method: r.m,
          bounds_canvas: r.b || null,
          source: r.s || null,
          pixels_captured: false,
        });
      }
    }
    out.texts = texts;
    out.regions = regions;
    out.calls = null;
    if (kind === 'webgl' || kind === 'webgl2') {
      out.warnings = out.warnings.concat([
        'WebGL canvas: 只有绘制次数/shader/buffer 等结构信息，无法还原业务语义（文字常是 glyph atlas）',
      ]);
    }
    if (regions.length) {
      out.warnings = out.warnings.concat([
        'regions are draw bounds, not proven interactive hit regions',
      ]);
    }
    return out;
  }
}

/**
 * 环境变量开关，默认**开启**。关闭：AI_BROWSER_CANVAS_HOOK=0（或 off/false/no）。
 *
 * 注意：hook 只能在页面首次加载**完成之后**安装（CDP 的 await 命令在刚创建的
 * tab 上会挂死），所以首屏已经画完的内容拿不回来 —— 需要完整历史就用
 * ui.canvas_configure({ reload: true })。
 */
export function isCanvasHookEnabled(envValue) {
  if (typeof envValue !== 'string') return true;
  const v = envValue.trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export default CanvasMonitor;
