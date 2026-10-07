// main/network_monitor.js — 有界的 Network 请求日志（可查询的 Chrome Network 面板）
//
// 设计要点（方案 docs/PLAN_CANVAS_NETWORK.md 第二章）：
//  1. 只记内存，不落盘；记录数与 body 字节数双重上限，超出淘汰最旧的，累计
//     dropped_records。长会话内存必须收敛，不能随请求数无限增长。
//  2. 请求侧（method / headers / POST body / initiator）与响应侧都抓，POST 请求体
//     是用户明确要拿的东西 —— 之前只有 URL 子串猜响应体。
//  3. 拿不到就用明确 state（evicted / unavailable / partial），绝不静默 null。
//  4. 敏感头默认脱敏。
//
// 这个模块不依赖 Electron：CDP 事件由 page_manager 喂进来，body 抓取通过一个
// 注入的 fetcher（tabId -> (requestId, kind) => body），因此可在纯 Node 下单测。

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
const REDACTED = '[REDACTED]';
const SENSITIVE_WARNING = 'request/response data may contain credentials or personal data';

const API_RESOURCE_TYPES = new Set(['Document', 'XHR', 'Fetch', 'WebSocket']);
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql)|.*\+json$|.*\+xml$)/i;

// 稳定错误码（方案 2.4）。调用方能靠 code 区分"不存在/被淘汰/拿不到/敏感头未开"。
export const NETWORK_ERROR_CODES = {
  NETWORK_NOT_FOUND: -32020,
  NETWORK_BODY_EVICTED: -32021,
  NETWORK_BODY_UNAVAILABLE: -32022,
  SENSITIVE_HEADERS_DISABLED: -32023,
};

export class NetworkError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'NetworkError';
    this.rpcCode = code;
    this.data = data || null;
  }
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function envFlag(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !(v === '0' || v === 'false' || v === 'no');
}

export function defaultLimits() {
  return {
    // 记录数上限（全局）。超出淘汰最旧的并累计 dropped_records。
    maxRecords: envInt('AI_BROWSER_NETWORK_MAX_RECORDS', 1000),
    // body 总字节上限（全局）。超出优先淘汰最旧的 response body。
    maxBodyBytes: envInt('AI_BROWSER_NETWORK_MAX_BODY_BYTES', 32 * 1024 * 1024),
    // 单条 body 抓取上限。超过只存前缀并标 partial。
    maxSingleBodyBytes: envInt('AI_BROWSER_NETWORK_MAX_SINGLE_BODY_BYTES', 2 * 1024 * 1024),
    // 单次输出分页：默认 64KiB，最大 256KiB（只是输出分页，不等于采集截断）。
    defaultBodyLimit: envInt('AI_BROWSER_NETWORK_BODY_LIMIT', 65536),
    maxBodyLimit: envInt('AI_BROWSER_NETWORK_BODY_LIMIT_MAX', 262144),
    listLimitDefault: 50,
    listLimitMax: 200,
  };
}

// Network.enable 的 postData 内联上限；拿不到时再走 Network.getRequestPostData。
export const MAX_POST_DATA_SIZE = envInt('AI_BROWSER_NETWORK_MAX_POST_DATA', 1024 * 1024);

function nowIso(ms) {
  try { return new Date(ms).toISOString(); } catch (e) { return new Date().toISOString(); }
}

function codePointLength(s) { return Array.from(s == null ? '' : String(s)).length; }
function sliceByCodePoints(s, offset, limit) {
  const arr = Array.from(s == null ? '' : String(s));
  const start = Math.max(0, Math.min(arr.length, Number(offset) || 0));
  const end = limit == null ? arr.length : Math.min(arr.length, start + Math.max(0, Math.floor(limit)));
  return arr.slice(start, end).join('');
}

// CDP headers 可能是对象（request.headers / extraInfo.headers）或数组。
// 统一成 [{name, value}]。
export function normalizeHeaders(raw) {
  const out = [];
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (!h) continue;
      const name = String(h.name || h[0] || '');
      const value = h.value != null ? String(h.value) : String(h[1] != null ? h[1] : '');
      if (name) out.push({ name, value });
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const k of Object.keys(raw)) out.push({ name: String(k), value: String(raw[k]) });
  }
  return out;
}

