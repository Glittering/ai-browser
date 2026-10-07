// tests/test_network_monitor.js — 网络抓包存储的单测（纯 Node，不需要 Electron）
// 覆盖：POST 请求体、请求头合并与脱敏、服务端过滤、body 分页、保留/淘汰与
// 稳定错误码、clear 只清日志。
import { describe, it, expect } from 'vitest';
import { NetworkMonitor, NETWORK_ERROR_CODES, redactHeaders, normalizeHeaders } from '../src/main/network_monitor.js';

const TAB = 1;

function mkMonitor(limits = {}, opts = {}) {
  return new NetworkMonitor(limits, { captureEnabled: true, sensitiveAllowed: false, ...opts });
}

function fireGet(m, url, requestId = 'r' + Math.random()) {
  m.onRequestWillBeSent(TAB, {
    requestId,
    type: 'Fetch',
    request: { url, method: 'GET', headers: { accept: '*/*' } },
    initiator: { type: 'script', stack: { callFrames: [{ functionName: 'load', url, lineNumber: 12, columnNumber: 4 }] } },
    documentURL: 'http://x.test/page',
    timestamp: 1000,
    wallTime: 1700000000,
  });
  return requestId;
}

function firePost(m, url, body, contentType, requestId = 'p' + Math.random()) {
  m.onRequestWillBeSent(TAB, {
    requestId,
    type: 'Fetch',
    request: { url, method: 'POST', headers: { 'content-type': contentType, authorization: 'Bearer SECRET-TOKEN' }, postData: body },
    initiator: { type: 'script' },
    documentURL: 'http://x.test/page',
    timestamp: 1000,
    wallTime: 1700000000,
  });
  return requestId;
}

// onLoadingFinished 会 fire-and-forget 地抓响应体；测试里必须让这批微任务先
// 跑完，否则断言时 body 还没入库（真实环境有 IPC 往返，sleep 后自然就绪）。
async function finish(m, requestId, opts = {}) {
  m.onResponseReceived(TAB, {
    requestId,
    type: opts.type || 'Fetch',
    response: {
      url: opts.url || '',
      status: opts.status || 200,
      mimeType: opts.mimeType || 'application/json',
      headers: { 'content-type': opts.mimeType || 'application/json' },
    },
  });
  m.onLoadingFinished(TAB, { requestId, timestamp: 1000.5, encodedDataLength: 128 });
  await new Promise((r) => setImmediate(r));
}

