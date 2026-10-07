// e2e/richtext_ws.cjs — 富文本编辑器 & 复杂表单 测试矩阵（跑在真实 WS API 上）
//
// 自包含：起 Electron + 本地 fixture 服务（离线可重复），覆盖 agent 在"富文本 /
// 复杂表单"类页面上真正要解决的六组问题：
//   A. 富文本编辑器 —— 段落结构、工具栏（加粗/斜体/H1/H2/列表/引用/代码块）、选区格式化
//   B. 嵌套菜单 —— 二级 / 三级按钮；评估 ui.peek（hover 探索 + AX 差分）好不好用
//   C. 复杂表单 —— 必填 vs 选填（required / aria-required / 红星 / required_hints / 字数上限）
//   D. 报错与异常 —— 字段级小红字、表单级汇总、toast、模态弹窗、服务端错误
//   E. 选择与标签 —— radio / checkbox / 原生 select / 自定义 combobox / tag input / 微博式话题
//   F. 图片上传 —— ui.act upload 写真实本地文件 + 预览
//
// 断言政策（写在跑之前，不看结果回头改）：
//   1. 凡是"操作类"断言，一律落到真实 DOM：点了加粗就去查 DOM 里有没有 <b>/<strong>，
//      不只看语义树、更不信 act 自己报的 success。act 报 success 而 DOM 没变 = 谎报 = FAIL。
//   2. 凡是"读懂类"断言，先测语义层（ui.get_tree / context）能不能直接读到；读不到时
//      再测 ui.evaluate 兜底能不能读到，两条都写进输出（名字里标明走的是哪条路径），
//      并在结尾的缺陷清单里登记——不把读不到的事实藏起来。
//   3. 能力边界按项目既有惯例（capabilities_ws.cjs B-04）处理：断言"边界事实"本身，
//      并写 NOTE 说明根因，而不是假装通过。
//   4. 每个 FAIL 都带上"调了什么 / 期望什么 / 实际得到什么"。
//
// Run:  npm run richtext
//       AI_BROWSER_PORT=<port> npm run richtext

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { Browser } = require(path.join(ROOT, "tools/browser.cjs"));
const WS_HOST = "127.0.0.1";
// 端口可配：默认 9223。启动 Electron 时必须把这个值传下去，否则浏览器仍监听 9223。
const WS_PORT = Number(process.env.AI_BROWSER_PORT) || 9223;
const GLOBAL_TIMEOUT_MS = Number(process.env.AI_BROWSER_E2E_TIMEOUT_MS) || 360000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// fixtures —— 全部本地、离线可重复
// ===========================================================================

// A: 富文本编辑器（contenteditable + 工具栏 + 字数统计）。
// 工具栏按钮用 mousedown preventDefault 保住编辑器选区 —— 真实编辑器（Quill /
// ProseMirror / wangEditor）都是这么做的，不是为测试开的后门。
const EDITOR_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>RichEditorFixture</title>
<style>
#toolbar button{padding:4px 8px;margin:0 4px 4px 0}
#editor{border:1px solid #888;min-height:120px;padding:8px;margin-top:6px}
#subMenu,#sub3{list-style:none;margin:0;padding:6px;border:1px solid #999}
</style></head><body>
<h2>富文本编辑器</h2>
<div id="toolbar">
  <button id="btnBold" type="button">加粗</button>
  <button id="btnItalic" type="button">斜体</button>
  <button id="btnH1" type="button">H1</button>
  <button id="btnH2" type="button">H2</button>
  <button id="btnOl" type="button">有序列表</button>
  <button id="btnUl" type="button">无序列表</button>
  <button id="btnQuote" type="button">引用</button>
  <button id="btnCode" type="button">代码块</button>
</div>
<div id="editor" contenteditable="true"></div>
<p id="cntP">字数 <span id="cntNum">0</span>/256</p>
<span id="cntSpan">0/256</span>
<script>
(function(){
  var ed = document.getElementById('editor');
  var cmds = {
    btnBold: ['bold', null], btnItalic: ['italic', null],
    btnH1: ['formatBlock', 'h1'], btnH2: ['formatBlock', 'h2'],
    btnOl: ['insertOrderedList', null], btnUl: ['insertUnorderedList', null],
    btnQuote: ['formatBlock', 'blockquote'], btnCode: ['formatBlock', 'pre']
  };
  Object.keys(cmds).forEach(function(id){
    var b = document.getElementById(id);
    if (!b) return;
    b.addEventListener('mousedown', function(e){ e.preventDefault(); });
    b.addEventListener('click', function(){
      ed.focus();
      document.execCommand(cmds[id][0], false, cmds[id][1]);
      upd();
    });
  });
  function upd(){
    var t = (ed.innerText || '').length;
    var n = document.getElementById('cntNum'); if (n) n.textContent = String(t);
    var s = document.getElementById('cntSpan'); if (s) s.textContent = t + '/256';
  }
  ed.addEventListener('input', upd);
  window.__editorReady = true;
})();
</script>
</body></html>`;

// B: 二级 / 三级嵌套菜单（hover 展开，点击落库到 #menuOut）
const MENU_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>NestedMenuFixture</title>
<style>
ul{margin:0;padding:6px;border:1px solid #999;list-style:none;background:#fff}
#navWrap{display:inline-block}
#subMenu,#sub3{position:absolute;min-width:150px}
#sub3{left:150px;top:0}
li{position:relative}
</style></head><body>
<h2>嵌套菜单</h2>
<div id="navWrap">
  <button id="menuRoot" type="button">主菜单</button>
  <ul id="subMenu" style="display:none">
    <li><button id="lv2a" type="button">二级-导出</button></li>
    <li><button id="lv2b" type="button">二级-分享</button></li>
    <li id="lv2cWrap"><button id="lv2c" type="button">二级-更多</button>
      <ul id="sub3" style="display:none">
        <li><button id="lv3a" type="button">三级-导出PDF</button></li>
        <li><button id="lv3b" type="button">三级-导出Word</button></li>
      </ul>
    </li>
  </ul>
</div>
<p id="menuOut">未选择</p>
<script>
(function(){
  var wrap = document.getElementById('navWrap');
  var sub = document.getElementById('subMenu');
  var sub3 = document.getElementById('sub3');
  var out = document.getElementById('menuOut');
  window.__log = [];
  function lg(s){ window.__log.push(s); if (window.__log.length > 40) window.__log.shift(); }
  wrap.addEventListener('mouseenter', function(){ lg('enter:wrap'); sub.style.display = 'block'; });
  wrap.addEventListener('mouseleave', function(){ lg('leave:wrap'); sub.style.display = 'none'; sub3.style.display = 'none'; });
  wrap.addEventListener('mouseover', function(e){ lg('over:' + ((e.target && e.target.id) || (e.target && e.target.tagName))); });
  wrap.addEventListener('mousemove', function(e){ lg('move:' + ((e.target && e.target.id) || (e.target && e.target.tagName))); });
  document.getElementById('lv2cWrap').addEventListener('mouseenter', function(){ lg('enter:lv2cWrap'); sub3.style.display = 'block'; });
  window.__lv2Clicks = 0;
  window.__lv3Clicks = 0;
  ['lv2a','lv2b'].forEach(function(id){
    document.getElementById(id).addEventListener('click', function(){
      window.__lv2Clicks++;
      out.textContent = 'L2:' + this.textContent;
    });
  });
  ['lv3a','lv3b'].forEach(function(id){
    document.getElementById(id).addEventListener('click', function(){
      window.__lv3Clicks++;
      out.textContent = 'L3:' + this.textContent;
    });
  });
  window.__menuReady = true;
})();
</script>
</body></html>`;

