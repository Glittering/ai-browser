// main/capability_probe.js — answer "how should an agent operate THIS page?"
//
// Promoted from tools/_oneoff/page_capability_probe.cjs after it reproduced,
// on two very different real pages, conclusions that had taken hours of manual
// investigation to reach. What transfers between sites is not site knowledge
// ("how do you connect nodes in React Flow") — it is the *decision procedure*:
//
//   1. Is the graph DOM or <canvas>?        → decides whether the semantic tree
//                                            can see it at all
//   2. Is the body inside an iframe? Same
//      origin?                              → decides whether frame routing is
//                                            needed to act on it
//   3. Does the app hang its own object off
//      window (graph/_nodes/serialize/…)?  → decides whether a structured-data
//                                            path exists (by far the best one)
//   4. Which JSON endpoints did it call?    → decides whether read/verify can go
//                                            through an API
//
// and one action discipline that is not site-specific: every write must be
// proven by reading state back (see snapshot_diff.js / ui.diff).
//
// The route recommendation is a *recommendation*, not an oracle: it names
// candidates and the evidence for each, so the caller can judge semantics.

const APP_KEY_RE = /^(app|editor|graph|store|canvas|workspace|comfy|litegraph|monaco|codemirror|diagram|flow|rh|state|editorState|doc|documentModel)$/i;

// Globals worth reporting when they look like a graph/document model.
// Kept as substrings so `myGraphStore` / `canvasApp` also match — exact
// allow-listing missed real ones before.
const HINTS = [
  ['graph', 'v.graph'], ['_nodes', 'v._nodes'], ['nodes', 'v.nodes'],
  ['getState', 'typeof v.getState'], ['serialize', 'typeof v.serialize'],
  ['loadGraphData', 'typeof v.loadGraphData'], ['queuePrompt', 'typeof v.queuePrompt'],
];

const PROBE_JS = `(function(){
  try {
    var APP_RE = ${JSON.stringify(APP_KEY_RE.source)};
    var re = new RegExp(APP_RE, 'i');
    var out = { url: location.href, title: document.title, topDom: 0,
                topCanvas: 0, iframes: [], globals: [], canvases: [] };

    try { out.topDom = document.querySelectorAll('*').length; } catch(e){}
    try { out.topCanvas = document.querySelectorAll('canvas').length; } catch(e){}
    try {
      Array.prototype.forEach.call(document.querySelectorAll('canvas'), function(c, i){
        var r = c.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) return;
        out.canvases.push({ index: i, w: Math.round(r.width), h: Math.round(r.height),
                            cls: String(c.className || '').slice(0, 40) });
      });
    } catch(e){}

    function scan(W, tag) {
      if (!W) return;
      var keys;
      try { keys = Object.keys(W); } catch(e) { return; }
      keys.forEach(function(k) {
        if (!re.test(k)) return;
        var v;
        try { v = W[k]; } catch(e) { return; }
        var t = (v === null ? 'null' : typeof v);
        var hint = null;
        try {
          if (v && (typeof v === 'object' || typeof v === 'function')) {
            var probes = ${JSON.stringify(HINTS)};
            for (var i = 0; i < probes.length; i++) {
              var expr = probes[i][1];
              // eslint-disable-next-line no-new-func
              var fn = new Function('v', 'return (' + expr + ');');
              var r = fn(v);
              if (r !== undefined && r !== null && r !== false) {
                hint = probes[i][0] + (typeof r === 'object' ? ' (' + (Array.isArray(r) ? r.length + ' items' : 'obj') + ')' : '');
                break;
              }
            }
            if (!hint) hint = Object.keys(v).slice(0, 8).join(',');
          }
        } catch(e) {}
        if (out.globals.length < 40) out.globals.push({ where: tag, key: k, type: t, hint: hint });
      });
    }

    scan(window, 'top');
    Array.prototype.forEach.call(document.querySelectorAll('iframe'), function(f, i) {
      var rec = { index: i, src: (f.getAttribute('src') || '').slice(0, 80),
                  sameOrigin: false, innerElements: 0, innerCanvas: 0, innerButtons: 0 };
      try {
        var d = f.contentDocument;
        if (d && d.body) {
          rec.sameOrigin = true;
          rec.innerElements = d.querySelectorAll('*').length;
          rec.innerCanvas = d.querySelectorAll('canvas').length;
          rec.innerButtons = d.querySelectorAll('button,[role=button]').length;
          scan(d.defaultView, 'iframe[' + i + ']');
        }
      } catch(e) {}
      try {
        var r = f.getBoundingClientRect();
        rec.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      } catch(e) {}
      out.iframes.push(rec);
    });
    return out;
  } catch (e) {
    return { __error: String(e && e.message || e) };
  }
})()`;

