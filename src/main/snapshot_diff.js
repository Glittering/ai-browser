// main/snapshot_diff.js — structural diff for ui.snapshot / ui.diff.
//
// Kept in its own module (not inside page_manager) so the diff logic can be
// unit-tested in plain Node with no Electron — which matters, because the diff
// IS the thing that decides "did my action actually do anything". A bug here
// silently turns every verification into a false green.
//
// Design notes:
//  - Arrays are compared **element-wise by index**, not as sets. Workflow graphs
//    (ComfyUI's app.graph._nodes, React Flow's nodes array) are order-sensitive
//    in ways callers care about, and set-diffing would hide a moved node behind
//    "removed + added", which reads as if two things happened when one did.
//  - Every changed entry carries `path`, `from`, `to` so a caller can check the
//    REASON, not just that some byte moved.
//  - Output is capped. An un-capped diff of a big page can be megabytes, which
//    would blow the agent's context instead of informing it.

export const DIFF_MAX_ENTRIES = 200;

// Cap on how many snapshot baselines are kept alive at once.
export const SNAPSHOT_MAX = 50;

/**
 * Drop oldest-inserted entries from a Map until it holds at most `max`.
 *
 * Map preserves insertion order and callers re-insert an entry when they use it,
 * so this evicts least-recently-USED. Lives here rather than inline in
 * page_manager because a bug in it would silently discard a baseline an agent
 * still needs, and that surfaces much later as "unknown-snapshot" — far from
 * the cause. Kept pure so it is unit-testable without booting Electron.
 *
 * @returns {number} how many entries were dropped
 */
export function evictOldest(map, max = SNAPSHOT_MAX) {
  let dropped = 0;
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
    dropped++;
  }
  return dropped;
}

/**
 * Deep structural diff of two JSON-ish values.
 * @returns {{changed:boolean, added:Array, removed:Array, changed:Array, dropped:number}}
 */
export function diffValues(before, after) {
  const added = [];
  const removed = [];
  const changedArr = [];
  let dropped = 0;
  const cap = DIFF_MAX_ENTRIES;

  const push = (arr, entry) => {
    if (arr.length < cap) arr.push(entry); else dropped++;
  };

  const walk = (a, b, path) => {
    if (a === b) return;

    // NaN never equals itself; treat two NaNs as equal so a numeric field that
    // is NaN on both sides isn't reported as a change on every single diff.
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return;

    const ta = typeOf(a);
    const tb = typeOf(b);
    if (ta !== tb) {
      push(changedArr, { path, from: previewValue(a), to: previewValue(b), reason: 'type' });
      return;
    }

    if (ta === 'array') {
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        // Primitives keep their ORIGINAL value here (not the stringified
        // preview): callers routinely branch on added/removed payloads, e.g.
        // "was a node added?" or "was the count 13 or '13'?". Only objects and
        // arrays get summarised, because inlining their contents would blow up
        // the diff. Objects/arrays appear in `changed` via previewValue for the
        // same reason — a 300-key graph node must not land in the output.
        if (i >= a.length) push(added, { path: p, value: summarise(b[i]) });
        else if (i >= b.length) push(removed, { path: p, value: summarise(a[i]) });
        else walk(a[i], b[i], p);
      }
      return;
    }

    if (ta === 'object') {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      // Sort for deterministic output — otherwise the same logical diff can
      // come back in a different order each run, which makes it impossible to
      // eyeball "is this the same diff as last time?".
      for (const k of [...keys].sort()) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in a)) push(added, { path: p, value: summarise(b[k]) });
        else if (!(k in b)) push(removed, { path: p, value: summarise(a[k]) });
        else walk(a[k], b[k], p);
      }
      return;
    }

    // Primitives — compare with a tolerance for floats. A canvas pan produces
    // coordinates like 201354.48743718592 vs 201354.4874371859; reporting that
    // as a change is technically true and practically noise.
    if (typeof a === 'number' && typeof b === 'number') {
      if (nearlyEqual(a, b)) return;
      push(changedArr, { path, from: a, to: b, reason: 'value' });
      return;
    }
    push(changedArr, { path, from: previewValue(a), to: previewValue(b), reason: 'value' });
  };

  walk(before, after, '');
  return {
    // NOTE: do not name this `changed` — the list of changed entries below is
    // also called `changed`, and a duplicate key in an object literal silently
    // drops the boolean (the array wins). That bug made "identical values"
    // report changed:true, i.e. every diff would look like a change.
    hasChanges: added.length > 0 || removed.length > 0 || changedArr.length > 0,
    added,
    removed,
    changed: changedArr,
    dropped,
  };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function nearlyEqual(a, b) {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff === 0) return true;
  // Relative tolerance: exact for large magnitudes, forgiving for tiny ones.
  return diff <= Math.max(1e-9, Math.abs(a) * 1e-12, Math.abs(b) * 1e-12);
}

