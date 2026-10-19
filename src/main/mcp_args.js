// main/mcp_args.js — MCP 参数映射：对外分组，对内扁平
//
// 为什么要有这一层：
// 2026-10 之前，工具的专属参数被**拍平**到顶层（browse_act 27 个顶层参数），
// agent 每次要读完 27 个才能找到自己需要的 3 个，而且平面命名空间必然撞车。
// 实际撞过：drag 的 dx/dy 与 wheel 的 delta_x/delta_y 都往 params.dx/dy 上写，
// 对象字面量后者胜出 → `browse_act({action:'drag', dx:100})` 的 dx 被清成
// undefined，拖拽按偏移量的用法静默失效（无异常、无日志）。
//
// 现在分成三层：
//   schema（mcp_tools.js）  只暴露分组，agent 少读
//   本文件                  分组 → 扁平，单一映射点
//   page_manager            只认扁平（保持不动，避免第二套名字）
//
// ⚠️ 向后兼容是硬要求：**旧的扁平参数继续被接受**。已经写好的脚本和提示词
// 不该因为我们的 API 整理而失效。分组只是"读起来更省"，不是"旧写法作废"。

/** null/undefined 都退回 fallback；0 和 false 是有效值，必须保留。 */
function pick(v, fallback) {
  return v === undefined || v === null ? fallback : v;
}

/**
 * browse_act 的参数映射。
 * 返回 page_manager `ui.act` 认识的那套扁平 params。
 */
export function actParams(args = {}) {
  const action = typeof args.action === 'string' ? args.action : '';
  const click = args.click || {};
  const read = args.read || {};
  const press = args.press || {};
  const wheel = args.wheel || {};
  const drag = args.drag || {};

  const params = {
    text: args.text,
    html: args.html,
    value: args.value,
    file: args.file,
    timeout_ms: args.timeout_ms,
    offset: pick(read.offset, args.offset),
    limit: pick(read.limit, args.limit),
    url: pick(click.url, args.url),
    keep_tab: pick(click.keep_tab, args.keep_tab),
    // 点完等新标签记录出现的时间（默认 150ms，0 = 不等）。见 page_manager._awaitOpenedTab。
    opened_tab_wait_ms: pick(click.opened_tab_wait_ms, args.opened_tab_wait_ms),
    key: pick(press.key, args.key),
    keys: pick(press.keys, args.keys),
  };

  // drag 与 wheel 在 page_manager 里共用 dx/dy 两个字段，由 action 决定语义。
  // 所以这里**必须按 action 二选一**，绝不能两个分支都无条件写 —— 那正是
  // 上面说的覆盖事故的来源。
  if (action === 'drag') {
    params.to_target = pick(drag.target_to, args.to_target);
    params.dx = pick(drag.dx, args.dx);
    params.dy = pick(drag.dy, args.dy);
    params.to_x = pick(drag.to && drag.to.x, args.to_x);
    params.to_y = pick(drag.to && drag.to.y, args.to_y);
    params.from_anchor = pick(drag.from && drag.from.anchor, pick(drag.from_anchor, args.from_anchor));
    params.to_anchor = pick(drag.to && drag.to.anchor, pick(drag.to_anchor, args.to_anchor));
    params.hold = pick(drag.hold, args.hold);
    params.button = pick(drag.button, args.button);

    // 起点：显式坐标（可无 target，用于在空白画布上起拖）
    const from = drag.from;
    if (from && from.x !== undefined && from.y !== undefined) {
      params.from = { x: from.x, y: from.y };
    } else if (args.from_x !== undefined && args.from_y !== undefined) {
      params.from = { x: args.from_x, y: args.from_y };
    }
  } else if (action === 'wheel') {
    params.dx = pick(wheel.dx, args.delta_x);
    params.dy = pick(wheel.dy, args.delta_y);
    params.hold = pick(wheel.hold, args.hold);
  }

  return params;
}

/**
 * browse_network 的参数映射。
 * list/clear/configure 走 ui.network_<op>，get 走 ui.network_get。
 */
export function networkParams(args = {}) {
  const f = args.filters || {};
  const inc = args.include || {};
  const off = args.body_offset || {};
  const cfg = args.configure || {};

  const statusMin = pick(f.status_min, args.status_min);
  const statusMax = pick(f.status_max, args.status_max);

  return {
    // list / clear / configure
    tab: args.tab,
    method: pick(f.method, args.method),
    url_contains: pick(f.url_contains, args.url_contains),
    status:
      statusMin !== undefined || statusMax !== undefined
        ? { min: statusMin, max: statusMax }
        : undefined,
    resource_type: pick(f.resource_type, args.resource_type),
    state: pick(f.state, args.state),
    started_after: pick(f.started_after, args.started_after),
    started_before: pick(f.started_before, args.started_before),
    limit: pick(f.limit, args.limit),
    before_seq: pick(f.before_seq, args.before_seq),
    enabled: pick(cfg.enabled, args.enabled),
    capture_bodies: pick(cfg.capture_bodies, args.capture_bodies),
    // get
    network_id: args.network_id,
    include_request_headers: pick(inc.request_headers, args.include_request_headers),
    include_request_body: pick(inc.request_body, args.include_request_body),
    include_response_headers: pick(inc.response_headers, args.include_response_headers),
    include_response_body: pick(inc.response_body, args.include_response_body),
    include_sensitive_headers: pick(inc.sensitive_headers, args.include_sensitive_headers),
    body_limit: pick(inc.body_limit, args.body_limit),
    request_body_offset: pick(off.request, args.request_body_offset),
    response_body_offset: pick(off.response, args.response_body_offset),
  };
}