/**
 * @param {PageManager} pageManager
 * @param {object} opts { tab, include_network, network_limit }
 */
export async function probeCapabilities(pageManager, opts = {}) {
  const tid = opts.tab !== undefined && opts.tab !== null ? opts.tab : pageManager.activeTab;
  const view = pageManager._getView(tid);
  if (!view) return { ok: false, error: 'no-such-tab', tab: tid };

  // 1. Semantic tree — the single most informative signal. A page whose whole UI
  //    is canvas shows up as a tiny tree; that is the tell.
  let tree = null;
  try {
    const res = await pageManager.getTree(false, tid);
    tree = res && res.tree;
  } catch (e) { /* getTree timeout on a busy page must not kill the probe */ }

  const flat = [];
  (function walk(n) {
    if (!n) return;
    flat.push(n);
    (n.children || []).forEach(walk);
  })(tree);

  const roles = {}, actions = {};
  for (const n of flat) {
    const r = n.role || '(none)';
    roles[r] = (roles[r] || 0) + 1;
    for (const a of (n.actions || [])) actions[a] = (actions[a] || 0) + 1;
  }

  // 2/3. In-page probe: canvas, iframes, app globals.
  let dom = null;
  try {
    dom = await pageManager.evaluate(PROBE_JS, tid);
  } catch (e) { dom = { __error: e && e.message ? e.message : String(e) }; }
  if (dom && dom.__error) dom = null;

  // 4. JSON-ish endpoints the page already called.
  let endpoints = [];
  if (opts.include_network !== false) {
    try {
      endpoints = await collectEndpoints(pageManager, tid, opts.network_limit || 200);
    } catch (e) { /* capture disabled — not an error worth failing on */ }
  }

  const route = recommend({ flat, dom, endpoints });
  return {
    ok: true,
    tab: tid,
    url: (dom && dom.url) || view.webContents.getURL(),
    title: (dom && dom.title) || '',
    tree: {
      elements: flat.length,
      roles,
      actions,
      // The actionable count is the honest signal: a big tree of layout-only
      // nodes tells an agent nothing about what it can *do*.
      actionable: Object.values(actions).reduce((s, n) => s + n, 0),
    },
    canvas: {
      top: (dom && dom.topCanvas) || 0,
      in_frames: ((dom && dom.iframes) || []).reduce((s, f) => s + (f.innerCanvas || 0), 0),
      visible: (dom && dom.canvases) || [],
    },
    iframes: (dom && dom.iframes) || [],
    app_globals: (dom && dom.globals) || [],
    endpoints,
    route,
  };
}

/**
 * Pull JSON-ish endpoints out of the network capture.
 * Static assets are filtered hard: media files alone number in the hundreds on
 * canvas sites and would bury the actual API list.
 */
async function collectEndpoints(pageManager, tid, limit) {
  const res = await pageManager.networkMonitor.list
    ? await pageManager.networkMonitor.list({ tabId: tid, limit })
    : null;
  const reqs = (res && (res.requests || res.items || res)) || [];
  const seen = new Set();
  const out = [];
  for (const r of reqs) {
    const u = String(r.url || '');
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) continue;
    if (/\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|otf|mp3|mp4|webm|mov|avi|wav|ogg|ico)(\?|$)/i.test(u)) continue;
    const short = u.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    if (seen.has(short)) continue;
    seen.add(short);
    out.push({ method: String(r.method || 'GET'), path: short, status: r.status });
    if (out.length >= 40) break;
  }
  return out;
}