// 大小写不敏感合并：后到的覆盖先到的（extraInfo 是浏览器实际发出的头，权威）。
export function mergeHeaders(base, extra) {
  const map = new Map();
  for (const h of base || []) map.set(String(h.name).toLowerCase(), { name: h.name, value: h.value });
  for (const h of extra || []) map.set(String(h.name).toLowerCase(), { name: h.name, value: h.value });
  return Array.from(map.values());
}

export function redactHeaders(headers, includeSensitive) {
  return (headers || []).map((h) => {
    const isSensitive = SENSITIVE_HEADERS.has(String(h.name).toLowerCase());
    if (isSensitive && !includeSensitive) return { name: h.name, value: REDACTED, redacted: true };
    return { name: h.name, value: h.value };
  });
}

export function hasSensitiveHeader(headers) {
  return (headers || []).some((h) => SENSITIVE_HEADERS.has(String(h.name).toLowerCase()));
}

function bodyKind(mimeType, explicit) {
  if (explicit) return explicit;
  const m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!m) return 'unknown';
  if (m === 'application/json' || /\+json$/.test(m)) return 'json';
  if (m === 'application/x-www-form-urlencoded') return 'form_urlencoded';
  if (m === 'multipart/form-data') return 'multipart';
  if (/^text\//.test(m) || m === 'application/xml' || /\+xml$/.test(m)) return 'text';
  return 'binary';
}

function safeDecode(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return String(s); }
}