describe('requestWillBeSent — 请求侧字段', () => {
  it('NM-01 记录 method / url / resourceType / initiator / documentURL', async () => {
    const m = mkMonitor();
    const id = fireGet(m, 'http://x.test/api/a');
    await finish(m, id, { url: 'http://x.test/api/a' });
    const rec = m.list({ tab: TAB }).requests[0];
    expect(rec.method).toBe('GET');
    expect(rec.url).toBe('http://x.test/api/a');
    expect(rec.resource_type).toBe('Fetch');
    expect(rec.state).toBe('finished');
    expect(rec.has_request_body).toBe(false);
    expect(rec.request_body_state).toBe('none');
    expect(rec.duration_ms).toBe(500);
    expect(rec.encoded_data_length).toBe(128);
  });

  it('NM-02 POST 的 postData 原样入库（这是用户要拿的东西）', async () => {
    const m = mkMonitor();
    const id = firePost(m, 'http://x.test/api/post', '{"title":"hello","n":1}', 'application/json');
    await finish(m, id, { url: 'http://x.test/api/post' });
    const list = m.list({ tab: TAB, method: ['POST'] }).requests;
    expect(list).toHaveLength(1);
    expect(list[0].has_request_body).toBe(true);
    expect(list[0].request_body_state).toBe('captured');
    const d = await m.get(list[0].network_id, { include_request_body: true });
    expect(d.request.body.state).toBe('captured');
    expect(d.request.body.kind).toBe('json');
    expect(d.request.body.raw.data).toBe('{"title":"hello","n":1}');
    expect(d.request.body.parsed).toEqual({ title: 'hello', n: 1 });
    expect(d.request.body.raw.truncated).toBe(false);
    expect(d.request.body.complete).toBe(true);
  });

  it('NM-03 form body 解析为有序 name/value（允许重复 key）', async () => {
    const m = mkMonitor();
    const id = firePost(m, 'http://x.test/api/form', 'a=1&b=two&a=3', 'application/x-www-form-urlencoded');
    await finish(m, id, { url: 'http://x.test/api/form' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const d = await m.get(nid, { include_request_body: true });
    expect(d.request.body.kind).toBe('form_urlencoded');
    expect(d.request.body.parsed).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'two' },
      { name: 'a', value: '3' },
    ]);
  });

  it('NM-04 hasPostData 但内联缺失时走 getRequestPostData 补一次', async () => {
    const m = mkMonitor();
    let asked = 0;
    m.setBodyFetcher(TAB, async (requestId, kind) => {
      if (kind !== 'request') return null;
      asked += 1;
      return { data: '{"late":true}' };
    });
    m.onRequestWillBeSent(TAB, {
      requestId: 'r1', type: 'Fetch',
      request: { url: 'http://x.test/api/late', method: 'POST', headers: { 'content-type': 'application/json' }, hasPostData: true },
      timestamp: 1, wallTime: 1700000000,
    });
    await finish(m, 'r1', { url: 'http://x.test/api/late' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const d = await m.get(nid, { include_request_body: true });
    expect(d.request.body.raw.data).toBe('{"late":true}');
    expect(asked).toBe(1); // 只补一次，不重复打 CDP
  });

  it('NM-05 补不到就标 unavailable，绝不静默 null', async () => {
    const m = mkMonitor();
    m.setBodyFetcher(TAB, async () => null);
    m.onRequestWillBeSent(TAB, {
      requestId: 'r2', type: 'Fetch',
      request: { url: 'http://x.test/api/none', method: 'POST', headers: {}, hasPostData: true },
      timestamp: 1, wallTime: 1700000000,
    });
    await finish(m, 'r2', { url: 'http://x.test/api/none' });
    const rec = m.list({ tab: TAB }).requests[0];
    expect(rec.request_body_state).toBe('unavailable');
    await expect(m.get(rec.network_id, { include_request_body: true }))
      .rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.NETWORK_BODY_UNAVAILABLE });
  });
});

