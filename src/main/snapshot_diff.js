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
 * the caller needs NO per-site knowledge. It walks elements that carry meaning
 * (role/label/value/checked/placeholder) and records them by a positional path,
 * so a caller can diff "what the page offers" without writing any JS.
 *
 * Runs through CDP Runtime.evaluate, so it is not subject to page CSP.
 * Wrapped in try/catch returning {__error} — a throwing snapshot must be
 * reportable, not silently empty (an empty snapshot would diff as "unchanged",
 * which is the most dangerous possible failure here).
 */
export const DEFAULT_SNAPSHOT_JS = `(function(){
  try {
    var out = { url: location.href, title: document.title, nodes: {} };
    var all = document.querySelectorAll(
      'a,button,input,textarea,select,option,[role],[aria-label],[contenteditable="true"],canvas,img'
    );
    var n = 0;
    for (var i = 0; i < all.length && n < 1500; i++) {
      var e = all[i];
      var r = e.getBoundingClientRect();
      var cs = null;
      try { cs = getComputedStyle(e); } catch (_) {}
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
      // Skip zero-size boxes: collapsed/hidden-by-layout nodes otherwise show up
      // as phantom "removed/added" churn across diffs.
      if (r.width < 1 && r.height < 1 && e.tagName !== 'CANVAS') continue;
      var label = e.getAttribute('aria-label')
        || (e.labels && e.labels[0] && e.labels[0].textContent)
        || (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? e.getAttribute('placeholder') : '')
        || (e.textContent || '').trim().slice(0, 60);
      var val = null;
      if ('value' in e) { try { val = String(e.value).slice(0, 120); } catch (_) {} }
      else if ('checked' in e) { try { val = !!e.checked; } catch (_) {} }
      var key = e.tagName.toLowerCase() + '#' + i + (e.id ? '#' + e.id : '');
      out.nodes[key] = {
        t: e.tagName.toLowerCase(),
        r: (e.getAttribute('role') || ''),
        l: String(label || '').slice(0, 80),
        v: val,
        d: e.disabled === true ? 1 : 0,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      n++;
    }
    out.count = n;
    // Whole-page visible text, whitespace-normalised.
    //
    // Needed because the element walk above only covers elements that CARRY
    // meaning (role / label / value / canvas / img). Plenty of real pages put
    // their actual state in a plain <div> — a status line, a result count, a
    // "idle"→"clicked" readout — and a semantic-element diff would report
    // "unchanged" while the thing the user cares about had changed. Verified by
    // construction: without this, clicking a button that rewrites a <div>
    // produced verdict=unchanged.
    try {
      var txt = (document.body && (document.body.innerText || document.body.textContent)) || '';
      // Collapse runs of whitespace so line wrapping / layout jitter does not
      // read as a content change.
      txt = txt.replace(/\\s+/g, ' ').trim();
      out.text = txt.slice(0, 4000);
      out.textLen = txt.length;
    } catch (_) {}
    return out;
  } catch (e) {
    return { __error: String(e && e.message || e) };
  }
})()`;