const MAX_PREVIEW = 120;

/**
 * Value renderer for added/removed entries: primitives keep their real type,
 * containers become a short structural summary. See the array branch above for
 * why the distinction matters.
 */
function summarise(v) {
  const t = typeOf(v);
  if (t === 'object' || t === 'array') return previewValue(v);
  if (t === 'string' && v.length > MAX_PREVIEW) return v.slice(0, MAX_PREVIEW) + '…';
  return v;
}

export function previewValue(v) {
  if (v === null || v === undefined) return v === null ? null : undefined;
  const t = typeOf(v);
  if (t === 'array') return `[${v.length} items]`;
  if (t === 'object') {
    const keys = Object.keys(v);
    const head = keys.slice(0, 4).join(',');
    return `{${keys.length} keys${head ? ': ' + head : ''}}`;
  }
  const s = String(v);
  return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW) + '…' : s;
}

export function previewOf(value) {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return null;
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch (e) {
    return null;
  }
}

export function safeByteLength(value) {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : Buffer.byteLength(s, 'utf8');
  } catch (e) {
    return -1;
  }
}

/**
 * Default snapshot expression: a site-agnostic structural summary of the page.
 *
 * Why a DOM summary and not something cleverer: the point of a default is that
 * the caller needs NO per-site knowledge. It walks the elements that carry
 * meaning (role/label/value/checked/placeholder) and records them, so a caller
 * can diff "what the page offers" without writing any JS.
 *
 * Runs through CDP Runtime.evaluate, so it is not subject to page CSP. Wrapped
 * in try/catch returning {__error}: a throwing snapshot must be REPORTABLE, not
 * silently empty — an empty snapshot diffs as "unchanged", which is the most
 * dangerous possible failure for this tool.
 *
 * Three properties are non-negotiable, each written after a measured failure:
 *
 * 1. ELEMENT KEYS COME FROM IDENTITY, NEVER FROM POSITION.
 *    The key used to be `tag#index`. Inserting one element at the top re-keyed
 *    every element below it — measured, one insertion read as
 *    `4 added + 3 removed + 3 changed` instead of `1 added`. Pages that prepend
 *    a notification bar / list row / lazily-loaded item (i.e. most pages) buried
 *    the real signal under a wall of noise. Keys are therefore derived from
 *    id / name / placeholder / href, and only when several elements share an
 *    identity does a second pass disambiguate — first by label (content, and
 *    stable under insertion), finally by occurrence order for genuinely
 *    interchangeable siblings. A unique identity is used as-is so that a label
 *    change reads as `changed` rather than `removed + added`.
 *
 * 2. THE TEXT FALLBACK IS FINGERPRINTED OVER ITS WHOLE LENGTH.
 *    The element walk only covers elements that carry meaning; plenty of pages
 *    put their real state in a plain <div> (a status line, a result count, an
 *    "idle"→"clicked" readout). Whole-page text is the fallback for that — but
 *    truncating it to 4000 chars left a hole: a SAME-LENGTH change past char
 *    4000 produced an identical `text` and an identical `textLen`, so the diff
 *    said "unchanged" while the page had changed. Measured: flipping a <div>
 *    from AAAA to BBBB beyond char 4000 → verdict=unchanged, while the same
 *    flip inside the first 4000 chars was caught. `textHash` (whole text) closes
 *    it; `textSegs` (capped per-chunk hashes) only localises WHERE it moved.
 *
 * 3. THE EXPRESSION STAYS LEAN.
 *    It is shipped to the page on every snapshot, and `ui.evaluate` refuses
 *    scripts over `EVAL_MAX_LENGTH` (5000) chars. The default is evaluated
 *    internally rather than through that guard, so it would not be *rejected* —
 *    but a default that no longer fits the documented eval contract is a trap
 *    for whoever later routes it through the guarded path. Rationale lives in
 *    this comment block, not inside the string; SD-031 pins the length.
 */