describe('请求头 — 合并与脱敏', () => {
  it('NM-06 extraInfo 覆盖初始 headers 并标记 headers_source', async () => {
    const m = mkMonitor();
    const id = fireGet(m, 'http://x.test/a');
    m.onRequestWillBeSentExtraInfo(TAB, { requestId: id, headers: { Authorization: 'Bearer REAL', Cookie: 'sid=1' } });
    await finish(m, id, { url: 'http://x.test/a' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const d = await m.get(nid, { include_request_headers: true });
    expect(d.request.headers_source).toBe('extraInfo');
    const auth = d.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(auth.value).toBe('[REDACTED]');
    expect(auth.redacted).toBe(true);
    expect(d.request.headers_redacted).toBe(true);
  });

  it('NM-07 默认把 authorization/cookie/set-cookie/proxy-authorization 全部脱敏', () => {
    const out = redactHeaders(normalizeHeaders({
      Authorization: 'Bearer T', Cookie: 'a=b', 'Set-Cookie': 'c=d', 'Proxy-Authorization': 'Basic x', 'X-Other': 'keep',
    }), false);
    const byName = Object.fromEntries(out.map((h) => [h.name.toLowerCase(), h]));
    expect(byName.authorization.value).toBe('[REDACTED]');
    expect(byName.cookie.value).toBe('[REDACTED]');
    expect(byName['set-cookie'].value).toBe('[REDACTED]');
    expect(byName['proxy-authorization'].value).toBe('[REDACTED]');
    expect(byName['x-other'].value).toBe('keep');
    expect(byName['x-other'].redacted).toBeUndefined();
  });

  it('NM-08 sensitiveAllowed=false 时显式要敏感头 → SENSITIVE_HEADERS_DISABLED', async () => {
    const m = mkMonitor();
    const id = firePost(m, 'http://x.test/p', '{}', 'application/json');
    await finish(m, id, { url: 'http://x.test/p' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    await expect(m.get(nid, { include_request_headers: true, include_sensitive_headers: true }))
      .rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.SENSITIVE_HEADERS_DISABLED });
  });

  it('NM-09 sensitiveAllowed=true + 显式 opt-in 才给原文', async () => {
    const m = mkMonitor({}, { sensitiveAllowed: true });
    const id = firePost(m, 'http://x.test/p', '{}', 'application/json');
    await finish(m, id, { url: 'http://x.test/p' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const d = await m.get(nid, { include_request_headers: true, include_sensitive_headers: true });
    const auth = d.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
    expect(auth.value).toBe('Bearer SECRET-TOKEN');
    expect(d.sensitive_data_warning).toBeTruthy();
  });
});

describe('ui.network_list — 服务端过滤', () => {
  it('NM-10 method 过滤只剩对应方法', async () => {
    const m = mkMonitor();
    const g = fireGet(m, 'http://x.test/a');
    const p = firePost(m, 'http://x.test/b', '{}', 'application/json');
    await finish(m, g, { url: 'http://x.test/a' });
    await finish(m, p, { url: 'http://x.test/b' });
    expect(m.list({ tab: TAB, method: ['POST'] }).requests.every((r) => r.method === 'POST')).toBe(true);
    expect(m.list({ tab: TAB, method: ['POST'] }).requests).toHaveLength(1);
    expect(m.list({ tab: TAB, method: ['GET'] }).requests).toHaveLength(1);
  });

  it('NM-11 url_contains / status / resource_type / state 过滤各自生效', async () => {
    const m = mkMonitor();
    const p1 = firePost(m, 'http://x.test/api/two', '{"a":1}', 'application/json');
    const p2 = firePost(m, 'http://x.test/other/three', 'x=1', 'application/x-www-form-urlencoded');
    await finish(m, p1, { url: 'http://x.test/api/two', status: 201 });
    await finish(m, p2, { url: 'http://x.test/other/three', status: 500 });
    expect(m.list({ tab: TAB, url_contains: '/api/' }).requests).toHaveLength(1);
    const bad = m.list({ tab: TAB, status: { min: 400, max: 599 } }).requests;
    expect(bad).toHaveLength(1);
    expect(bad[0].status).toBe(500);
    expect(m.list({ tab: TAB, resource_type: ['Fetch'] }).requests.length).toBe(2);
    expect(m.list({ tab: TAB, resource_type: ['Script'] }).requests).toHaveLength(0);
    expect(m.list({ tab: TAB, state: ['finished'] }).requests).toHaveLength(2);
    expect(m.list({ tab: TAB, state: ['failed'] }).requests).toHaveLength(0);
  });

  it('NM-12 按 seq 倒序 + limit/before_seq 分页', async () => {
    const m = mkMonitor();
    for (let i = 0; i < 10; i++) { const id = fireGet(m, 'http://x.test/' + i); await finish(m, id, { url: 'http://x.test/' + i }); }
    const p1 = m.list({ tab: TAB, limit: 4 });
    expect(p1.requests).toHaveLength(4);
    const seqs = p1.requests.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(p1.pagination.has_more).toBe(true);
    const p2 = m.list({ tab: TAB, limit: 4, before_seq: p1.pagination.next_before_seq });
    expect(p2.requests.every((r) => r.seq < p1.pagination.next_before_seq)).toBe(true);
    expect(p2.requests).toHaveLength(4);
  });

  it('NM-13 limit 夹到 [1,200]', async () => {
    const m = mkMonitor();
    for (let i = 0; i < 300; i++) { const id = fireGet(m, 'http://x.test/' + i); await finish(m, id, { url: 'http://x.test/' + i }); }
    expect(m.list({ tab: TAB, limit: 5000 }).requests).toHaveLength(200);
    expect(m.list({ tab: TAB, limit: -5 }).requests).toHaveLength(1);
  });

  it('NM-14 started_after/started_before 按时间过滤', async () => {
    const m = mkMonitor();
    const id = fireGet(m, 'http://x.test/t');
    await finish(m, id, { url: 'http://x.test/t' });
    expect(m.list({ tab: TAB, started_after: '2000-01-01T00:00:00.000Z' }).requests).toHaveLength(1);
    expect(m.list({ tab: TAB, started_before: '2000-01-01T00:00:00.000Z' }).requests).toHaveLength(0);
  });
});

describe('body 分页', () => {
  it('NM-15 大 body 分页：truncated + next_offset，续读可拼回原值', async () => {
    const m = mkMonitor();
    m.setBodyFetcher(TAB, async () => ({ data: 'A'.repeat(50000) }));
    const id = fireGet(m, 'http://x.test/big');
    await finish(m, id, { url: 'http://x.test/big', mimeType: 'text/plain' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const p1 = await m.get(nid, { include_response_body: true, body_limit: 8000 });
    expect(p1.response.body.raw.truncated).toBe(true);
    expect(p1.response.body.raw.returned_bytes).toBe(8000);
    expect(p1.response.body.raw.next_offset).toBe(8000);
    expect(p1.response.body.parsed).toBe(null); // 不完整时不给 parsed
    const p2 = await m.get(nid, { include_response_body: true, response_body_offset: p1.response.body.raw.next_offset, body_limit: 100000 });
    expect(p2.response.body.raw.offset).toBe(8000);
    expect(p2.response.body.raw.truncated).toBe(false);
    expect(p1.response.body.raw.data + p2.response.body.raw.data).toBe('A'.repeat(50000));
  });

  it('NM-16 body_limit 夹到 maxBodyLimit', async () => {
    const m = mkMonitor();
    m.setBodyFetcher(TAB, async () => ({ data: 'B'.repeat(300000) }));
    const id = fireGet(m, 'http://x.test/big2');
    await finish(m, id, { url: 'http://x.test/big2', mimeType: 'text/plain' });
    const nid = m.list({ tab: TAB }).requests[0].network_id;
    const p = await m.get(nid, { include_response_body: true, body_limit: 10 ** 9 });
    expect(p.response.body.raw.returned_bytes).toBe(m.limits.maxBodyLimit);
  });
});

describe('保留 / 淘汰 / 错误码', () => {
  it('NM-17 记录数超限：dropped_records > 0，最旧记录被淘汰 → NETWORK_NOT_FOUND', async () => {
    const m = mkMonitor({ maxRecords: 20 });
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const id = 'k' + i; ids.push(id);
      fireGet(m, 'http://x.test/' + i, id);
      await finish(m, id, { url: 'http://x.test/' + i });
    }
    const st = m.stats();
    expect(st.records).toBe(20);
    expect(st.dropped_records).toBeGreaterThan(0);
    await expect(m.get(`${TAB}:${ids[0]}:0`, {})).rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.NETWORK_NOT_FOUND });
  });

  it('NM-18 body 字节超限：记录还在，body state=evicted，取 body → NETWORK_BODY_EVICTED', async () => {
    const m = mkMonitor({ maxBodyBytes: 2000 }); // 每条 body 按 2 字节/code point 粗估
    m.setBodyFetcher(TAB, async () => ({ data: 'C'.repeat(500) }));
    const first = fireGet(m, 'http://x.test/first');
    await finish(m, first, { url: 'http://x.test/first', mimeType: 'text/plain' });
    const firstNid = `${TAB}:${first}:0`;
    for (let i = 0; i < 10; i++) {
      const id = 'g' + i;
      fireGet(m, 'http://x.test/' + i, id);
      await finish(m, id, { url: 'http://x.test/' + i, mimeType: 'text/plain' });
    }
    const rec = m.list({ tab: TAB }).requests.find((r) => r.network_id === firstNid);
    expect(rec).toBeTruthy(); // metadata 保留
    expect(rec.response_body_state).toBe('evicted');
    await expect(m.get(firstNid, { include_response_body: true }))
      .rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.NETWORK_BODY_EVICTED });
  });

  it('NM-19 network_id 不存在的稳定错误码', async () => {
    const m = mkMonitor();
    await expect(m.get('1:does-not-exist:0', {})).rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.NETWORK_NOT_FOUND });
  });

  it('NM-20 clear 只清日志，返回 cleared_records / cleared_body_bytes', async () => {
    const m = mkMonitor();
    for (let i = 0; i < 5; i++) { const id = 'c' + i; fireGet(m, 'http://x.test/' + i, id); await finish(m, id, { url: 'http://x.test/' + i }); }
    expect(m.stats().records).toBe(5);
    const res = m.clear(TAB);
    expect(res.cleared_records).toBe(5);
    expect(res.cleared_body_bytes).toBeGreaterThanOrEqual(0);
    expect(m.stats().records).toBe(0);
    expect(m.stats().dropped_records).toBe(0); // clear 不算 dropped
  });

  it('NM-21 clear 只影响指定 tab', async () => {
    const m = mkMonitor();
    const a = fireGet(m, 'http://x.test/a', 'ta');
    m.onRequestWillBeSent(2, { requestId: 'tb', type: 'Fetch', request: { url: 'http://x.test/b', method: 'GET', headers: {} }, timestamp: 1, wallTime: 1700000000 });
    await finish(m, a, { url: 'http://x.test/a' });
    m.clear(1);
    const rest = m.list({}).requests;
    expect(rest).toHaveLength(1);
    expect(rest[0].tab_id).toBe(2);
  });
});