// C+D: 复杂表单（必填/选填/字数上限）+ 报错与异常（字段级/表单级/toast/弹窗/服务端）
// 刻意放两套容器：普通 <form>（class 不含 modal 关键词，模拟"页面即表单"的站点）
// 与 .publish-modal（class 含 modal 关键词，模拟"弹窗里做表单"的站点）——
// 本项目 context.modals 只扫描后者，这个差异正是要测出来的能力边界。
const FORM_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>ComplexFormFixture</title>
<style>
.row{margin-bottom:8px}
.field-error{color:#e02020;font-size:12px}
.error-summary{color:#e02020;border:1px solid #e02020;padding:6px}
.toast{position:fixed;left:10px;bottom:10px;background:#333;color:#fff;padding:6px 10px}
.server-error{color:#e02020}
.publish-modal{border:2px solid #06c;padding:10px;margin-top:12px}
.req-star{color:#e02020}
</style></head><body>
<h2>复杂表单</h2>
<form id="nativeForm">
  <div class="row"><label for="n1">用户名</label><input id="n1" required></div>
  <button id="nativeSubmit" type="submit">原生校验提交</button>
</form>
<p id="nativeOut">未提交</p>
<!-- novalidate：关掉浏览器原生约束校验，让站点自己的 JS 校验跑起来（原生校验被拦时
     只弹一个气泡，agent 看不到，提交事件根本不触发 —— 这点另由 D-00 单独测量） -->
<form id="plainForm" novalidate>
  <div class="row"><label for="f1" id="labF1">姓名<span class="req-star">*</span></label><input id="f1" required></div>
  <div class="row"><label for="f2" id="labF2">手机<span class="req-star">*</span></label><input id="f2" aria-required="true"></div>
  <div class="row"><label for="f3" id="labF3">邮箱（选填）</label><input id="f3"></div>
  <div class="row"><label for="f4">简介</label><textarea id="f4" maxlength="256"></textarea>
    <span id="f4cnt" class="counter">0/256</span></div>
  <div class="row"><span id="errF1" class="field-error" style="display:none">姓名不能为空</span></div>
  <div class="row"><span id="errF2" class="field-error" style="display:none">手机不能为空</span></div>
  <button id="submitBtn" type="submit">提交</button>
</form>
<div id="errSummary" class="error-summary" style="display:none"></div>
<div id="toast" class="toast" style="display:none">提交失败，请检查表单</div>
<div id="toastRole" role="status" style="display:none">已保存草稿</div>
<div id="serverErr" class="server-error" style="display:none">服务器错误：内容包含敏感词（500）</div>
<button id="serverErrBtn" type="button">触发服务端错误</button>
<button id="openDialog" type="button">打开对话框</button>

<div id="publishModal" class="publish-modal">
  <h3>发布文章</h3>
  <div class="row"><label for="mTitle" id="labMT">标题<span class="req-star">*</span></label>
    <input id="mTitle" required aria-describedby="mErr"></div>
  <div class="row"><label for="mBody">正文</label><textarea id="mBody" maxlength="140"></textarea></div>
  <p id="mLimit">0/140</p>
  <div id="mErr" class="field-error" style="display:none">标题不能为空</div>
  <div id="mSummary" class="error-summary" style="display:none"></div>
  <div id="mToast" class="toast" style="display:none">发布失败，请检查</div>
  <button id="mOk" type="button">确定</button>
  <button id="mCancel" type="button">取消</button>
</div>

<div id="roleDialog" role="dialog" style="display:none;border:1px solid #333;padding:10px">
  <p>确认删除这篇文章？</p>
  <button id="dlgOk" type="button">确认</button>
  <button id="dlgClose" type="button">关闭</button>
</div>

<script>
(function(){
  function show(el, on){ if (el) el.style.display = on ? 'block' : 'none'; }
  document.getElementById('nativeForm').addEventListener('submit', function(e){
    e.preventDefault();
    document.getElementById('nativeOut').textContent = '已提交';
  });
  document.getElementById('plainForm').addEventListener('submit', function(e){
    e.preventDefault();
    var msgs = [];
    var f1 = document.getElementById('f1'), f2 = document.getElementById('f2');
    var e1 = !f1.value, e2 = !f2.value;
    show(document.getElementById('errF1'), e1);
    show(document.getElementById('errF2'), e2);
    if (e1) msgs.push('姓名不能为空');
    if (e2) msgs.push('手机不能为空');
    var sum = document.getElementById('errSummary');
    sum.textContent = msgs.length ? ('请修正以下问题：' + msgs.join('；')) : '';
    show(sum, msgs.length > 0);
    show(document.getElementById('toast'), true);
    show(document.getElementById('toastRole'), true);
  });
  document.getElementById('serverErrBtn').addEventListener('click', function(){
    show(document.getElementById('serverErr'), true);
  });
  document.getElementById('openDialog').addEventListener('click', function(){
    show(document.getElementById('roleDialog'), true);
  });
  document.getElementById('dlgClose').addEventListener('click', function(){
    show(document.getElementById('roleDialog'), false);
  });
  document.getElementById('mOk').addEventListener('click', function(){
    var t = document.getElementById('mTitle');
    var bad = !t.value;
    show(document.getElementById('mErr'), bad);
    var sum = document.getElementById('mSummary');
    sum.textContent = bad ? '请修正以下问题：标题不能为空' : '';
    show(sum, bad);
    show(document.getElementById('mToast'), bad);
  });
  document.getElementById('mBody').addEventListener('input', function(){
    var p = document.getElementById('mLimit');
    if (p) p.textContent = (this.value || '').length + '/140';
  });
  document.getElementById('f4').addEventListener('input', function(){
    var c = document.getElementById('f4cnt');
    if (c) c.textContent = (this.value || '').length + '/256';
  });
  window.__formReady = true;
})();
</script>
</body></html>`;

// E: 单选 / 多选 / 原生 select / 自定义 combobox / tag input / 微博式话题
const CHOICE_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>ChoiceFixture</title>
<style>
.tag{display:inline-block;background:#eef;padding:2px 6px;margin-right:4px}
.topic{color:#06c}
.field-error{color:#e02020;font-size:12px}
#comboList,#topicList{border:1px solid #999;padding:4px;background:#fff}
#topicEditor{border:1px solid #888;min-height:60px;padding:6px}
</style></head><body>
<h2>选择与标签</h2>

<h3>单选</h3>
<div>
  <input type="radio" name="plan" id="planA" value="A"><label for="planA">方案A</label>
  <input type="radio" name="plan" id="planB" value="B"><label for="planB">方案B</label>
  <input type="radio" name="plan" id="planC" value="C"><label for="planC">方案C</label>
</div>
<p id="planOut">未选择</p>

<h3>多选</h3>
<div>
  <input type="checkbox" id="cb1" value="x"><label for="cb1">选项一</label>
  <input type="checkbox" id="cb2" value="y"><label for="cb2">选项二</label>
  <input type="checkbox" id="cb3" value="z"><label for="cb3">选项三</label>
</div>
<p id="cbOut">已选 0 项</p>

<h3>原生下拉</h3>
<select id="sel">
  <option value="">请选择</option>
  <option value="beijing">北京</option>
  <option value="shanghai">上海</option>
</select>
<p id="selOut">未选择</p>

<h3>自定义下拉</h3>
<div id="combo" role="combobox" aria-expanded="false">
  <button id="comboBtn" type="button">请选择城市</button>
  <span id="comboVal"></span>
  <div id="comboList" style="display:none">
    <button id="optBj" type="button">北京</button>
    <button id="optSh" type="button">上海</button>
  </div>
</div>

<h3>标签输入</h3>
<div id="tagWrap">
  <span id="tagList"></span>
  <input id="tagInput" placeholder="输入标签后回车">
</div>
<span id="tagDup" class="field-error" style="display:none">标签重复</span>
<p id="tagOut">共 0 个标签</p>

<h3>微博式话题</h3>
<div id="topicEditor" contenteditable="true"></div>
<div id="topicList" style="display:none">
  <button id="topic1" type="button">#今日天气#</button>
  <button id="topic2" type="button">#人工智能#</button>
</div>
<script>
(function(){
  var planOut = document.getElementById('planOut');
  ['planA','planB','planC'].forEach(function(id){
    document.getElementById(id).addEventListener('change', function(){
      planOut.textContent = '已选:' + this.value;
    });
  });
  var cbs = ['cb1','cb2','cb3'];
  function cbUpd(){
    var n = cbs.filter(function(i){ return document.getElementById(i).checked; }).length;
    document.getElementById('cbOut').textContent = '已选 ' + n + ' 项';
  }
  cbs.forEach(function(id){ document.getElementById(id).addEventListener('change', cbUpd); });

  document.getElementById('sel').addEventListener('change', function(){
    document.getElementById('selOut').textContent = '已选:' + this.value;
  });

  var combo = document.getElementById('combo');
  document.getElementById('comboBtn').addEventListener('click', function(){
    var open = document.getElementById('comboList').style.display !== 'none';
    document.getElementById('comboList').style.display = open ? 'none' : 'block';
    combo.setAttribute('aria-expanded', open ? 'false' : 'true');
  });
  ['optBj','optSh'].forEach(function(id){
    document.getElementById(id).addEventListener('click', function(){
      document.getElementById('comboVal').textContent = this.textContent;
      document.getElementById('comboList').style.display = 'none';
      combo.setAttribute('aria-expanded', 'false');
    });
  });

  // tag input
  var tags = [];
  var tagInput = document.getElementById('tagInput');
  var dup = document.getElementById('tagDup');
  function render(){
    document.getElementById('tagList').innerHTML = tags.map(function(t, i){
      return '<span class="tag" id="tag_' + i + '">#' + t +
             '<button type="button" id="del_' + i + '" class="tag-del">x</button></span>';
    }).join('');
    document.getElementById('tagOut').textContent = '共 ' + tags.length + ' 个标签';
    for (var i = 0; i < tags.length; i++) {
      (function(idx){
        var d = document.getElementById('del_' + idx);
        if (d) d.addEventListener('click', function(){ tags.splice(idx, 1); render(); });
      })(i);
    }
  }
  function addTag(v){
    v = String(v || '').replace(/[,，]/g, '').trim();
    if (!v) return;
    if (tags.indexOf(v) >= 0) { dup.style.display = 'inline'; return; }
    dup.style.display = 'none';
    tags.push(v);
    render();
  }
  tagInput.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      addTag(this.value);
      this.value = '';
    }
  });
  render();

  // 微博式话题：输入 '#' 触发候选
  var ted = document.getElementById('topicEditor');
  var tlist = document.getElementById('topicList');
  function refresh(){
    var t = (ted.innerText || '');
    tlist.style.display = (t.length === 0 || t.charAt(t.length - 1) === '#') && t.indexOf('#') >= 0
      ? 'block' : 'none';
  }
  ted.addEventListener('input', refresh);
  window.__topicClicks = 0;
  ['topic1','topic2'].forEach(function(id){
    var b = document.getElementById(id);
    b.addEventListener('mousedown', function(e){ e.preventDefault(); });
    b.addEventListener('click', function(){
      window.__topicClicks++;
      ted.focus();
      document.execCommand('insertHTML', false,
        '<span class="topic" contenteditable="false">' + b.textContent + '</span>&nbsp;');
      tlist.style.display = 'none';
    });
  });
  window.__choiceReady = true;
})();
</script>
</body></html>`;

// F: 图片上传
const UPLOAD_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>UploadFixture</title></head><body>
<h2>图片上传</h2>
<input type="file" id="fileInput" accept="image/*">
<p id="upInfo">未选择文件</p>
<img id="preview" alt="预览" style="max-width:150px">
<script>
(function(){
  var inp = document.getElementById('fileInput');
  inp.addEventListener('change', function(){
    var f = this.files && this.files[0];
    if (!f) { document.getElementById('upInfo').textContent = '未选择文件'; return; }
    document.getElementById('upInfo').textContent = '已选择：' + f.name;
    try {
      document.getElementById('preview').src = URL.createObjectURL(f);
    } catch (e) {}
  });
  window.__uploadReady = true;
})();
</script>
</body></html>`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // 与 capabilities fixture 同样的严格 CSP（img-src 放开 blob: 供预览用）。
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self';"
      );
      if (p === "/editor") res.end(EDITOR_PAGE);
      else if (p === "/menu") res.end(MENU_PAGE);
      else if (p === "/form") res.end(FORM_PAGE);
      else if (p === "/choice") res.end(CHOICE_PAGE);
      else if (p === "/upload") res.end(UPLOAD_PAGE);
      else res.end("<!doctype html><html><head><meta charset='utf-8'><title>RichTextFixtures</title></head><body><p>fixtures</p></body></html>");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    function once() {
      const s = net.connect(port, WS_HOST);
      s.once("connect", () => { s.destroy(); resolve(); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout waiting port " + port));
        setTimeout(once, 250);
      });
    }
    once();
  });
}

let PASS = 0, FAIL = 0;
const DEFECTS = [];
const check = (name, cond, detail) => {
  cond ? PASS++ : FAIL++;
  console.log(`  ${cond ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " — " + detail : ""}`);
};
// 能力边界 / 事实记录：不计入 PASS/FAIL。
const note = (text) => console.log(`  NOTE | ${text}`);
// 缺陷登记：跑完统一打印，避免"读不到的事实"被埋没在长输出里。
const defect = (sev, area, text) => DEFECTS.push({ sev, area, text });

async function main() {
  const server = await startServer();
  const HOST = `http://127.0.0.1:${server.address().port}`;

  // 先占端口：有人占着就直接退出，别去打搅正在跑的实例。
  try {
    await waitForPort(WS_PORT, 600);
    console.error(
      "!! port " + WS_PORT + " is busy — stop the running ai-browser first," +
      " or pick a free port with: AI_BROWSER_PORT=<port> npm run richtext"
    );
    process.exit(3);
  } catch { /* free */ }

  // 上传用的真实本地文件（1x1 PNG），提前写盘。
  const tmpFile = path.join(os.tmpdir(), `ai-browser-richtext-${process.pid}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"));
  const tmpBase = path.basename(tmpFile);
  console.log("upload fixture file:", tmpFile);

  const electronPath = require("electron");
  console.log("spawn electron @", electronPath, "port", WS_PORT);
  const childEnv = { ...process.env, AI_BROWSER_PORT: String(WS_PORT) };
  // ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 模式启动 —— 不起窗口、
  // 不监听 WS，测试永远等不到端口。这里要的是真正的应用进程，故剔除。
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 默认用独立 profile。不只是为了避免单实例锁打架：~/.ai-browser 是用户的
  // 真实 profile（存着登录态），测试不该看见、更不该动到它。
  if (!childEnv.AI_BROWSER_USER_DATA) {
    childEnv.AI_BROWSER_USER_DATA = `/tmp/ai-browser-e2e-${WS_PORT}`;
  }
  console.log("userData:", childEnv.AI_BROWSER_USER_DATA);
  const child = spawn(electronPath, ["."], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: childEnv,
  });
  await waitForPort(WS_PORT, 30000);
  console.log("WS ready on", WS_PORT);

  const b = new Browser(WS_PORT);
  await b.ready();

  // ---- 通用读写助手 -------------------------------------------------------
  const rawTree = (tab) => b.call("ui.get_tree", { tab });
  const treeOf = async (tab) => {
    const raw = await rawTree(tab);
    const r = (raw && raw.result) || {};
    return (r.tree || r.root || r);
  };
  const ctxOf = async (tab) => {
    const raw = await rawTree(tab);
    return (raw && raw.result && raw.result.context) || null;
  };
  const findNode = (node, id) => {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const n of node) { const f = findNode(n, id); if (f) return f; }
      return null;
    }
    if (node && node.id === id) return node;
    if (node && node.children) return findNode(node.children, id);
    return null;
  };
  const nodeOf = async (tab, id) => findNode(await treeOf(tab), id);
  const ev = async (js, tab) => (await b.call("ui.evaluate", { js, tab }))?.result?.value;
  const act = (action, target, params, tab) =>
    b.call("ui.act", { action, target, params: params || {}, tab });
  const click = (tab, id) => act("click", id, {}, tab);
  const typeInto = (tab, id, text) => act("type", id, { text }, tab);
  const clearInto = (tab, id) => act("clear", id, {}, tab);
  const domText = (tab, id) => ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});return e?e.textContent:null;})()`, tab);
  const domHtml = (tab, id) => ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});return e?e.innerHTML:null;})()`, tab);
  const domVal = (tab, id) => ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});return e?e.value:null;})()`, tab);
  const shown = (tab, id) => ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});if(!e)return null;return e.style.display!=='none'&&e.getClientRects().length>0;})()`, tab);
  const openTab = async (pathname) => {
    const t = (await b.call("ui.new_tab", { url: HOST + pathname })).result?.tab;
    await b.call("ui.set_active_tab", { tab: t });
    await sleep(1600);
    await b.call("ui.get_tree", { tab: t }); // 写入 data-ai-id
    return t;
  };
  // 在可编辑宿主里按文本选中一段（选区是富文本最容易出问题的地方）
  const selectIn = (tab, hostId, needle) => ev(
    `(function(host,needle){var ed=document.getElementById(host);if(!ed)return {ok:false};ed.focus();` +
    `var w=document.createTreeWalker(ed,NodeFilter.SHOW_TEXT,null,false);var n;` +
    `while((n=w.nextNode())){var i=n.nodeValue.indexOf(needle);if(i>=0){` +
    `var r=document.createRange();r.setStart(n,i);r.setEnd(n,i+needle.length);` +
    `var s=window.getSelection();s.removeAllRanges();s.addRange(r);` +
    `return {ok:true,selected:s.toString()};}}return {ok:false};})` +
    `(${JSON.stringify(hostId)},${JSON.stringify(needle)})`, tab);
  // context.forms[].fields[] 里按 id 找字段
  const formField = (ctx, id) => {
    const forms = (ctx && ctx.forms) || [];
    for (const f of forms) for (const fld of (f.fields || [])) if (fld.id === id) return fld;
    return null;
  };
  // context.modals[] 里按 type 找字段（modals[].fields[] 的条目不带 id，见 D-06c）
  const modalFieldByType = (ctx, type) => {
    for (const m of ((ctx && ctx.modals) || [])) {
      for (const f of (m.fields || [])) if (f.type === type) return f;
    }
    return null;
  };
  const allModalHints = (ctx) => {
    const out = [];
    for (const m of ((ctx && ctx.modals) || [])) for (const h of (m.required_hints || [])) out.push(h);
    return out;
  };
  const allModalErrors = (ctx) => {
    const out = [];
    for (const m of ((ctx && ctx.modals) || [])) for (const e of (m.errors || [])) out.push(e);
    return out;
  };
  const allModalButtons = (ctx) => {
    const out = [];
    for (const m of ((ctx && ctx.modals) || [])) for (const btn of (m.buttons || [])) out.push(btn.text);
    return out;
  };

  // =======================================================================
  // A. 富文本编辑器
  // =======================================================================
  console.log("\n[A. 富文本编辑器 — 段落结构 / 工具栏 / 选区格式化 / 排版]");
  const edTab = await openTab("/editor");

  const edNode0 = await nodeOf(edTab, "editor");
  check("A-01 语义树识别 contenteditable 编辑器（editor_type）",
    !!(edNode0 && edNode0.editor_type === "contenteditable"),
    edNode0 ? `editor_type=${edNode0.editor_type} role=${edNode0.role}` : "node missing");
  check("A-02 工具栏按钮在语义树中可读且带 click 动作",
    await (async () => {
      const n = await nodeOf(edTab, "btnBold");
      return !!(n && n.role === "button" && Array.isArray(n.actions) && n.actions.indexOf("click") >= 0);
    })(),
    JSON.stringify(await nodeOf(edTab, "btnBold") && (await nodeOf(edTab, "btnBold")).actions));

  // --- 多段输入：段落结构 ---
  await clearInto(edTab, "editor");
  await sleep(300);
  await typeInto(edTab, "editor", "第一段内容\n第二段内容\n第三段内容");
  await sleep(700);
  const aHtml = String(await domHtml(edTab, "editor") || "");
  const aText = String(await ev("(function(){return document.getElementById('editor').innerText;})()", edTab) || "");
  const aBlocks = Number(await ev("(function(){return document.getElementById('editor').querySelectorAll('p,div').length;})()", edTab) || 0);
  check("A-03 contenteditable 多段输入 → 真实 DOM 三段文字都在",
    aText.indexOf("第一段内容") >= 0 && aText.indexOf("第二段内容") >= 0 && aText.indexOf("第三段内容") >= 0,
    JSON.stringify(aText));
  check("A-04 contenteditable 多段输入 → 真实 DOM 产生块级元素（段落结构）",
    aBlocks >= 2, "blocks=" + aBlocks + " html=" + JSON.stringify(aHtml.slice(0, 160)));
  const aEdNode = await nodeOf(edTab, "editor");
  const aEB = (aEdNode && aEdNode.editor_blocks) || [];
  check("A-05 语义树 editor_blocks 读出多段（不把全文揉成一段）",
    aEB.length >= 2, "blocks=" + aEB.length + " " + JSON.stringify(aEB.map((x) => x.role + ":" + x.text).slice(0, 4)));
  if (aEB.length < 2) {
    defect("P1", "A/段落结构",
      `editor_blocks 只给出 ${aEB.length} 段（DOM 实有 ${aBlocks} 块）。根因：extractor.cjs:171 ` +
      `extractEditorBlocks 只取可编辑元素的"元素子节点"，首段若是裸文本节点（未被块元素包裹）就被漏掉。`);
  }

  // clear 到底清不干净？残留的空块外壳会让后续排版一层层套进去（h2>blockquote>pre>…），
  // 所以先单独量一次，再用"硬重置"给每个排版用例一个干净起点。
  await typeInto(edTab, "editor", "排版残留测试");
  await sleep(400);
  await selectIn(edTab, "editor", "排版残留测试");
  await click(edTab, "btnH2");
  await sleep(400);
  await clearInto(edTab, "editor");
  await sleep(500);
  const afterClear = String(await domHtml(edTab, "editor") || "");
  check("A-05b ui.act clear 后 contenteditable 彻底清空（无残留块外壳）",
    /^\s*(<br\s*\/?>|<div>\s*(<br\s*\/?>)?\s*<\/div>)?\s*$/i.test(afterClear), JSON.stringify(afterClear));
  if (!/^\s*(<br\s*\/?>|<div>\s*(<br\s*\/?>)?\s*<\/div>)?\s*$/i.test(afterClear)) {
    defect("P1", "A/清空不彻底",
      `ui.act clear 后编辑器残留 ${JSON.stringify(afterClear)}（一个空的块元素外壳）。` +
      "根因：_inputViaCdp 的清空是 selectAll + 受信 Delete，只删文本不删外层块标签；" +
      "浏览器会保留至少一个空块。后果：连续排版时新块一层层嵌进旧外壳里" +
      "（实测出现 h2>blockquote>pre>ul>li 的套娃），语义树 editor_blocks 的 role 也随之失真（A-14）。");
  }
  // 测试装置用的硬重置（不是被测能力）—— 保证每个排版用例从空编辑器出发。
  const hardReset = async (tab, id) => {
    await ev(`(function(){var e=document.getElementById(${JSON.stringify(id)});if(e){e.innerHTML='';}return true;})()`, tab);
    await sleep(150);
  };

  // --- 选区 + 工具栏：加粗 / 斜体 ---
  const fmtCase = async (label, text, word, btnId, re, tagName) => {
    await hardReset(edTab, "editor");
    await sleep(200);
    await typeInto(edTab, "editor", text);
    await sleep(500);
    const sel = await selectIn(edTab, "editor", word);
    if (!sel || !sel.ok) {
      check(`A-${label} 选中「${word}」为操作做准备`, false, JSON.stringify(sel));
      return { actRes: null, html: "" };
    }
    const actRes = await click(edTab, btnId);
    await sleep(500);
    const html = String(await domHtml(edTab, "editor") || "");
    check(`A-${label} 选中「${word}」→ 点「${btnId}」→ 真实 DOM 生成 ${tagName}`,
      re.test(html),
      "act=" + JSON.stringify(actRes && actRes.result) + " html=" + JSON.stringify(html.slice(0, 180)));
    return { actRes, html };
  };

  const bold = await fmtCase("06", "这是一段要加粗的文字", "要加粗", "btnBold", /<(b|strong)\b/i, "<b>/<strong>");
  check("A-06b act 报的 success 与真实 DOM 变化一致（不许谎报）",
    (bold.actRes && bold.actRes.result && bold.actRes.result.success === true) === /<(b|strong)\b/i.test(bold.html || ""),
    "act=" + JSON.stringify(bold.actRes && bold.actRes.result));
  const ital = await fmtCase("07", "这是一段要倾斜的文字", "要倾斜", "btnItalic", /<(i|em)\b/i, "<i>/<em>");
  check("A-07b 斜体后 act success 与 DOM 一致",
    (ital.actRes && ital.actRes.result && ital.actRes.result.success === true) === /<(i|em)\b/i.test(ital.html || ""),
    "act=" + JSON.stringify(ital.actRes && ital.actRes.result));

  await fmtCase("08", "这是一个标题", "这是一个标题", "btnH1", /<h1\b/i, "<h1>");
  await fmtCase("09", "这是一个副标题", "这是一个副标题", "btnH2", /<h2\b/i, "<h2>");
  await fmtCase("10", "第一步准备工作", "第一步准备工作", "btnOl", /<ol\b[\s\S]*<li\b/i, "<ol><li>");
  await fmtCase("11", "要点一内容", "要点一内容", "btnUl", /<ul\b[\s\S]*<li\b/i, "<ul><li>");
  await fmtCase("12", "引用的话", "引用的话", "btnQuote", /<blockquote\b/i, "<blockquote>");
  await fmtCase("13", "console.log(1)", "console.log(1)", "btnCode", /<pre\b/i, "<pre>");

  // 排版结果能否被语义树读懂（editor_blocks 的 role）
  await hardReset(edTab, "editor");
  await sleep(200);
  await typeInto(edTab, "editor", "引用一句名言");
  await sleep(400);
  await selectIn(edTab, "editor", "引用一句名言");
  await click(edTab, "btnQuote");
  await sleep(500);
  const qNode = await nodeOf(edTab, "editor");
  const qRoles = ((qNode && qNode.editor_blocks) || []).map((x) => x.role);
  check("A-14 排版（blockquote）后 editor_blocks 的 role 反映块类型",
    qRoles.indexOf("blockquote") >= 0, JSON.stringify(qRoles));
  const qDom = String(await domHtml(edTab, "editor") || "");
  check("A-15 排版（blockquote）在真实 DOM 生效（tree 与 DOM 一致）",
    /<blockquote\b/i.test(qDom) === (qRoles.indexOf("blockquote") >= 0), JSON.stringify(qDom.slice(0, 120)));

  // 字数限制提示
  await hardReset(edTab, "editor");
  await sleep(200);
  await typeInto(edTab, "editor", "字数统计测试");
  await sleep(500);
  const cntPNode = await nodeOf(edTab, "cntP");
  check("A-16 字数提示（放在 <p> 内）语义树可读",
    !!(cntPNode && String(cntPNode.label).indexOf("/256") >= 0), JSON.stringify(cntPNode && cntPNode.label));
  const cntSpanNode = await nodeOf(edTab, "cntSpan");
  check("A-17 字数提示（放在裸 <span> 内）语义树读不到 —— 边界事实",
    cntSpanNode === null, cntSpanNode ? "unexpectedly present: " + JSON.stringify(cntSpanNode.label) : "absent (边界证据)");
  if (cntSpanNode === null) {
    defect("P1", "A+C/提示文本",
      "裸 <span>/<div> 里的辅助文本（字数、提示、说明）在语义树中完全不可见。" +
      "根因：extractor.cjs:35 isPureLayout 把无 role/无 aria 的 div/span 当纯布局剪掉，" +
      "process() 对无语义子节点的纯布局元素直接返回 null。站点普遍用 span/div 放这类文案，" +
      "agent 只能靠 ui.evaluate 兜底。");
  }
  const cntSpanEval = await domText(edTab, "cntSpan");
  check("A-18 字数提示（裸 span）走 ui.evaluate 兜底可读",
    String(cntSpanEval).indexOf("/256") >= 0, JSON.stringify(cntSpanEval));
  note("辅助文案（字数/提示/说明）能否被语义树读到，取决于它落在什么标签里：<p>/<li>/<label>/<small> "
    + "等语义标签可读，裸 <span>/<div> 被 isPureLayout 剪掉。给 agent 的实操结论：读这类文案要主动 evaluate。");

  // =======================================================================
  // B. 嵌套菜单（二级 / 三级）+ ui.peek 实测评估
  // =======================================================================
  console.log("\n[B. 嵌套菜单 — 二级/三级按钮 + ui.peek 实测]");
  const mnTab = await openTab("/menu");
  await b.call("ui.set_active_tab", { tab: mnTab });
  await sleep(400);

  const subHiddenAtFirst = await nodeOf(mnTab, "lv2a");
  check("B-01 初始状态二级菜单项不在语义树中（未展开）",
    subHiddenAtFirst === null, subHiddenAtFirst ? "unexpectedly visible" : "absent");

  // 菜单状态探针：二级/三级 display + 当前 :hover 链 + 鼠标事件日志
  const menuProbe = () => ev(
    "(function(){var s=document.getElementById('sub3'),c=document.getElementById('lv2c');" +
    "var r=c.getBoundingClientRect();var cx=Math.round(r.x+r.width/2),cy=Math.round(r.y+r.height/2);" +
    "var h=document.elementFromPoint(cx,cy);var hl=document.querySelectorAll(':hover');" +
    "var hids=[];for(var i=0;i<hl.length;i++){hids.push(hl[i].id||hl[i].tagName);}" +
    "return {subMenu:document.getElementById('subMenu').style.display,sub3:s.style.display," +
    "lv2cCenter:{x:cx,y:cy},hit:h?(h.id||h.tagName):null,aiid:c.getAttribute('data-ai-id')," +
    "hover:hids,log:(window.__log||[]).slice(-6)};})()", mnTab);
  // 把鼠标移开，让 hover-menu 回到确定的收起状态（二级/三级都收起）
  const parkMouse = async () => {
    await b.call("ui.peek", { tab: mnTab, target: "menuRoot", hoverMs: 50, revertMs: 60 });
    await sleep(900);
  };

  // --- 三级：先测（鼠标从干净的收起态进入，路径最短）---
  await parkMouse();
  await b.call("ui.peek", { tab: mnTab, target: "menuRoot", hoverMs: 600, revertMs: 0 });
  await sleep(500);
  await b.call("ui.get_tree", { tab: mnTab });
  const pre3 = await menuProbe();
  const peek2 = await b.call("ui.peek", { tab: mnTab, target: "lv2c", hoverMs: 700, revertMs: 0 });
  await sleep(500);
  const p2 = (peek2 && peek2.result) || {};
  const p2Labels = (p2.revealed || []).map((n) => n.label);
  const post3 = await menuProbe();
  check("B-02 ui.peek(二级项) 探出三级项",
    p2Labels.some((l) => String(l).indexOf("三级") >= 0),
    "revealed=" + JSON.stringify(p2Labels) + " err=" + String(p2.error || "") +
    "\n            peek 前=" + JSON.stringify(pre3) + "\n            peek 后=" + JSON.stringify(post3));
  await sleep(1900); // 等 peek 强制的 revert（revertMs 传 0 无效，见 B-14）走完，否则鼠标被移开会关掉菜单
  // 对照：不用 peek，act hover 二级项
  await parkMouse();
  await b.call("ui.act", { action: "hover", target: "menuRoot", tab: mnTab });
  await sleep(500);
  await b.call("ui.get_tree", { tab: mnTab });
  await b.call("ui.act", { action: "hover", target: "lv2c", tab: mnTab });
  await sleep(700);
  const post3Hover = await menuProbe();
  check("B-03 对照路径：act hover(二级项) 后三级菜单真实展开",
    post3Hover && post3Hover.sub3 === "block", JSON.stringify(post3Hover));
  if (!(post3Hover && post3Hover.sub3 === "block")) {
    defect("P1", "B/三级菜单",
      "悬停二级项无法展开三级菜单（peek 与 act hover 两条路径都失败）。实测：peek 前 " +
      JSON.stringify(pre3) + "，peek 后 " + JSON.stringify(post3) +
      "，act hover 后 " + JSON.stringify(post3Hover) + "。");
  }
  await b.call("ui.get_tree", { tab: mnTab });
  const lv3bNode = await nodeOf(mnTab, "lv3b");
  check("B-04 三级项出现在语义树中可被 act 定位",
    !!(lv3bNode && lv3bNode.role === "button"), JSON.stringify(lv3bNode && { role: lv3bNode.role, label: lv3bNode.label }));
  const click3 = await click(mnTab, "lv3b");
  await sleep(400);
  const out3 = await domText(mnTab, "menuOut");
  check("B-05 点击三级项 → 真实 DOM 的输出文本变为 L3",
    String(out3).indexOf("L3:三级-导出Word") >= 0, "act=" + JSON.stringify(click3 && click3.result) + " out=" + JSON.stringify(out3));
  const lv3Clicks = await ev("window.__lv3Clicks", mnTab);
  check("B-05b 一次 ui.act click 只触发一次 click（三级项不重复触发）",
    Number(lv3Clicks) === 1, "clicks=" + lv3Clicks);

  // --- 二级 ---
  await parkMouse();
  const p1 = await (async () => {
    const r = await b.call("ui.peek", { tab: mnTab, target: "menuRoot", hoverMs: 600, revertMs: 0 });
    await sleep(500);
    return (r && r.result) || {};
  })();
  const p1Labels = (p1.revealed || []).map((n) => n.label);
  check("B-06 ui.peek(menuRoot) 返回非空 revealed（AX 差分探到二级项）",
    (p1.revealed || []).length >= 1, JSON.stringify(p1).slice(0, 300));
  check("B-07 ui.peek 的 revealed 里含二级菜单项文案",
    p1Labels.some((l) => String(l).indexOf("二级") >= 0), JSON.stringify(p1Labels));
  const lv2aNode = await nodeOf(mnTab, "lv2a");
  check("B-08 peek 后（revertMs=0）二级项出现在语义树中，可被 act 定位",
    !!(lv2aNode && lv2aNode.role === "button"), JSON.stringify(lv2aNode && { role: lv2aNode.role, label: lv2aNode.label }));
  const click2 = await click(mnTab, "lv2a");
  await sleep(400);
  const out2 = await domText(mnTab, "menuOut");
  check("B-09 点击二级项 → 真实 DOM 的输出文本变为 L2",
    String(out2).indexOf("L2:二级-导出") >= 0, "act=" + JSON.stringify(click2 && click2.result) + " out=" + JSON.stringify(out2));
  const lv2Clicks = await ev("window.__lv2Clicks", mnTab);
  check("B-09c 一次 ui.act click 只触发一次 click（二级项不重复触发）",
    Number(lv2Clicks) === 1, "clicks=" + lv2Clicks);
  if (Number(lv2Clicks) !== 1 || Number(lv3Clicks) !== 1) {
    defect("P0", "B/点击重复触发",
      `一次 ui.act click 触发了多次 click（二级=${lv2Clicks}，三级=${lv3Clicks}）。` +
      "对'提交/切换/计数'类按钮会直接造成重复提交。");
  }
  note("点击重复触发只在'点击导致目标自身消失/收起'时出现（E-24b 的话题候选按钮点了会收起列表 → 点 2 次），"
    + "而点了之后仍在原位的按钮是正常的（B-09c 二级项、B-05b 三级项均为 1 次）。"
    + "这正是真实站点上'提交后按钮变化'类场景最容易踩的坑。");

  // --- revert 行为 ---
  await parkMouse();
  const afterRevert = await nodeOf(mnTab, "lv2a");
  check("B-10 peek 的 revert（鼠标移开）后二级/三级菜单收起",
    afterRevert === null, afterRevert ? "still present" : "absent（revert 生效）");

  // --- revertMs 语义：0 到底是不是"不回撤" ---
  await parkMouse();
  await b.call("ui.peek", { tab: mnTab, target: "menuRoot", hoverMs: 300, revertMs: 5000 });
  await sleep(2200);
  const keepOpen = await nodeOf(mnTab, "lv2a");
  check("B-13 peek(revertMs=5000) → 2.2s 后菜单仍展开（大 revertMs 生效，作为对照）",
    !!keepOpen, keepOpen ? "still open" : "closed");
  await parkMouse();
  await b.call("ui.peek", { tab: mnTab, target: "menuRoot", hoverMs: 300, revertMs: 0 });
  await sleep(2200);
  const zeroRevert = await nodeOf(mnTab, "lv2a");
  check("B-14 peek(revertMs=0) 语义上是'不回撤' → 2.2s 后菜单应仍展开",
    !!zeroRevert, zeroRevert ? "still open" : "closed（revertMs=0 被当成默认值）");
  if (!zeroRevert) {
    defect("P1", "B/ui.peek",
      "ui.peek 的 revertMs 传 0（表达'别回撤，我要接着点'）不生效，菜单仍在约 1.5s 后被强制收起。" +
      "根因：page_manager.js:336 `Number(opts.revertMs) || 1500` —— 0 是 falsy，被默认值 1500 顶掉；" +
      "hoverMs 同理（`|| 450`）。这条直接废掉'peek 探出来 → 立刻 act click'这个最核心的用法：" +
      "菜单在 agent 点之前就被关掉了。hoverMs 传 0 想跳过等待同样无效。");
  }
  await parkMouse();

  // --- peek 的失败可见性 ---
  const peekBad = await b.call("ui.peek", { tab: mnTab, target: "no-such-target-xyz", hoverMs: 300, revertMs: 60 });
  const pb = (peekBad && peekBad.result) || {};
  const pbHonest = !!pb.error && String(pb.error).length > 0;
  check("B-11 ui.peek 传入不存在的 target 时如实报错（而不是静默返回空 revealed）",
    pbHonest, JSON.stringify(pb));
  if (!pbHonest) {
    defect("P1", "B/ui.peek",
      "ui.peek 定位不到 target 时返回 {revealed:[],hidden:[],mode:'hover'}，不带任何 error —— " +
      "与'hover 了但确实没有可展开项'完全无法区分。根因：page_manager.js:321 `if (!center) return out;` " +
      "直接返回未带 error 的空 out。agent 会误判成'菜单里没有更深的入口'而放弃探索。");
  }

  // --- 对照：不用 peek，用 act hover + get_tree 的常规路径 ---
  await parkMouse();
  await b.call("ui.act", { action: "hover", target: "menuRoot", tab: mnTab });
  await sleep(700);
  const hoverNode = await nodeOf(mnTab, "lv2a");
  check("B-12 对照路径：act hover(menuRoot) + get_tree 同样能拿到二级项",
    !!hoverNode, JSON.stringify(hoverNode && hoverNode.label));
  note("ui.peek 实测结论（全部基于本组实测数据，不空谈）：**能力是真的，但当前实现有三个坑，"
    + "直接决定它在嵌套菜单场景能不能用。**"
    + "\n            (1) 能做什么：真实 CDP mousemove 触发 hover，revealed 给出新出现的可交互项 —— "
    + "二级（B-06/B-07）和三级（B-02）都探到了，agent 不用猜子菜单的 DOM 结构。这是 get_tree 给不了的，"
    + "因为收起状态的子菜单压根不在树里（B-01）。"
    + "\n            (2) 坑一（致命）：**revertMs 传 0 无效**（B-14）。`Number(opts.revertMs) || 1500` 把 0 "
    + "当成缺省值，于是 peek 永远在约 1.5s 后把鼠标移回 (4,4) 收起菜单。'peek 探出来 → 接着 act click' "
    + "这个唯一有价值的用法被废掉：实测 peek(lv2c) 确实探到了三级项，但 1.5s 后菜单关掉，"
    + "等 agent 去点时目标已经不存在（B-02 的 peek 后探针：enter:lv2cWrap 之后紧跟 leave:wrap）。"
    + "当前可绕：peek 完立刻在 1.5s 内 get_tree + act click，或者干脆用 act hover（不会回撤，B-03 验证可行）。"
    + "\n            (3) 坑二：定位不到 target 时**静默返回空 revealed 且不报错**（B-11），和"
    + "'这里确实没有可展开项'不可区分 —— 而新展开出的元素第一次只有 ax-N 句柄，必须再 get_tree "
    + "一次才能拿到稳定的原生 id。"
    + "\n            (4) 缺口：MCP 的 13 个 browse_* 工具没暴露 peek。走 MCP 的 agent 只能退化成 "
    + "act hover + get_tree（B-12 验证走得通），但拿不到'本次 hover 新出现了什么'的差分信息。"
    + "\n            一句话：值得暴露给 MCP，但要先修 revertMs=0 和静默失败这两条，否则暴露了也不好用。");

  // =======================================================================
  // C. 复杂表单：必填 vs 选填
  // =======================================================================
  console.log("\n[C. 复杂表单 — 必填识别 / 选填不被误判 / 字数上限]");
  const fmTab = await openTab("/form");
  await b.call("ui.set_active_tab", { tab: fmTab });
  await sleep(500);
  const ctxC = await ctxOf(fmTab);

  check("C-01 context.forms 能列出表单字段",
    !!((ctxC && ctxC.forms) && ctxC.forms.length > 0), "forms=" + JSON.stringify(ctxC && ctxC.forms).slice(0, 300));

  // 1) required 属性
  const f1 = formField(ctxC, "f1");
  check("C-02 required 属性 → context.forms[].fields[].required 为 true",
    !!(f1 && f1.required === true), JSON.stringify(f1));
  const f1Node = await nodeOf(fmTab, "f1");
  check("C-03 语义树 node.attributes 不含 required（只保留 data-/aria-/name/id/class）—— 边界事实",
    !(f1Node && f1Node.attributes && "required" in f1Node.attributes), JSON.stringify(f1Node && f1Node.attributes));
  note("原生 required 只有一条可读路径：context.forms[].fields[].required（C-02 通过）；"
    + "语义树 node.attributes 里没有它（extractor.cjs:194 extractAttributes 只收 data-/aria-/name/id/class），"
    + "也没有 required 状态位。判断必填必须读 context，只读树会漏。");

  // 2) aria-required
  const f2 = formField(ctxC, "f2");
  check("C-04 aria-required 标记 → context.forms[].fields[].required 读不到（边界事实）",
    !(f2 && f2.required === true), JSON.stringify(f2));
  if (!(f2 && f2.required === true)) {
    defect("P1", "C/必填识别",
      "aria-required=\"true\" 的必填字段在 context.forms[].fields[].required 里报 false。" +
      "根因：extractor.cjs:547 只读原生 `inps[ii].required`，完全不看 aria-required。" +
      "只用 aria-required 标记必填的站点（不少组件库如此）会被 agent 当成选填跳过。");
  }
  const f2Node = await nodeOf(fmTab, "f2");
  const f2Aria = f2Node && f2Node.attributes && f2Node.attributes["aria-required"];
  check("C-05 aria-required 走语义树 node.attributes 兜底可读",
    f2Aria === "true", JSON.stringify(f2Node && f2Node.attributes));
  note("aria-required：context.forms 路径读不到（只读原生 required），但语义树 node.attributes 里"
    + "带 aria-required=\"true\"（extractAttributes 保留 aria-*）。agent 判必填要两条路都看。");

  // 3) 红星标记 —— 普通页面表单 vs 弹窗内表单
  const hintsC = allModalHints(ctxC);
  const hasStarPlain = !!(ctxC && ctxC.required_hints);
  check("C-06 页面级 context.required_hints 字段不存在（该字段只在 modals[] 里）",
    !hasStarPlain, "top-level required_hints=" + JSON.stringify(ctxC && ctxC.required_hints));
  check("C-07 红星标记（在弹窗容器内）→ context.modals[].required_hints 能读到",
    hintsC.some((h) => String(h).indexOf("姓名") >= 0 || String(h).indexOf("标题") >= 0),
    JSON.stringify(hintsC).slice(0, 300));
  const starPlainEval = await ev(
    "(function(){var l=document.getElementById('labF1');return l?l.textContent:null;})()", fmTab);
  check("C-08 红星标记（普通页面表单）走 ui.evaluate 兜底能读到星号",
    String(starPlainEval).indexOf("*") >= 0, JSON.stringify(starPlainEval));
  defect("P2", "C/必填识别",
    "红星（<span class=\"req-star\">*</span>）标记的必填只在 class 含 modal/dialog/popup/drawer/"
    + "overlay/mask 的容器内才被扫进 required_hints（extractor.cjs:469-523 的扫描全在 modal 循环里）。"
    + "普通页面表单里的红星既不在 context.required_hints（该字段压根不在顶层），也不在 forms[].fields 里。");

  // 4) 选填不被误判
  const f3 = formField(ctxC, "f3");
  check("C-09 选填字段 required 为 false（未被误判成必填）",
    !!(f3 && f3.required === false), JSON.stringify(f3));
  const f3Node = await nodeOf(fmTab, "f3");
  const f3Aria = f3Node && f3Node.attributes && f3Node.attributes["aria-required"];
  check("C-10 选填字段不带 aria-required（两条路都不误报）",
    f3Aria === undefined || f3Aria === "false", JSON.stringify(f3Node && f3Node.attributes));

  // 5) 字数上限
  await typeInto(fmTab, "f4", "这是一段简介文字");
  await sleep(500);
  const f4cntEval = await domText(fmTab, "f4cnt");
  check("C-11 字数上限提示「N/256」随输入更新（真实 DOM）",
    /^\d+\/256$/.test(String(f4cntEval || "").trim()), JSON.stringify(f4cntEval));
  const f4cntNode = await nodeOf(fmTab, "f4cnt");
  check("C-12 字数上限提示（裸 span）语义树读不到 —— 边界事实",
    f4cntNode === null, f4cntNode ? "unexpectedly present" : "absent");
  const mLimitNode = await nodeOf(fmTab, "mLimit");
  check("C-13 字数上限提示放在 <p> 内（弹窗中）语义树可读",
    !!(mLimitNode && String(mLimitNode.label).indexOf("/140") >= 0), JSON.stringify(mLimitNode && mLimitNode.label));
  const hintsWithLimit = allModalHints(ctxC);
  check("C-14 字数上限「N/M」被收进 context.modals[].required_hints",
    hintsWithLimit.some((h) => /\d+\s*\/\s*\d+/.test(String(h))), JSON.stringify(hintsWithLimit).slice(0, 300));

  // =======================================================================
  // D. 报错与异常提醒
  // =======================================================================
  console.log("\n[D. 报错与异常 — 字段级/表单级/toast/弹窗/服务端错误]");
  await b.call("ui.set_active_tab", { tab: fmTab });
  await sleep(300);

  // --- 原生 required 约束校验：agent 看不见的静默拦截 ---
  const natAct = await click(fmTab, "nativeSubmit");
  await sleep(600);
  const natOut = await domText(fmTab, "nativeOut");
  check("D-00 原生 required 未填时点击提交 → 浏览器约束校验静默拦截（submit 事件不触发）",
    String(natOut).indexOf("已提交") < 0,
    "act=" + JSON.stringify(natAct && natAct.result) + " out=" + JSON.stringify(natOut));
  note("带原生 required 的表单，字段为空时浏览器直接拦下 submit 并弹一个原生气泡 —— "
    + "act 仍报 success（点击确实发生了），但提交没发生、页面上没有任何 DOM 变化，"
    + "而本项目不截图，agent 无从得知被拦。这是真实站点上极易踩的坑："
    + "要点提交后必须回读页面状态确认是否真的提交成功，不能只看 act 的 success。");

  // --- 字段级错误（普通页面表单，已关掉原生校验）---
  await click(fmTab, "submitBtn");
  await sleep(700);
  const errF1Dom = await domText(fmTab, "errF1");
  const errF1Shown = await shown(fmTab, "errF1");
  check("D-01 提交空必填 → 字段级错误真实出现在 DOM（小红字）",
    errF1Shown === true && String(errF1Dom).indexOf("姓名不能为空") >= 0,
    "shown=" + errF1Shown + " text=" + JSON.stringify(errF1Dom));
  const errF1Node = await nodeOf(fmTab, "errF1");
  check("D-02 字段级错误（<span class=field-error>）语义树读不到 —— 边界事实",
    errF1Node === null, errF1Node ? "unexpectedly present" : "absent");
  if (errF1Node === null) {
    defect("P0", "D/报错读取",
      "字段级错误提示（小红字）在语义树里完全不可见。根因同 A-17：站点普遍用 "
      + "<span>/<div class=\"xxx-error\"> 承载错误文案，被 isPureLayout 剪掉；extractPageContext 的 "
      + "错误扫描（errSel，extractor.cjs:446）只对 modal 容器内部生效。后果：agent 提交了表单却看不到"
      + "哪里错了，只能靠 ui.evaluate 自己找。建议：把 [role=alert] / 常见 error class 的元素提升为语义节点。");
  }
  const errF1Eval = await ev(
    "(function(){var e=document.querySelector('#errF1.field-error');" +
    "return e&&e.style.display!=='none'?e.textContent:null;})()", fmTab);
  check("D-03 字段级错误走 ui.evaluate 兜底可读",
    String(errF1Eval).indexOf("姓名不能为空") >= 0, JSON.stringify(errF1Eval));

  // --- 字段级错误（弹窗内，走 context.modals）---
  await click(fmTab, "mOk");
  await sleep(700);
  const ctxD = await ctxOf(fmTab);
  const mErrShown = await shown(fmTab, "mErr");
  check("D-04 弹窗内提交空必填 → 字段级错误真实出现在 DOM",
    mErrShown === true, "shown=" + mErrShown);
  const dErrors = allModalErrors(ctxD);
  check("D-05 弹窗内字段级错误 → context.modals[].errors 读到",
    dErrors.some((e) => String(e).indexOf("标题不能为空") >= 0), JSON.stringify(dErrors).slice(0, 300));
  const mTitleField = modalFieldByType(ctxD, "text");
  check("D-06 弹窗内字段级错误 → context.modals[].fields[].error 读到（aria-describedby 路径）",
    !!(mTitleField && String(mTitleField.error).indexOf("标题不能为空") >= 0),
    JSON.stringify(mTitleField));
  check("D-07 弹窗内必填字段 → context.modals[].fields[].required 为 true",
    !!(mTitleField && mTitleField.required === true), JSON.stringify(mTitleField));
  const modalFieldHasId = ((ctxD && ctxD.modals) || [])
    .some((m) => (m.fields || []).some((f) => f.id !== undefined));
  check("D-07b context.modals[].fields[] 条目不带 id（无法对应到具体字段）—— 边界事实",
    !modalFieldHasId, "hasId=" + modalFieldHasId);
  if (!modalFieldHasId) {
    defect("P2", "D/弹窗字段",
      "context.modals[].fields[] 的条目只有 type/placeholder/required/error，没有 id —— " +
      "（extractor.cjs:414 起）而 context.forms[].fields[] 是带 id 的（extractor.cjs:543）。" +
      "弹窗里有多个同类输入框时，agent 无法把读到的 error/required 对应到具体元素上，只能靠 placeholder 猜。");
  }

  // --- 表单级错误汇总 ---
  const sumDom = await domText(fmTab, "errSummary");
  check("D-08 表单级错误汇总真实出现在 DOM",
    String(sumDom).indexOf("姓名不能为空") >= 0 && String(sumDom).indexOf("手机不能为空") >= 0,
    JSON.stringify(sumDom));
  const sumNode = await nodeOf(fmTab, "errSummary");
  check("D-09 表单级汇总（普通页面 <div class=error-summary>）语义树读不到 —— 边界事实",
    sumNode === null, sumNode ? "unexpectedly present" : "absent");
  const mSumErrors = allModalErrors(ctxD);
  check("D-10 表单级汇总（在弹窗容器内）→ context.modals[].errors 读到",
    mSumErrors.some((e) => String(e).indexOf("标题不能为空") >= 0), JSON.stringify(mSumErrors).slice(0, 300));
  defect("P2", "D/报错读取",
    "同一份错误汇总，放在 class 含 modal/dialog/popup/drawer/overlay/mask 的容器里就能进 "
    + "context.modals[].errors，放在普通页面容器里就完全读不到 —— 报错能否被读到取决于容器的 class 命名，"
    + "而非它是不是真的弹窗。这是按 class 关键词猜语义的固有脆弱性。");

  // --- toast / 轻提示 ---
  const toastRoleNode = await nodeOf(fmTab, "toastRole");
  check("D-11 toast（role=status）语义树可读",
    !!(toastRoleNode && String(toastRoleNode.label).indexOf("已保存草稿") >= 0),
    JSON.stringify(toastRoleNode && { role: toastRoleNode.role, label: toastRoleNode.label }));
  const toastNode = await nodeOf(fmTab, "toast");
  check("D-12 toast（无 role 的 .toast）语义树读不到 —— 边界事实",
    toastNode === null, toastNode ? "unexpectedly present" : "absent");
  const toastEval = await domText(fmTab, "toast");
  check("D-13 toast 走 ui.evaluate 兜底可读",
    String(toastEval).indexOf("提交失败") >= 0, JSON.stringify(toastEval));
  const mToastErrors = allModalErrors(ctxD);
  check("D-14 弹窗内 toast（class=toast）→ context.modals[].errors 读到",
    mToastErrors.some((e) => String(e).indexOf("发布失败") >= 0), JSON.stringify(mToastErrors).slice(0, 300));
  note("toast 能否被读到同样是'看容器'：带 role=status/alert 的可被语义树识别（D-11），"
    + "纯 class=.toast 的只有在弹窗容器内才进 modals[].errors（D-14），普通页面里的读不到（D-12）。");

  // --- 模态弹窗：两种实现方式 ---
  const ctxD2 = await ctxOf(fmTab);
  check("D-15 模态弹窗（class 关键词 .publish-modal）→ context.modals 识别到",
    !!((ctxD2 && ctxD2.modals) && ctxD2.modals.length >= 1), "modals=" + ((ctxD2 && ctxD2.modals) || []).length);
  check("D-16 该弹窗的按钮被列出（确定/取消）",
    allModalButtons(ctxD2).some((t) => String(t).indexOf("确定") >= 0) &&
    allModalButtons(ctxD2).some((t) => String(t).indexOf("取消") >= 0),
    JSON.stringify(allModalButtons(ctxD2)));
  const beforeDialog = ((ctxD2 && ctxD2.modals) || []).length;
  await click(fmTab, "openDialog");
  await sleep(600);
  const ctxD3 = await ctxOf(fmTab);
  const afterDialog = ((ctxD3 && ctxD3.modals) || []).length;
  check("D-17 模态弹窗（role=dialog）打开后 context.modals 数量增加",
    afterDialog > beforeDialog, beforeDialog + " -> " + afterDialog);
  check("D-18 role=dialog 弹窗的按钮被列出（确认/关闭）",
    allModalButtons(ctxD3).some((t) => String(t).indexOf("确认") >= 0),
    JSON.stringify(allModalButtons(ctxD3)));
  const dlgDomShown = await shown(fmTab, "roleDialog");
  check("D-19 点击打开对话框 → 真实 DOM 里 dialog 变为可见",
    dlgDomShown === true, "shown=" + dlgDomShown);
  await click(fmTab, "dlgClose");
  await sleep(500);
  const ctxD4 = await ctxOf(fmTab);
  check("D-20 关闭 dialog 后 context.modals 回落（不残留幽灵弹窗）",
    ((ctxD4 && ctxD4.modals) || []).length < afterDialog, afterDialog + " -> " + ((ctxD4 && ctxD4.modals) || []).length);

  // --- 服务端错误 ---
  await click(fmTab, "serverErrBtn");
  await sleep(600);
  const seEval = await domText(fmTab, "serverErr");
  check("D-21 服务端错误展示 → 真实 DOM 文本可读（evaluate）",
    String(seEval).indexOf("敏感词") >= 0, JSON.stringify(seEval));
  const seNode = await nodeOf(fmTab, "serverErr");
  check("D-22 服务端错误（<div class=server-error>）语义树读不到 —— 边界事实",
    seNode === null, seNode ? "unexpectedly present" : "absent");
  check("D-23 ui.wait 能等到服务端错误文案出现（text_contains 条件）",
    await (async () => {
      const w = await b.call("ui.wait", { tab: fmTab, condition: "text_contains", text: "敏感词", timeout_ms: 4000 });
      return !!(w && w.result && w.result.satisfied === true);
    })(), "wait 结果已含在返回值中");

  // =======================================================================
  // E. 选择与标签
  // =======================================================================
  console.log("\n[E. 选择与标签 — radio / checkbox / select / combobox / tag / 话题]");
  const chTab = await openTab("/choice");
  await b.call("ui.set_active_tab", { tab: chTab });
  await sleep(500);

  // 单选
  await click(chTab, "planB");
  await sleep(400);
  const planBDom = await ev("(function(){return document.getElementById('planB').checked;})()", chTab);
  check("E-01 点击 radio → 真实 DOM checked 生效",
    planBDom === true, "checked=" + planBDom);
  const planBNode = await nodeOf(chTab, "planB");
  check("E-02 radio 选中状态在语义树 states 里可读",
    !!(planBNode && Array.isArray(planBNode.states) && planBNode.states.indexOf("checked") >= 0),
    JSON.stringify(planBNode && planBNode.states));
  const planOut = await domText(chTab, "planOut");
  check("E-03 radio 的 change 副作用真实发生（页面输出同步）",
    String(planOut).indexOf("已选:B") >= 0, JSON.stringify(planOut));

  // 多选
  await click(chTab, "cb1");
  await sleep(300);
  await click(chTab, "cb3");
  await sleep(400);
  const cbs = await ev(
    "(function(){return {a:document.getElementById('cb1').checked,b:document.getElementById('cb2').checked,c:document.getElementById('cb3').checked};})()",
    chTab);
  check("E-04 checkbox 多选 → 真实 DOM 两个选中、一个未选",
    cbs && cbs.a === true && cbs.c === true && cbs.b === false, JSON.stringify(cbs));
  const cbOut = await domText(chTab, "cbOut");
  check("E-05 多选结果在页面输出中同步（已选 2 项）",
    String(cbOut).indexOf("2") >= 0, JSON.stringify(cbOut));
  await click(chTab, "cb1");
  await sleep(400);
  const cb1After = await ev("(function(){return document.getElementById('cb1').checked;})()", chTab);
  check("E-06 再次点击 checkbox 可取消选中（真实 DOM 回切）",
    cb1After === false, "checked=" + cb1After);

  // 原生 select
  const selAct = await b.call("ui.act", { action: "select", target: "sel", params: { value: "shanghai" }, tab: chTab });
  await sleep(500);
  const selVal = await domVal(chTab, "sel");
  check("E-07 原生 select：ui.act select → 真实 DOM value 生效",
    selVal === "shanghai", "act=" + JSON.stringify(selAct && selAct.result) + " value=" + JSON.stringify(selVal));
  const selOut = await domText(chTab, "selOut");
  check("E-08 原生 select 的 change 副作用真实发生",
    String(selOut).indexOf("shanghai") >= 0, JSON.stringify(selOut));

  // 自定义 combobox
  const comboNode = await nodeOf(chTab, "combo");
  check("E-09 自定义下拉（role=combobox）语义树可读",
    !!(comboNode && comboNode.role === "combobox"), JSON.stringify(comboNode && comboNode.role));
  check("E-10 role=combobox 的语义树 actions 为空 —— 边界事实（agent 看不出它能点）",
    !!(comboNode && (!comboNode.actions || comboNode.actions.length === 0)),
    JSON.stringify(comboNode && comboNode.actions));
  if (comboNode && (!comboNode.actions || comboNode.actions.length === 0)) {
    defect("P2", "E/自定义控件",
      "role=combobox 的节点 actions 为 []（extractor.cjs:105 extractActions 的 switch 没有 combobox/"
      + "listbox/menu 分支），agent 从语义树看不出它是可点的，只能猜。");
  }
  await click(chTab, "comboBtn");
  await sleep(500);
  const comboOpen = await shown(chTab, "comboList");
  check("E-11 点击自定义下拉触发器 → 真实 DOM 展开选项列表",
    comboOpen === true, "shown=" + comboOpen);
  const optShNode = await nodeOf(chTab, "optSh");
  check("E-12 展开后选项出现在语义树中且 role=button",
    !!(optShNode && optShNode.role === "button"), JSON.stringify(optShNode && { role: optShNode.role, label: optShNode.label }));
  await click(chTab, "optSh");
  await sleep(500);
  const comboVal = await domText(chTab, "comboVal");
  check("E-13 点击自定义下拉选项 → 真实 DOM 的选中值写入",
    String(comboVal).indexOf("上海") >= 0, JSON.stringify(comboVal));
  const comboClosed = await shown(chTab, "comboList");
  check("E-14 选中后选项列表收起（真实 DOM）",
    comboClosed === false, "shown=" + comboClosed);

  // tag input
  await typeInto(chTab, "tagInput", "科技\n");
  await sleep(600);
  let tagHtml = String(await domHtml(chTab, "tagList") || "");
  check("E-15 tag input 回车生成标签（真实 DOM）",
    tagHtml.indexOf("科技") >= 0, JSON.stringify(tagHtml.slice(0, 200)));
  await typeInto(chTab, "tagInput", "娱乐,");
  await sleep(600);
  tagHtml = String(await domHtml(chTab, "tagList") || "");
  check("E-16 tag input 逗号生成标签（真实 DOM）",
    tagHtml.indexOf("娱乐") >= 0, JSON.stringify(tagHtml.slice(0, 200)));
  const tagCount = await domText(chTab, "tagOut");
  check("E-17 标签数量在页面输出中同步（共 2 个）",
    String(tagCount).indexOf("2") >= 0, JSON.stringify(tagCount));
  const tagNodes = await ev("(function(){return document.querySelectorAll('#tagList .tag').length;})()", chTab);
  check("E-18 两个标签都真的挂在 DOM 上",
    Number(tagNodes) === 2, "count=" + tagNodes);
  // 重复标签
  await typeInto(chTab, "tagInput", "科技\n");
  await sleep(600);
  const dupShown = await shown(chTab, "tagDup");
  const tagCount2 = await domText(chTab, "tagOut");
  check("E-19 重复标签被拦截并给出提示（真实 DOM）",
    dupShown === true && String(tagCount2).indexOf("2") >= 0,
    "dupShown=" + dupShown + " count=" + JSON.stringify(tagCount2));
  const dupNode = await nodeOf(chTab, "tagDup");
  check("E-20 重复标签提示（无 role 的 span.field-error）语义树读不到 —— 边界事实",
    dupNode === null, dupNode ? "unexpectedly present" : "absent");
  // 删除标签
  const delBtn = await ev("(function(){var b=document.querySelector('#tagList .tag-del');return b?b.id:null;})()", chTab);
  await click(chTab, String(delBtn));
  await sleep(600);
  const tagCount3 = await domText(chTab, "tagOut");
  check("E-21 点击标签上的删除按钮 → 标签真的被移除（真实 DOM）",
    String(tagCount3).indexOf("1") >= 0, "del=" + JSON.stringify(delBtn) + " count=" + JSON.stringify(tagCount3));

  // 微博式话题
  await clearInto(chTab, "topicEditor");
  await sleep(300);
  await typeInto(chTab, "topicEditor", "今天天气不错#");
  await sleep(700);
  const topicListShown = await shown(chTab, "topicList");
  check("E-22 输入「#」触发话题候选列表（真实 DOM 可见）",
    topicListShown === true, "shown=" + topicListShown);
  const topic1Node = await nodeOf(chTab, "topic1");
  check("E-23 话题候选项在语义树中可读（role=button）",
    !!(topic1Node && topic1Node.role === "button"), JSON.stringify(topic1Node && { role: topic1Node.role, label: topic1Node.label }));
  const beforeTopicHtml = String(await domHtml(chTab, "topicEditor") || "");
  const topicAct = await click(chTab, "topic1");
  await sleep(600);
  const afterTopicHtml = String(await domHtml(chTab, "topicEditor") || "");
  const topicCount = (afterTopicHtml.match(/class="topic"/g) || []).length;
  check("E-24 点击候选 → 话题标签真的插入编辑器（真实 DOM 出现 span.topic）",
    afterTopicHtml.indexOf("topic") >= 0 && afterTopicHtml.indexOf("今日天气") >= 0 &&
    afterTopicHtml.indexOf("今日天气") !== beforeTopicHtml.indexOf("今日天气"),
    JSON.stringify(afterTopicHtml.slice(0, 240)));
  const topicClicks = await ev("window.__topicClicks", chTab);
  check("E-24b 一次 ui.act click 只触发一次 click（话题不被重复插入）",
    Number(topicClicks) === 1 && topicCount === 1,
    "clicks=" + topicClicks + " 插入的 span.topic 个数=" + topicCount +
    " act=" + JSON.stringify(topicAct && topicAct.result));
  if (Number(topicClicks) !== 1) {
    defect("P0", "E+B/点击被重复触发",
      `一次 ui.act click 触发了 ${topicClicks} 次 click，微博式话题被插入了 ${topicCount} 份。` +
      "证据链：act 返回 " + JSON.stringify(topicAct && topicAct.result) + " —— 里面**没有 clicked_via**，" +
      "说明 CDP 点击路径被判失败、走了 preload 回退；但 DOM 上有 2 份插入，说明 CDP 那一次点击其实已经生效了。" +
      "根因：page_manager.js `_cdpPointerTarget` 先真实派发 mousePressed/mouseReleased（第 1 次点击已生效，" +
      "页面因此把候选列表收起了），随后才用 elementFromPoint 做命中校验 —— 目标已经被点没了，校验失败返回 null，" +
      "于是 executeAction 又回退到 preload 再点一次（第 2 次）。凡是'点了之后自身消失/收起'的按钮" +
      "（提交后按钮置灰、菜单项、话题/@提及/表情插入、点赞）都会被点两次 —— 重复提交、重复插入。" +
      "建议：命中校验必须在派发之前做，或派发成功就不再回退。");
  }
  const topicText = await ev("(function(){return document.getElementById('topicEditor').innerText;})()", chTab);
  check("E-25 插入话题后正文文字仍在（未被清空）",
    String(topicText).indexOf("今天天气不错") >= 0, JSON.stringify(topicText));
  // 继续输入正文
  const contAct = await typeInto(chTab, "topicEditor", "继续写正文");
  await sleep(700);
  const contText = String(await ev("(function(){return document.getElementById('topicEditor').innerText;})()", chTab) || "");
  const keptBoth = contText.indexOf("今日天气") >= 0 && contText.indexOf("继续写正文") >= 0;
  check("E-26 话题插入后继续输入正文 —— ui.act type 为「全量替换」语义，话题被清掉（边界事实）",
    keptBoth === false, "act=" + JSON.stringify(contAct && contAct.result) + " text=" + JSON.stringify(contText));
  if (!keptBoth) {
    defect("P1", "E/富文本续写",
      "ui.act type/setContent 走 _inputViaCdp(page_manager.js:773-781)，每次都先 selectAll + 受信 Delete "
      + "清空再逐字键入 —— 语义是「整篇替换」而非「光标处追加」。因此'插入话题标签后继续输入正文'"
      + "这类增量编辑会被整体覆盖。agent 要续写只能自己 evaluate 追加（E-27 验证可行）。");
  }
  // 兜底：evaluate 追加
  await clearInto(chTab, "topicEditor");
  await sleep(300);
  await typeInto(chTab, "topicEditor", "今天天气不错#");
  await sleep(600);
  await click(chTab, "topic2");
  await sleep(500);
  await ev(
    "(function(){var ed=document.getElementById('topicEditor');" +
    "var s=document.createTextNode('这是追加的正文');ed.appendChild(s);" +
    "ed.dispatchEvent(new Event('input',{bubbles:true}));return ed.innerText;})()", chTab);
  await sleep(400);
  const appendText = String(await ev("(function(){return document.getElementById('topicEditor').innerText;})()", chTab) || "");
  check("E-27 兜底：ui.evaluate 追加正文 → 话题标签与正文并存（真实 DOM）",
    appendText.indexOf("人工智能") >= 0 && appendText.indexOf("这是追加的正文") >= 0, JSON.stringify(appendText));

  // =======================================================================
  // F. 图片上传
  // =======================================================================
  console.log("\n[F. 图片上传 — ui.act upload 写真实本地文件]");
  const upTab = await openTab("/upload");
  await b.call("ui.set_active_tab", { tab: upTab });
  await sleep(500);

  const upNode = await nodeOf(upTab, "fileInput");
  check("F-01 input[type=file] 出现在语义树中",
    !!upNode, JSON.stringify(upNode && { id: upNode.id, role: upNode.role }));
  check("F-02 input[type=file] 在语义树里的 role 被当成 textbox —— 边界事实",
    !!(upNode && upNode.role === "textbox"), JSON.stringify(upNode && upNode.role));
  if (upNode && upNode.role === "textbox") {
    defect("P2", "F/文件上传",
      "input[type=file] 被 inferRole 判成 'textbox'（extractor.cjs:83-89 只特判 checkbox/radio/range/number），"
      + "且 actions 里出现 type/clear —— agent 可能把它当文本框去 type。建议加 file→role 'fileinput'/button。");
  }

  const upAct = await b.call("ui.act", {
    action: "upload", target: "fileInput", params: { file: tmpFile }, tab: upTab,
  });
  await sleep(700);
  const upRes = (upAct && upAct.result) || {};
  check("F-03 ui.act upload 返回 success 且带回真实文件名",
    upRes.success === true && String(upRes.uploaded) === tmpBase,
    JSON.stringify(upRes) + " expect=" + tmpBase);
  const filesInfo = await ev(
    "(function(){var f=document.getElementById('fileInput').files;" +
    "return f&&f.length?{name:f[0].name,size:f[0].size}:null;})()", upTab);
  check("F-04 文件真的写进了 input.files（真实 DOM，非谎报）",
    !!(filesInfo && filesInfo.name === tmpBase && filesInfo.size > 0), JSON.stringify(filesInfo));
  const upInfo = await domText(upTab, "upInfo");
  check("F-05 上传后页面出现文件名（真实 DOM）",
    String(upInfo).indexOf(tmpBase) >= 0, JSON.stringify(upInfo));
  const prevSrc = await ev("(function(){return document.getElementById('preview').getAttribute('src')||'';})()", upTab);
  check("F-06 上传后页面出现预览（img src 为 blob: 真实 URL）",
    String(prevSrc).indexOf("blob:") === 0, JSON.stringify(String(prevSrc).slice(0, 80)));
  const upActMissing = await b.call("ui.act", {
    action: "upload", target: "fileInput", params: { file: "" }, tab: upTab,
  });
  check("F-07 传空路径时 upload 如实失败（不谎报成功）",
    !(upActMissing && upActMissing.result && upActMissing.result.success === true),
    JSON.stringify(upActMissing && upActMissing.result));

  // =======================================================================
  // 结尾：缺陷清单
  // =======================================================================
  console.log("\n[缺陷清单（按严重度排序，均为 src/ 层，本测试不改 src）]");
  if (DEFECTS.length === 0) {
    console.log("  （无）");
  } else {
    const order = { P0: 0, P1: 1, P2: 2 };
    DEFECTS.sort((a, b) => (order[a.sev] ?? 9) - (order[b.sev] ?? 9));
    for (const d of DEFECTS) console.log(`  [${d.sev}] ${d.area} — ${d.text}`);
  }

  console.log("\n==== richtext PASS=" + PASS + " FAIL=" + FAIL + " ====");
  b.close();
  try { server.close(); } catch {}
  try { fs.unlinkSync(tmpFile); } catch {}
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error("richtext error:", e && e.stack ? e.stack : e.message); process.exit(2); });
setTimeout(() => { console.error("richtext TIMEOUT"); process.exit(2); }, GLOBAL_TIMEOUT_MS);