// Ranking when several globals look graph-ish. Order matters: measured on
// ComfyUI, `window.LiteGraph` (a library namespace whose getState() matches)
// sorted ahead of `window.graph` (the actual model, 13 nodes), so the
// recommendation pointed the agent at the library instead of the data.
// "Owns nodes" is what separates them: a model holds nodes, a library exports
// constructors.
//
// Match against the START of the hint. The probe names come from HINTS above and
// come out as `_nodes (13 items)` / `graph (obj)` / `getState` — i.e. the bare
// property name, NOT `has ._nodes`. Matching the "has ." form silently ranked
// everything -1 and made the probe fall through to the generic L1_api route,
// which is how that mistake was caught.
const GRAPH_RANK = [
  ['_nodes', 100],          // LiteGraph graph — the model itself
  ['nodes', 95],
  ['graph', 85],
  ['links', 80],
  ['loadGraphData', 75],
  ['serialize', 60],
  ['getState', 30],         // library namespace: weaker signal
  ['queuePrompt', 25],
];

function rankGlobal(g) {
  if (!g || !g.hint) return -1;
  const hint = String(g.hint);
  for (const [needle, score] of GRAPH_RANK) {
    // `startsWith` on the bare name, so "nodes (13 items)" matches "_nodes" first
    // (higher score) rather than being caught by the looser "nodes" rule.
    if (hint === needle || hint.startsWith(needle + ' ')) return score;
  }
  return -1;
}

/**
 * Rank app-like globals, best candidate first. Exported so it can be unit
 * tested against the exact hint strings the in-page probe produces — the first
 * version of this got the prefix wrong ("has ._nodes" vs "_nodes"), ranked
 * everything -1, and silently downgraded a page from L1_structured_data to a
 * generic L1_api. Only a real site surfaced it; a table test pins it instantly.
 */