describe('configure', () => {
  it('NM-22 capture_bodies 只接受 none|api|all，非法值保持原值', () => {
    const m = mkMonitor();
    expect(m.configure(TAB, { capture_bodies: 'all' }).capture_bodies).toBe('all');
    expect(m.configure(TAB, { capture_bodies: 'bogus' }).capture_bodies).toBe('all');
    expect(m.configure(TAB, { capture_bodies: 'none' }).capture_bodies).toBe('none');
  });

  it('NM-23 enabled=false 时不再记录，且 list 返回 capture_disabled 警告', async () => {
    const m = mkMonitor();
    m.configure(TAB, { enabled: false });
    const id = fireGet(m, 'http://x.test/off');
    await finish(m, id, { url: 'http://x.test/off' });
    const res = m.list({ tab: TAB });
    expect(res.requests).toHaveLength(0);
    expect(res.warning).toBe('capture_disabled');
    expect(res.capture.enabled).toBe(false);
  });

  it('NM-24 capture_bodies=none 时不抓响应体（lazy → unavailable）', async () => {
    const m = mkMonitor();
    m.configure(TAB, { capture_bodies: 'none' });
    const id = fireGet(m, 'http://x.test/nobody');
    await finish(m, id, { url: 'http://x.test/nobody', mimeType: 'application/json' });
    const rec = m.list({ tab: TAB }).requests[0];
    expect(rec.response_body_state).toBe('lazy');
    await expect(m.get(rec.network_id, { include_response_body: true }))
      .rejects.toMatchObject({ rpcCode: NETWORK_ERROR_CODES.NETWORK_BODY_UNAVAILABLE });
  });
});

describe('兼容旧 ui.network_body 的选取规则', () => {
  it('NM-25 同 URL 多次请求时取【最近完成】的那条（旧实现取的是最旧）', () => {
    const m = mkMonitor();
    const a = fireGet(m, 'http://x.test/api/dup', 'dup1');
    const b = fireGet(m, 'http://x.test/api/dup', 'dup2');
    m.onLoadingFinished(TAB, { requestId: a, timestamp: 1001 });
    m.onLoadingFinished(TAB, { requestId: b, timestamp: 1002 });
    const picked = m.findLatestFinished(TAB, '/api/dup');
    expect(picked.request_id).toBe('dup2');
  });
});
