// tests/test_invariants.js — "人可见可操作" 不变量的静态守护
//
// AI Browser 的产品定位是：窗口真实可见，人可以随时用鼠标键盘手动介入
// （登录、扫码、过验证码、纠正 agent 的操作）。它不是 headless 浏览器。
//
// 这些不变量无法在单元测试里靠"跑一遍 Electron"来验证（要起窗口、要 GUI 环境），
// 所以改成直接扫源码文本。任何人把它改成 headless、隐藏窗口、或者拆掉防遮挡开关，
// 这里的测试立刻红，并且错误信息里写明"为什么不能改、怎么恢复"。
//
// 不依赖 Electron，不启动浏览器，纯 fs.readFileSync + 断言。

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSrc = (relPath) => readFileSync(path.join(root, relPath), 'utf8');

const INDEX_JS = 'src/main/index.js';
const TAB_BAR_HTML = 'src/renderer/tab_bar.html';
const PACKAGE_JSON = 'package.json';

const indexSrc = readSrc(INDEX_JS);
const pkg = JSON.parse(readSrc(PACKAGE_JSON));

describe('不变量 1：窗口必须真实显示（不能隐藏起步）', () => {
  // 这条断言在 2026-10-10 被**加强**过，不是放宽：
  //   旧写法：禁止出现 `show: false` 字面。
  //   新写法：允许"延迟显示"（show:false + 稍后显式显示），但要求必须存在显示调用；
  //           另外新增禁止窗口不可见 / offscreen 的守护。
  //
  // 为什么要改：MCP 场景下 agent 拉起的浏览器窗口不应该抢走用户的键盘焦点（否则
  // agent 一干活，人就没法用电脑），标准做法正是 `show:false` + `showInactive()`。
  // 旧断言会把这条唯一正确的实现方式判红。而它真正要守护的是"窗口最终必须出现"，
  // 所以新写法直接断言这件事 —— 只隐藏不显示照样红。
  // 动态验证在 e2e/focus_ws.cjs（实测窗口确实出现在屏幕上）。
  it(`${INDEX_JS} 若延迟显示（show:false），必须存在启动时的显示调用`, () => {
    const m = indexSrc.match(/show\s*:\s*false/);
    if (!m) return; // 没有延迟显示 = 创建即显示，天然满足
    const shown = /\.\s*(showInactive|show)\s*\(/.test(indexSrc);
    expect(
      shown,
      [
        `发现 BrowserWindow 选项里的 "${m[0]}"，但 ${INDEX_JS} 里找不到任何 .show() / .showInactive() 调用。`,
        '那样窗口创建后永远不会出现，直接杀死产品定位：人看不到页面，就没法手动登录、扫码、',
        '过验证码、纠正 agent 的操作，AI Browser 会退化成一个黑盒 headless 浏览器。',
        '',
        '允许的形态是"延迟显示"：show:false + 在启动路径上显式 showInactive()（可见但不抢焦点）',
        '或 show()。被禁止的是"只隐藏、不显示"。',
      ].join('\n')
    ).toBe(true);
  });

  it(`${INDEX_JS} 不得把窗口变成不可见 / headless`, () => {
    const forbidden = [
      ['webPreferences[\\s\\S]{0,300}?offscreen\\s*:\\s*true', 'offscreen:true（离屏渲染 = headless）'],
      ['mainWindow\\.hide\\(', 'mainWindow.hide()（窗口从屏幕上消失，人找不到）'],
    ];
    for (const [re, label] of forbidden) {
      expect(
        new RegExp(re).test(indexSrc),
        `不应出现 ${label} —— 它会让窗口不再出现在屏幕上，人就没法手动介入了。`
      ).toBe(false);
    }
  });

  it('package.json 的入口仍指向真实的桌面入口 src/main/index.js', () => {
    expect(
      pkg.main,
      [
        `package.json 的 "main" 当前是 "${pkg.main}"，不再是 src/main/index.js。`,
        'AI Browser 必须由一个创建真实窗口的 Electron 桌面入口启动；把入口换成 CLI / 无窗口脚本',
        '等于把它改成 headless，人将失去手动介入的能力。',
        '恢复方式：把 "main" 改回 "src/main/index.js"。',
      ].join('\n')
    ).toBe('src/main/index.js');
  });
});

describe('不变量 2：防遮挡开关必须齐全（否则 agent 的输入会静默丢失）', () => {
  const REQUIRED_SWITCHES = [
    'disable-backgrounding-occluded-windows',
    'disable-renderer-backgrounding',
    'disable-background-timer-throttling',
  ];

  it.each(REQUIRED_SWITCHES)('%s 必须存在于 %s', (sw) => {
    const present = new RegExp(
      `app\\.commandLine\\.appendSwitch\\(\\s*['"\`]${sw}['"\`]`
    ).test(indexSrc);
    expect(
      present,
      [
        `${INDEX_JS} 缺少 app.commandLine.appendSwitch('${sw}')。`,
        '这三个开关是配套的一整套：窗口被 IDE / 其他全屏窗口遮挡时，Chromium 默认会把页面降到',
        'visibilityState=hidden 并节流定时器，结果是 CDP 注入的鼠标键盘事件被渲染进程丢弃 ——',
        '点击上报成功（elementFromPoint 通过）但页面没反应，打字什么也输不进去。人手动介入时同样会踩到。',
        `恢复方式：在 app.whenReady 之前加回 app.commandLine.appendSwitch('${sw}');`,
      ].join('\n')
    ).toBe(true);
  });
});

describe('不变量 3：看门狗阈值不能太小（重启会打断人）', () => {
  it('WATCHDOG_FAIL_LIMIT 必须 ≥ 5', () => {
    const m = indexSrc.match(/WATCHDOG_FAIL_LIMIT\s*=\s*(\d+)/);
    expect(
      m,
      [
        `在 ${INDEX_JS} 里找不到 WATCHDOG_FAIL_LIMIT 的定义。`,
        '这个常量控制"连续多少次网络探测失败才重启整个 App"，是防止误判重启打断人的最后一道闸。',
        '恢复方式：重新加回 const WATCHDOG_FAIL_LIMIT = 5;',
      ].join('\n')
    ).not.toBe(null);

    const limit = Number(m[1]);
    expect(
      limit >= 5,
      [
        `WATCHDOG_FAIL_LIMIT 当前是 ${limit}，低于安全下限 5。`,
        '每 30s 探测一次，阈值 3 意味着 ~90s 的连续探测失败就会触发 app.relaunch() —— 而探测走的是',
        '主进程 net.request，一次临时的 DNS 抖动 / 代理切换 / 网络切换就能凑够 3 次。结果就是',
        '人正在手动登录或填表时窗口被无预警重启，输入全丢。',
        '恢复方式：把阈值改回 ≥ 5（当前约定值 5），并且不要同时调小 WATCHDOG_INTERVAL 来抵消它。',
      ].join('\n')
    ).toBe(true);
  });
});

describe('不变量 4：tab 条是人的可见界面，必须存在且有内容', () => {
  it(`${TAB_BAR_HTML} 必须存在且非空`, () => {
    const abs = path.join(root, TAB_BAR_HTML);
    expect(
      existsSync(abs),
      [
        `${TAB_BAR_HTML} 不存在了。`,
        'tab 条是人唯一能"看到自己在哪个页面、切到哪个页面"的界面元素；删掉它等于把浏览器变成',
        '一个只有 agent 能理解的黑盒，人无法手动接管。',
        '恢复方式：从 git 历史还原该文件（git checkout HEAD -- src/renderer/tab_bar.html）。',
      ].join('\n')
    ).toBe(true);

    const size = statSync(abs).size;
    expect(
      size > 0,
      [
        `${TAB_BAR_HTML} 是空文件（0 字节）。`,
        '空的 tab 条会让窗口顶部出现一条空白，人既看不到标签也点不了新建/关闭/切换。',
        '恢复方式：从 git 历史还原该文件。',
      ].join('\n')
    ).toBe(true);

    const html = readSrc(TAB_BAR_HTML);
    expect(
      html.trim(),
      [
        `${TAB_BAR_HTML} 只有空白字符。`,
        '恢复方式：从 git 历史还原该文件，或重新实现 renderTabs() 与 tab 条的 DOM 结构。',
      ].join('\n')
    ).not.toBe('');
  });
});

describe('不变量 5：措辞必须与"人可见可操作"的定位一致', () => {
  it(`${INDEX_JS} 不得出现 "not a visual browser" 这类自我否定措辞`, () => {
    const found = indexSrc.toLowerCase().includes('not a visual browser');
    expect(
      found,
      [
        `${INDEX_JS} 里出现了 "not a visual browser"。`,
        'AI Browser 是"人可见、人可随时手动介入"的浏览器，这句话和定位直接矛盾，而且它会误导',
        '后来的贡献者照着它继续往 headless 方向改（隐藏窗口、去掉 tab 条、关掉防遮挡开关）。',
        '恢复方式：删掉这句措辞，改成描述事实的说法，例如"关闭硬件加速以避免 GPU 驱动崩溃，',
        '窗口仍然是真实可见的窗口"。',
      ].join('\n')
    ).toBe(false);
  });
});