export function rankAppGlobals(globals) {
  return (globals || [])
    .map((g) => ({ g, score: rankGlobal(g) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * The actual deliverable: which route to take, and WHY (with the evidence).
 * Every claim cites the number that produced it, so a caller can disagree.
 */
function recommend({ flat, dom, endpoints }) {
  const routes = [];
  const iframes = (dom && dom.iframes) || [];
  const globals = (dom && dom.globals) || [];
  const topCanvas = (dom && dom.topCanvas) || 0;
  const frameCanvas = iframes.reduce((s, f) => s + (f.innerCanvas || 0), 0);
  const totalCanvas = topCanvas + frameCanvas;
  const sameOriginFrame = iframes.find((f) => f.sameOrigin);
  const ranked = rankAppGlobals(globals);
  const graphObj = ranked.length ? ranked[0].g : null;
  // Say so explicitly when the top candidate is a library rather than a model:
  // acting on `LiteGraph` instead of `graph` wastes a round-trip at best.
  const weakTop = graphObj && rankGlobal(graphObj) <= 30;

  if (graphObj) {
    routes.push({
      route: 'L1_structured_data',
      preferred: true,
      why: `${graphObj.where}.${graphObj.key} looks like the app's own model (${graphObj.hint}) — read/write the whole graph as JSON`,
      evidence: {
        global: `${graphObj.where}.${graphObj.key}`,
        hint: graphObj.hint,
        // All graph-ish candidates, best first. Exposing the runners-up matters:
        // the top pick is a judgement call, and the alternative is usually one
        // level away (ComfyUI: `graph` is the model, `LiteGraph` the library).
        candidates: ranked.slice(0, 4).map((x) => `${x.g.where}.${x.g.key} (${x.g.hint})`),
      },
      how: 'ui.evaluate to reach that object; use ui.snapshot + ui.diff around every write',
    });
    if (weakTop) {
      routes.push({
        route: 'NOTE_weak_graph_candidate',
        preferred: false,
        why: `the best match \`${graphObj.key}\` only proves it exposes ${graphObj.hint}, which libraries also do — check the runners-up in evidence.candidates for the object that actually holds the nodes`,
        evidence: { candidates: ranked.slice(0, 4).map((x) => `${x.g.where}.${x.g.key} (${x.g.hint})`) },
        how: 'inspect each candidate for a node/link collection before writing to it',
      });
    }
  } else {
    routes.push({
      route: 'L1_api',
      preferred: endpoints.length > 0,
      why: endpoints.length
        ? `no app object on window, but ${endpoints.length} JSON-ish endpoints were observed — check whether one returns the whole document`
        : 'no app object on window and no JSON endpoints observed — data access will have to go through the UI',
      evidence: { endpoint_count: endpoints.length, sample: endpoints.slice(0, 5).map((e) => `${e.method} ${e.path}`) },
      how: 'ui.network_get to read one, then ui.evaluate with fetch to call it',
    });
  }

  // "Rich tree" = enough elements AND enough role variety AND something the agent
// can actually act on. Element count alone is misleading — a page can expose
// 400 <div>s that are all layout scaffolding with nothing clickable.
const roleSet = new Set(flat.map((n) => n.role).filter(Boolean));
const actionable = flat.filter((n) => (n.actions || []).some((a) => a === 'click' || a === 'type' || a === 'setContent')).length;
const rich = flat.length >= 60 && roleSet.size >= 4 && actionable >= 10;
  routes.push({
    route: 'L2_semantic_tree',
    preferred: !graphObj && rich,
    why: rich
      ? `${flat.length} elements, ${roleSet.size} distinct roles, ${actionable} with a click/type action — targets can be found by role/label and driven by data-ai-id, no coordinates`
      : `only ${flat.length} elements (${actionable} actionable)${totalCanvas ? ` and ${totalCanvas} canvas element(s)` : ''} — the UI is largely canvas-rendered, so the tree cannot see the content`,
    evidence: {
      elements: flat.length,
      actionable,
      roles: roleSet.size,
      // Split by location: a page with 0 top-level canvases but 7 inside an
      // iframe is a canvas app, and reporting only the total invites the reader
      // to conclude "no canvas, must be DOM" — the opposite of the truth.
      canvas_top: topCanvas,
      canvas_in_frames: frameCanvas,
    },
    how: 'ui.get_tree to read; ui.act with the returned data-ai-id to click/type/setContent',
  });

  routes.push({
    route: 'L3_pointer_gestures',
    preferred: false,
    why: 'only for what has no structured path (dragging nodes, drawing connections, wheel pan/zoom)',
    evidence: {},
    how: 'ui.act drag/press/wheel — ALWAYS followed by ui.diff against a snapshot, because these get rewritten by the app (thresholds, snapping, auto-pan)',
  });

  if (sameOriginFrame) {
    routes.push({
      route: 'NOTE_same_origin_iframe',
      preferred: false,
      why: `the body lives in a same-origin iframe (${sameOriginFrame.innerElements} elements, ${sameOriginFrame.innerButtons} buttons) — its content IS in the semantic tree and ui.act routes to it`,
      evidence: { iframe: sameOriginFrame },
      how: 'no special handling needed; act on the returned data-ai-id as usual',
    });
  }
  if (totalCanvas > 0 && !rich) {
    routes.push({
      route: 'NOTE_canvas_rendered',
      preferred: false,
      why: `${totalCanvas} canvas element(s) (${topCanvas} top-level, ${frameCanvas} in frames) but only ${flat.length} semantic elements (${actionable} actionable) — do NOT keep trying coordinate gestures to hit canvas-drawn items; go find the app's data model instead`,
      evidence: { canvas_top: topCanvas, canvas_in_frames: frameCanvas, elements: flat.length, actionable },
      how: 'ui.canvas list/read can still extract text drawn via fillText (no OCR), but that is a fallback, not a primary path',
    });
  }

  return {
    recommended: routes.filter((r) => r.preferred).map((r) => r.route),
    routes,
    discipline: 'every write must be proven by ui.diff against a ui.snapshot baseline — a gesture or act returning success is not evidence',
  };
}