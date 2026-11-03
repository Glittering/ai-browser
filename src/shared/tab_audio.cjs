// shared/tab_audio.cjs — 一个标签页的声音该不该出喇叭。
//
// 为什么需要这一条（2026-11-03 对照 Chromium 之后定下的第 1 项）：本项目里所有标签页
// 都挂在同一个窗口上，"人看到哪一页"只由 z 序决定。**音频没有 z 序** —— 五页同时在放
// 声音，人就同时听见五路，而我们的标签条上没有喇叭图标可以逐个关。最难受的是 agent：
// 它在后台开的那几页（视频、直播、带背景音乐的营销页）人根本看不见，声音却一路响，
// 等于一台找不到静音键的收音机。这里只有纯函数，判据能被单测钉住（tests/test_tab_audio.js）。
//
// Chrome **不**自动静音后台页，因为它假设后台页是人自己开的、随时点得回去听。这个假设
// 在人的那一组成立，在 agent 那一组不成立 —— 人没开过那一页，也不知道是它在响。所以
// 规则只有两条，每条都有自己的出处，不要合成一条"非活跃就静音"：
//   1) 人眼前那一页（activeTab）永远有声。人点开 agent 的页听一听，就该听见。
//   2) 人自己开的页（非 agent 组）延续 Chrome 行为：切走了也继续放 —— 一边看别的
//      一边听歌是真实用法，把它静音是拿 Chromium 没有的行为去改人的体验。
// 剩下的（agent 在后台开的、当前没人看着的页）静音。
'use strict';

const { isAgentGroup } = require('./tab_group.cjs');

/** 关掉这条行为的开关：AI_BROWSER_BG_MUTE=0（默认开）。 */
const ENV_KEY = 'AI_BROWSER_BG_MUTE';

function bgMuteEnabled(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const raw = src[ENV_KEY];
  if (raw === undefined || raw === null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * 这一页现在该不该静音。
 *
 * @param {{tabId?:*, activeTab?:*, group?:string, enabled?:boolean}} o
 *   group 是这一页的归属（'human' / 'agent:<session>'）；enabled 不传时读环境变量。
 * @returns {boolean}
 */
function shouldMute(o) {
  const t = o || {};
  const enabled = t.enabled === undefined ? bgMuteEnabled() : t.enabled === true;
  if (!enabled) return false;
  if (t.tabId === undefined || t.tabId === null) return false;
  // 1) 人眼前那一页永远有声。两边都空（还没有任何页）时不能算"同一个"。
  if (t.activeTab !== undefined && t.activeTab !== null && t.tabId === t.activeTab) return false;
  // 2) 人自己开的页照旧不静音（Chrome 行为）。
  if (!isAgentGroup(t.group)) return false;
  return true;
}

/**
 * 回执里怎么写。静音要**说出来**：agent 截图看到视频在动却没声音，或者人反馈
 * "这一页没声音"，判据只能是这一条字段，不能靠猜。
 * 不静音时不给字段（省 token，也不制造"每次都要判"的噪音）。
 */
function muteField(muted) {
  return muted ? { muted: true } : {};
}

module.exports = {
  ENV_KEY,
  bgMuteEnabled,
  shouldMute,
  muteField,
};