export const DEFAULT_SNAPSHOT_JS = `(function(){
  try {
    var out = { url: location.href, title: document.title, nodes: {} };
    var all = document.querySelectorAll(
      'a,button,input,textarea,select,option,[role],[aria-label],[contenteditable="true"],canvas,img'
    );
    var recs = [];
    for (var i = 0; i < all.length && recs.length < 1500; i++) {
      var e = all[i];
      var r = e.getBoundingClientRect();
      var cs = null;
      try { cs = getComputedStyle(e); } catch (_) {}
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
      if (r.width < 1 && r.height < 1 && e.tagName !== 'CANVAS') continue;
      var label = e.getAttribute('aria-label')
        || (e.labels && e.labels[0] && e.labels[0].textContent)
        || (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? e.getAttribute('placeholder') : '')
        || (e.textContent || '').trim().slice(0, 60);
      var val = null;
      if ('value' in e) { try { val = String(e.value).slice(0, 120); } catch (_) {} }
      else if ('checked' in e) { try { val = !!e.checked; } catch (_) {} }
      var tag = e.tagName.toLowerCase();
      recs.push({
        tag: tag,
        ident: e.id ? '#' + e.id
          : (e.getAttribute('name') ? '[name=' + e.getAttribute('name') + ']' : '')
          || (e.getAttribute('placeholder') ? '[ph=' + e.getAttribute('placeholder') + ']' : '')
          || (tag === 'a' ? '[' + String(e.getAttribute('href') || '').slice(0, 60) + ']' : ''),
        l: String(label || '').slice(0, 80),
        r: e.getAttribute('role') || '',
        v: val,
        d: e.disabled === true ? 1 : 0,
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    var cnt = {}, used = {};
    for (var b = 0; b < recs.length; b++) { var bo = recs[b].tag + recs[b].ident; cnt[bo] = (cnt[bo] || 0) + 1; }
    for (var j = 0; j < recs.length; j++) {
      var c = recs[j], t = c.tag + c.ident;
      var cand = (cnt[t] > 1 && c.l) ? t + '~' + c.l.slice(0, 40) : t;
      var key = cand, k = 1;
      while (used[key]) { key = cand + '#' + k++; }
      used[key] = 1;
      out.nodes[key] = { t: c.tag, r: c.r, l: c.l, v: c.v, d: c.d, w: c.w, h: c.h };
    }
    out.count = recs.length;
    try {
      var txt = (document.body && (document.body.innerText || document.body.textContent)) || '';
      txt = txt.replace(/\\s+/g, ' ').trim();
      var h32 = function (s) {
        var h = 5381;
        for (var p = 0; p < s.length; p++) h = ((h << 5) + h + s.charCodeAt(p)) | 0;
        return (h >>> 0).toString(36);
      };
      out.text = txt.slice(0, 4000);
      out.textLen = txt.length;
      out.textHash = h32(txt);
      var SEG = 1024, segs = [];
      for (var q = 0; q < 256 && q * SEG < txt.length; q++) segs.push(h32(txt.substr(q * SEG, SEG)));
      out.textSegs = segs;
    } catch (_) {}
    return out;
  } catch (e) {
    return { __error: String(e && e.message || e) };
  }
})()`;