// 只在完整且可安全解析时提供 parsed。
function parseBody(text, kind) {
  if (kind === 'json') {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  if (kind === 'form_urlencoded') {
    const pairs = [];
    for (const part of String(text).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = eq < 0 ? part : part.slice(0, eq);
      const v = eq < 0 ? '' : part.slice(eq + 1);
      pairs.push({ name: safeDecode(k), value: safeDecode(v) });
    }
    return pairs;
  }
  return null;
}

let seqCounter = 0;

export class NetworkMonitor {
  constructor(limits = {}, opts = {}) {
    this.limits = { ...defaultLimits(), ...limits };
    this._records = new Map();   // network_id -> record
    this._order = [];            // network_id，按 seq 升序
    this._droppedRecords = 0;
    this._bodyBytes = 0;
    this._startedAt = new Date().toISOString();
    this._fetchers = new Map();  // tabId -> async (requestId, kind) => {data, base64Encoded, complete}
    this._tabConfig = new Map(); // tabId -> { enabled, capture_bodies }
    this.captureEnabled = opts.captureEnabled !== undefined ? opts.captureEnabled : envFlag('AI_BROWSER_NETWORK_CAPTURE', true);
    this.sensitiveAllowed = opts.sensitiveAllowed !== undefined ? opts.sensitiveAllowed : envFlag('AI_BROWSER_NETWORK_SENSITIVE', false);
    this.globalCaptureBodies = 'api';
  }

  // ==== 配置 ============================================================

  setBodyFetcher(tabId, fn) { this._fetchers.set(tabId, fn); }
  clearBodyFetcher(tabId) { this._fetchers.delete(tabId); }

  tabConfig(tabId) {
    const c = this._tabConfig.get(tabId);
    if (c) return c;
    return { enabled: this.captureEnabled, capture_bodies: this.globalCaptureBodies };
  }

  configure(tabId, opts = {}) {
    const cur = this.tabConfig(tabId);
    const next = {
      enabled: opts.enabled === undefined ? cur.enabled : !!opts.enabled,
      capture_bodies: ['none', 'api', 'all'].indexOf(opts.capture_bodies) >= 0 ? opts.capture_bodies : cur.capture_bodies,
    };
    this._tabConfig.set(tabId, next);
    if (!next.enabled) this.clear(tabId);
    return next;
  }

  // ==== 记录生命周期 =====================================================

  _networkId(tabId, requestId, redirectIndex) {
    return `${tabId}:${requestId}:${redirectIndex || 0}`;
  }

  _insert(rec) {
    this._records.set(rec.network_id, rec);
    this._order.push(rec.network_id);
    this._enforceRecordLimit(rec.network_id);
    return rec;
  }

  _enforceRecordLimit(protectId) {
    while (this._records.size > this.limits.maxRecords) {
      let victim = null;
      for (const id of this._order) {
        if (id === protectId) continue;
        victim = id; break;
      }
      if (!victim) break;
      this._dropRecord(victim);
    }
  }

  _dropRecord(networkId) {
    const rec = this._records.get(networkId);
    if (!rec) return;
    this._bodyBytes -= (rec._reqBodyBytes || 0) + (rec._respBodyBytes || 0);
    if (this._bodyBytes < 0) this._bodyBytes = 0;
    this._records.delete(networkId);
    const i = this._order.indexOf(networkId);
    if (i >= 0) this._order.splice(i, 1);
    this._droppedRecords += 1;
  }

  // body 超限：优先淘汰最旧的 response body，其次 request body；metadata 保留。
  _enforceBodyLimit(protectId) {
    if (this._bodyBytes <= this.limits.maxBodyBytes) return;
    for (const pass of ['response', 'request']) {
      for (const id of this._order) {
        if (this._bodyBytes <= this.limits.maxBodyBytes) return;
        if (id === protectId) continue;
        const rec = this._records.get(id);
        if (!rec) continue;
        if (pass === 'response' && rec._respBody) {
          this._bodyBytes -= rec._respBodyBytes || 0;
          rec._respBody = null; rec._respBodyBytes = 0;
          rec.response_body_state = 'evicted';
          rec._respEvicted = true;
        } else if (pass === 'request' && rec._reqBody) {
          this._bodyBytes -= rec._reqBodyBytes || 0;
          rec._reqBody = null; rec._reqBodyBytes = 0;
          rec.request_body_state = 'evicted';
          rec._reqEvicted = true;
        }
      }
    }
  }

  _storeBody(rec, which, data, opts = {}) {
    const encoding = opts.base64Encoded ? 'base64' : 'utf8';
    const raw = data == null ? '' : String(data);
    const cap = this.limits.maxSingleBodyBytes;
    const arr = Array.from(raw);
    const overCap = arr.length > cap;
    const stored = overCap ? arr.slice(0, cap).join('') : raw;
    const omissions = (opts.omissions || []).slice();
    if (overCap) omissions.push('single_body_cap_exceeded');
    const body = {
      encoding,
      data: stored,
      complete: opts.complete !== false,
      omissions,
      captured_length: codePointLength(stored),
      total_length: opts.total_length != null ? opts.total_length : codePointLength(raw),
    };
    // UTF-16 内部存储：一个 code point 粗估 2 字节。
    const bytes = body.captured_length * (encoding === 'base64' ? 1 : 2);

    if (which === 'request') {
      this._bodyBytes -= rec._reqBodyBytes || 0;
      rec._reqBody = body;
      rec._reqBodyBytes = bytes;
      rec._reqEvicted = false;
      rec.request_body_state = overCap ? 'partial' : 'captured';
    } else {
      this._bodyBytes -= rec._respBodyBytes || 0;
      rec._respBody = body;
      rec._respBodyBytes = bytes;
      rec._respEvicted = false;
      rec.response_body_state = overCap ? 'partial' : 'captured';
    }
    this._bodyBytes += bytes;
    this._enforceBodyLimit(rec.network_id);
    return body;
  }

  // ==== CDP 事件入口 =====================================================

  onRequestWillBeSent(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const requestId = params.requestId;
    // 重定向：同一个 CDP requestId 复用，先用 redirectResponse 收尾上一跳。
    let redirectIndex = 0;
    if (params.redirectResponse) {
      const prev = this._findByRequestId(tabId, requestId);
      if (prev) {
        this._applyResponse(prev, params.redirectResponse, { fromRedirect: true });
        prev.state = 'finished';
        prev.finished_at = nowIso(Date.now());
        if (prev.response_body_state === 'pending') prev.response_body_state = 'lazy';
        redirectIndex = (prev.redirect_index || 0) + 1;
      }
    }
    const req = params.request || {};
    const rec = {
      seq: ++seqCounter,
      network_id: this._networkId(tabId, requestId, redirectIndex),
      request_id: String(requestId),
      redirect_index: redirectIndex,
      tab_id: tabId,
      frame_id: params.frameId != null ? String(params.frameId) : null,
      loader_id: params.loaderId != null ? String(params.loaderId) : null,
      url: String(req.url || ''),
      method: String(req.method || 'GET').toUpperCase(),
      resource_type: String(params.type || req.resourceType || 'Other'),
      started_at: nowIso(params.wallTime ? params.wallTime * 1000 : Date.now()),
      started_monotonic: typeof params.timestamp === 'number' ? params.timestamp : Date.now() / 1000,
      state: 'pending',
      has_request_body: !!req.hasPostData || !!req.postData,
      request_body_state: (req.hasPostData || req.postData) ? 'pending' : 'none',
      response_body_state: 'pending',
      _headers: normalizeHeaders(req.headers),
      headers_source: 'request',
      initiator: normalizeInitiator(params.initiator),
      document_url: String(params.documentURL || req.url || ''),
      _reqFetchTried: false,
      _respFetchTried: false,
      _reqBodyBytes: 0,
      _respBodyBytes: 0,
    };
    // postData 内联（Network.enable 带 maxPostDataSize 时 Chromium 会给）。
    if (req.postData != null) {
      const ct = headerValue(normalizeHeaders(req.headers), 'content-type');
      this._storeBody(rec, 'request', req.postData, {
        complete: true,
        omissions: bodyKind(ct) === 'multipart' ? ['multipart_file_bytes'] : [],
      });
      rec.request_body_state = this._reqBodyState(rec);
    }
    const inserted = this._insert(rec);
    // 内联缺失但确实有 body：尽快补一次 getRequestPostData（不阻塞事件循环）。
    if (inserted.has_request_body && !inserted._reqBody) this._fetchRequestBody(tabId, inserted);
    return inserted;
  }

  _reqBodyState(rec) {
    if (!rec.has_request_body) return 'none';
    if (rec._reqEvicted) return 'evicted';
    if (rec._reqBody) return rec.request_body_state === 'evicted' ? 'evicted' : rec.request_body_state;
    if (rec._reqFetchTried) return 'unavailable';
    return 'pending';
  }

  // 返回 promise 并缓存在记录上：事件里是 fire-and-forget，之后 _readBody
  // 可能立刻被问到，此时要等同一次抓取完成，而不是再发一次或误判 unavailable。
  async _fetchRequestBody(tabId, rec) {
    if (rec._reqFetchPromise) return rec._reqFetchPromise;
    if (rec._reqFetchTried || rec._reqEvicted) return null;
    rec._reqFetchTried = true;
    rec._reqFetchPromise = (async () => {
      const fn = this._fetchers.get(tabId);
      if (!fn) { rec.request_body_state = 'unavailable'; return null; }
      try {
        const r = await fn(rec.request_id, 'request');
        if (r && r.data != null) {
          this._storeBody(rec, 'request', r.data, { complete: r.complete !== false, omissions: r.omissions || [] });
        } else {
          rec.request_body_state = 'unavailable';
        }
      } catch (e) {
        rec.request_body_state = 'unavailable';
      }
      return rec._reqBody || null;
    })();
    return rec._reqFetchPromise;
  }

  onRequestWillBeSentExtraInfo(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    rec._headers = mergeHeaders(rec._headers, normalizeHeaders(params.headers));
    rec.headers_source = 'extraInfo';
    if (Array.isArray(params.associatedCookies)) rec._associatedCookies = params.associatedCookies.length;
    return rec;
  }

  onResponseReceived(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    this._applyResponse(rec, params.response, { type: params.type });
    return rec;
  }

  _applyResponse(rec, response) {
    if (!response) return;
    rec.status = typeof response.status === 'number' ? response.status : undefined;
    rec.status_text = response.statusText || undefined;
    rec.mime_type = response.mimeType || undefined;
    rec.protocol = response.protocol || undefined;
    rec.from_disk_cache = !!response.fromDiskCache;
    rec.from_service_worker = !!response.fromServiceWorker;
    rec.remote_ip_address = response.remoteIPAddress || undefined;
    rec.remote_port = typeof response.remotePort === 'number' ? response.remotePort : undefined;
    rec.security_state = response.securityState || undefined;
    rec._respHeaders = mergeHeaders(rec._respHeaders || [], normalizeHeaders(response.headers));
    if (response.headersText != null) rec._respHeadersText = String(response.headersText);
    if (response.timing) rec._timing = response.timing;
  }

  onResponseReceivedExtraInfo(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    rec._respHeaders = mergeHeaders(rec._respHeaders || [], normalizeHeaders(params.headers));
    if (params.headersText != null) rec._respHeadersText = String(params.headersText);
    return rec;
  }

  onDataReceived(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    rec.decoded_data_length = (rec.decoded_data_length || 0) + (params.dataLength || 0);
    rec.encoded_data_length = (rec.encoded_data_length || 0) + (params.encodedDataLength || 0);
    return rec;
  }

  onLoadingFinished(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    rec.state = 'finished';
    rec.finished_at = nowIso(Date.now());
    if (typeof params.encodedDataLength === 'number') rec.encoded_data_length = params.encodedDataLength;
    const startMs = rec.started_monotonic ? rec.started_monotonic * 1000 : null;
    if (startMs && typeof params.timestamp === 'number') {
      rec.duration_ms = Math.max(0, Math.round(params.timestamp * 1000 - startMs));
    }
    if (rec.response_body_state === 'pending') rec.response_body_state = 'lazy';
    if (this._shouldCaptureResponse(rec)) this._fetchResponseBody(tabId, rec);
    return rec;
  }

  _shouldCaptureResponse(rec) {
    const mode = this.tabConfig(rec.tab_id).capture_bodies;
    if (mode === 'none') return false;
    if (mode === 'all') return true;
    // 'api'：只抓 API/文档类，静态资源保持 lazy（首次读详情时再取）。
    return API_RESOURCE_TYPES.has(rec.resource_type) || TEXT_MIME_RE.test(rec.mime_type || '');
  }

  async _fetchResponseBody(tabId, rec) {
    if (rec._respFetching || rec._respEvicted) return;
    rec._respFetching = true;
    rec._respFetchTried = true;
    const fn = this._fetchers.get(tabId);
    if (!fn) {
      rec._respFetching = false;
      rec.response_body_state = 'unavailable';
      return;
    }
    try {
      const r = await fn(rec.request_id, 'response');
      if (r && r.data != null) {
        this._storeBody(rec, 'response', r.data, { base64Encoded: !!r.base64Encoded, complete: r.complete !== false });
      } else {
        rec.response_body_state = 'unavailable';
      }
    } catch (e) {
      // Chromium 可能已淘汰该 body（导航/CDP buffer/流未结束）—— 明确标出来。
      rec.response_body_state = 'unavailable';
      rec._respError = String((e && e.message) || e).slice(0, 200);
    }
    rec._respFetching = false;
  }

  onLoadingFailed(tabId, params) {
    if (!this.tabConfig(tabId).enabled) return null;
    const rec = this._findByRequestId(tabId, params.requestId);
    if (!rec) return null;
    rec.state = 'failed';
    rec.finished_at = nowIso(Date.now());
    rec.error = {
      text: params.errorText || '',
      canceled: params.canceled === true,
      blocked_reason: params.blockedReason || undefined,
    };
    // failed 不是 "HTTP 0 的正常响应"，不伪造 status。
    rec.response_body_state = 'unavailable';
    return rec;
  }

  _findByRequestId(tabId, requestId) {
    // 同一 requestId 可能有多跳；取 redirect_index 最大的那条。
    let best = null;
    for (const id of this._order) {
      const rec = this._records.get(id);
      if (!rec || rec.tab_id !== tabId || rec.request_id !== String(requestId)) continue;
      if (!best || (rec.redirect_index || 0) >= (best.redirect_index || 0)) best = rec;
    }
    return best;
  }

  // ==== 查询 =============================================================

  stats() {
    let first = null, last = null;
    if (this._order.length) {
      first = this._records.get(this._order[0]).seq;
      last = this._records.get(this._order[this._order.length - 1]).seq;
    }
    return {
      first_seq: first,
      last_seq: last,
      dropped_records: this._droppedRecords,
      records: this._records.size,
      max_records: this.limits.maxRecords,
      body_bytes: this._bodyBytes,
      max_body_bytes: this.limits.maxBodyBytes,
    };
  }

  captureInfo(tabId) {
    const cfg = this.tabConfig(tabId);
    return {
      enabled: !!cfg.enabled,
      capture_bodies: cfg.capture_bodies,
      since: this._startedAt,
      limits: {
        max_records: this.limits.maxRecords,
        max_body_bytes: this.limits.maxBodyBytes,
        max_single_body_bytes: this.limits.maxSingleBodyBytes,
        body_limit_default: this.limits.defaultBodyLimit,
        body_limit_max: this.limits.maxBodyLimit,
        list_limit_max: this.limits.listLimitMax,
      },
    };
  }

  list(filter = {}) {
    const tabId = filter.tab;
    const methods = toUpperArray(filter.method);
    const types = toStringArray(filter.resource_type);
    const states = toStringArray(filter.state);
    const urlContains = typeof filter.url_contains === 'string' ? filter.url_contains : null;
    const statusMin = numOrNull(filter.status && filter.status.min);
    const statusMax = numOrNull(filter.status && filter.status.max);
    const startedAfter = timeOrNull(filter.started_after);
    const startedBefore = timeOrNull(filter.started_before);
    const beforeSeq = numOrNull(filter.before_seq);

    const rows = [];
    for (const id of this._order) {
      const rec = this._records.get(id);
      if (!rec) continue;
      if (tabId !== undefined && tabId !== null && rec.tab_id !== tabId) continue;
      if (beforeSeq !== null && rec.seq >= beforeSeq) continue;
      if (methods && methods.indexOf(rec.method) < 0) continue;
      if (types && types.indexOf(rec.resource_type) < 0) continue;
      if (states && states.indexOf(rec.state) < 0) continue;
      if (urlContains !== null && rec.url.indexOf(urlContains) < 0) continue;
      if (statusMin !== null && !(rec.status != null && rec.status >= statusMin)) continue;
      if (statusMax !== null && !(rec.status != null && rec.status <= statusMax)) continue;
      if (startedAfter !== null && !(rec.started_at && rec.started_at >= startedAfter)) continue;
      if (startedBefore !== null && !(rec.started_at && rec.started_at <= startedBefore)) continue;
      rows.push(rec);
    }
    rows.sort((a, b) => b.seq - a.seq); // 按 seq 倒序

    const limit = Math.max(1, Math.min(this.limits.listLimitMax, Number(filter.limit) || this.limits.listLimitDefault));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextBeforeSeq = hasMore ? page[page.length - 1].seq : null;
    const capture = this.captureInfo(tabId);

    return {
      requests: page.map((r) => this._listItem(r)),
      pagination: { returned: page.length, next_before_seq: nextBeforeSeq, has_more: hasMore },
      retention: this.stats(),
      capture,
      // 采集被关闭时明确告知，避免调用方以为"没有请求"。
      ...(capture.enabled ? {} : { warning: 'capture_disabled' }),
    };
  }

  _listItem(rec) {
    return {
      seq: rec.seq,
      network_id: rec.network_id,
      request_id: rec.request_id,
      tab_id: rec.tab_id,
      url: rec.url,
      method: rec.method,
      status: rec.status != null ? rec.status : undefined,
      status_text: rec.status_text,
      mime_type: rec.mime_type,
      resource_type: rec.resource_type,
      started_at: rec.started_at,
      duration_ms: rec.duration_ms,
      encoded_data_length: rec.encoded_data_length,
      decoded_data_length: rec.decoded_data_length,
      from_disk_cache: rec.from_disk_cache,
      has_request_body: rec.has_request_body,
      request_body_state: this._reqBodyState(rec),
      response_body_state: rec.response_body_state,
      state: rec.state,
      error: rec.error,
    };
  }

  /**
   * 单条详情。include_*_body 为 true 且 body 不可得时抛稳定错误码（不静默 null）。
   */
  async get(networkId, opts = {}) {
    const rec = this._records.get(String(networkId));
    if (!rec) {
      throw new NetworkError(NETWORK_ERROR_CODES.NETWORK_NOT_FOUND, 'NETWORK_NOT_FOUND: no captured request with this network_id', { network_id: String(networkId) });
    }
    const includeSensitive = opts.include_sensitive_headers === true;
    if (includeSensitive && !this.sensitiveAllowed) {
      throw new NetworkError(
        NETWORK_ERROR_CODES.SENSITIVE_HEADERS_DISABLED,
        'SENSITIVE_HEADERS_DISABLED: start ai-browser with AI_BROWSER_NETWORK_SENSITIVE=1 to allow raw sensitive headers',
        {}
      );
    }
    const bodyLimit = Math.max(1, Math.min(this.limits.maxBodyLimit, Number(opts.body_limit) || this.limits.defaultBodyLimit));

    const out = { record: this._listItem(rec), request: null, response: null, sensitive_data_warning: SENSITIVE_WARNING };

    if (opts.include_request_headers) {
      const reqHeaders = redactHeaders(rec._headers || [], includeSensitive);
      out.request = out.request || {};
      out.request.headers = reqHeaders;
      out.request.headers_source = rec.headers_source;
      out.request.headers_redacted = hasSensitiveHeader(reqHeaders) && !includeSensitive;
    }
    if (opts.include_response_headers) {
      const respHeaders = redactHeaders(rec._respHeaders || [], includeSensitive);
      out.response = out.response || {};
      out.response.headers = respHeaders;
      out.response.headers_text = rec._respHeadersText || null;
      out.response.headers_redacted = hasSensitiveHeader(respHeaders) && !includeSensitive;
    }
    if (opts.include_request_body) {
      out.request = out.request || {};
      out.request.body = await this._readBody(rec, 'request', numOrNull(opts.request_body_offset) || 0, bodyLimit);
    }
    if (opts.include_response_body) {
      out.response = out.response || {};
      out.response.body = await this._readBody(rec, 'response', numOrNull(opts.response_body_offset) || 0, bodyLimit);
    }

    // initiator / document_url 等只有详情才给（列表不带，避免灌进上下文）。
    out.request = out.request || {};
    out.request.initiator = rec.initiator || null;
    out.request.document_url = rec.document_url || null;
    out.request.frame_id = rec.frame_id;
    out.request.loader_id = rec.loader_id;
    out.request.redirect_index = rec.redirect_index;
    if (out.response) {
      out.response.mime_type = rec.mime_type;
      out.response.protocol = rec.protocol;
      out.response.from_disk_cache = rec.from_disk_cache;
      out.response.from_service_worker = rec.from_service_worker;
      out.response.remote_ip_address = rec.remote_ip_address;
    }
    return out;
  }

  async _readBody(rec, which, offset, limit) {
    const isReq = which === 'request';
    if (isReq) {
      // pending：先补一次 getRequestPostData（可能事件还没到 / 内联缺失）。
      if (!rec._reqBody && rec.has_request_body) await this._fetchRequestBody(rec.tab_id, rec);
    } else if (!rec._respEvicted && !rec._respBody && (rec.state === 'finished' || rec.state === 'failed')) {
      await this._fetchResponseBody(rec.tab_id, rec);
    }

    if (isReq && !rec.has_request_body) {
      return { state: 'none', kind: null, raw: null, parsed: null, complete: true, omissions: [] };
    }
    const stored = isReq ? rec._reqBody : rec._respBody;
    const state = isReq ? this._reqBodyState(rec) : rec.response_body_state;
    if (!stored) {
      if (state === 'evicted' || rec._reqEvicted || rec._respEvicted) {
        throw new NetworkError(NETWORK_ERROR_CODES.NETWORK_BODY_EVICTED, 'NETWORK_BODY_EVICTED: body was captured but dropped by the retention limit', { network_id: rec.network_id, side: which });
      }
      throw new NetworkError(
        NETWORK_ERROR_CODES.NETWORK_BODY_UNAVAILABLE,
        'NETWORK_BODY_UNAVAILABLE: ' + (rec._respError || (rec.state === 'pending' ? 'request has not finished' : 'CDP did not provide this body')),
        { network_id: rec.network_id, side: which, state }
      );
    }

    const data = sliceByCodePoints(stored.data, offset, limit);
    const returned = codePointLength(data);
    const total = stored.captured_length;
    const hasMore = offset + returned < total;
    const mime = isReq ? headerValue(rec._headers, 'content-type') : rec.mime_type;
    const kind = bodyKind(mime, stored.kind);
    const isFullSlice = offset === 0 && !hasMore;
    const parsed = (!stored.complete || !isFullSlice || kind === 'binary') ? null : parseBody(stored.data, kind);

    return {
      state: stored.complete ? state : 'partial',
      source: isReq ? 'requestWillBeSent.postData|Network.getRequestPostData' : 'Network.getResponseBody',
      kind,
      mime_type: mime || null,
      raw: {
        encoding: stored.encoding,
        length_unit: stored.encoding === 'base64' ? 'byte' : 'unicode_code_point',
        data,
        offset,
        returned_bytes: returned,
        captured_bytes: total,
        total_bytes: stored.total_length != null ? stored.total_length : total,
        truncated: hasMore,
        next_offset: hasMore ? offset + returned : null,
        complete_available: !hasMore || stored.complete !== false,
      },
      parsed,
      complete: stored.complete !== false,
      omissions: stored.omissions || [],
    };
  }

  // 兼容旧 ui.network_body：按 url_pattern 选最近完成的匹配项。
  findLatestFinished(tabId, urlPattern) {
    let best = null;
    for (const id of this._order) {
      const rec = this._records.get(id);
      if (!rec || rec.tab_id !== tabId) continue;
      if (rec.state !== 'finished') continue;
      if (String(rec.url).indexOf(String(urlPattern == null ? '' : urlPattern)) < 0) continue;
      if (!best || rec.seq > best.seq) best = rec;
    }
    return best;
  }

  clear(tabId) {
    let cleared = 0, clearedBytes = 0;
    const keep = [];
    for (const id of this._order) {
      const rec = this._records.get(id);
      if (!rec) continue;
      if (tabId === undefined || tabId === null || rec.tab_id === tabId) {
        cleared += 1;
        clearedBytes += (rec._reqBodyBytes || 0) + (rec._respBodyBytes || 0);
        this._records.delete(id);
      } else keep.push(id);
    }
    this._order = keep;
    this._bodyBytes = Math.max(0, this._bodyBytes - clearedBytes);
    return { cleared_records: cleared, cleared_body_bytes: clearedBytes };
  }
}

function toUpperArray(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x).toUpperCase());
}
function toStringArray(v) {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x));
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function timeOrNull(v) {
  if (v == null) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function headerValue(headers, name) {
  for (const h of headers || []) if (String(h.name).toLowerCase() === name) return h.value;
  return null;
}
function normalizeInitiator(init) {
  if (!init) return null;
  const out = { type: init.type || null };
  if (init.stack && Array.isArray(init.stack.callFrames)) {
    out.stack = {
      callFrames: init.stack.callFrames.slice(0, 30).map((f) => ({
        function: f.functionName || '',
        url: f.url || '',
        line: f.lineNumber,
        column: f.columnNumber,
      })),
    };
  }
  if (init.url) out.url = init.url;
  if (init.lineNumber != null) out.line_number = init.lineNumber;
  return out;
}

export default NetworkMonitor;
