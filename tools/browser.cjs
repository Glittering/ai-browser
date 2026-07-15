const WebSocket = require("ws");

// === AI Browser 通用操作工具 ===
// 先看页面结构，再操作。像人一样。

class Browser {
  constructor(port = 9223) {
    this.ws = new WebSocket("ws://localhost:" + port);
    this._id = 0;
    this._pending = new Map();
    this._pushHandlers = new Map();

    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this._pending.has(msg.id)) {
        this._pending.get(msg.id)(msg);
        this._pending.delete(msg.id);
      } else if (msg.method && this._pushHandlers.has(msg.method)) {
        this._pushHandlers.get(msg.method)(msg.params);
      }
    });

    this.ws.on("error", (e) => console.error("WS error:", e.message));
  }

  ready() {
    return new Promise((resolve) => {
      this.ws.on("open", resolve);
    });
  }

  call(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this._id;
      this._pending.set(id, resolve);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  navigate(url) { return this.call("ui.navigate", { url }); }
  act(action, target, params = {}) { return this.call("ui.act", { action, target, params }); }
  evaluate(js) { return this.call("ui.evaluate", { js }); }
  getTree() { return this.call("ui.get_tree", {}); }
  subscribe(events) { return this.call("ui.subscribe", { events }); }

  on(event, handler) { this._pushHandlers.set(event, handler); }

  close() { this.ws.close(); }

  // ### "像人看网页" — 列出页面所有交互元素
  async inspect() {
    const result = await this.evaluate(
      "(function(){"
      + "var inputs=document.querySelectorAll('input,textarea,select,button');"
      + "var out=[];"
      + "for(var i=0;i<Math.min(inputs.length,30);i++){"
      + "var el=inputs[i];"
      + "var id=el.id||el.name||'';"
      + "var label='';"
      + "if(el.placeholder)label=el.placeholder.slice(0,40);"
      + "if(el.getAttribute('aria-label'))label=el.getAttribute('aria-label').slice(0,40);"
      + "var labelText='';"
      + "if(id){var lbl=document.querySelector('label[for=\"'+id+'\"]');if(lbl)labelText=lbl.textContent.trim().slice(0,40);}"
      + "out.push({"
      + "id:id,"
      + "name:el.name||'',"
      + "type:el.type||el.tagName.toLowerCase(),"
      + "label:label,"
      + "labelText:labelText,"
      + "text:(el.textContent||'').trim().slice(0,30),"
      + "checked:!!el.checked,"
      + "value:(el.value||'').slice(0,30),"
      + "visible:el.offsetParent!==null"
      + "});"
      + "}"
      + "return JSON.stringify({title:document.title,url:location.href,inputCount:out.length,inputs:out});"
      + "})()"
    );
    // result 是 {value: "...JSON string..."}
    const rawValue = result?.result?.value || result?.value || "null";
    const info = JSON.parse(rawValue || "{}");
    if (!info.title) {
      console.log("inspect raw:", JSON.stringify(result).slice(0, 300));
    }
    console.log("\n页面: " + (info.title || "(untitled)"));
    console.log("URL: " + (info.url || "(unknown)"));
    const inputs = info.inputs || [];
    console.log("可见交互元素 (" + inputs.length + "):\n");
    inputs.forEach((inp, i) => {
      if (!inp.visible) return;
      const labels = [inp.label, inp.labelText, inp.text].filter(Boolean).join(" / ");
      const id = inp.id || inp.name || "(无名)";
      console.log("  [" + (i+1) + "] " + inp.type + " | id=" + id + (labels ? " | " + labels : "") + (inp.value ? " | val=" + inp.value : ""));
    });
    return info;
  }

  // ### 填表单 — 传入 {fieldName: value}，自动匹配并填写
  async fillForm(fields) {
    for (const [key, val] of Object.entries(fields)) {
      // 用 evaluate 直接通过 id/name/placeholder 匹配
      const result = await this.evaluate(
        "(function(){"
        + "var key=" + JSON.stringify(key) + ";"
        + "var value=" + JSON.stringify(val) + ";"
        + "var els=["
        + "document.getElementById(key),"
        + "document.querySelector('[name=\"'+key+'\"]'),"
        + "document.querySelector('[placeholder*=\"'+key+'\"]'),"
        + "document.querySelector('[aria-label*=\"'+key+'\"]'),"
        + "document.getElementById(key.toLowerCase()),"
        + "document.querySelector('[name*=\"'+key.toLowerCase().slice(0,8) +'\"]')"
        + "].filter(Boolean);"
        + "if(!els.length){"
        + "var all=document.querySelectorAll('input,textarea');"
        + "for(var i=0;i<all.length;i++){"
        + "var ph=(all[i].placeholder||all[i].id||all[i].name||'').toLowerCase();"
        + "if(ph.indexOf(key.toLowerCase().slice(0,5))>=0&&all[i].type!=='hidden'){els.push(all[i]);break;}"
        + "}"
        + "}"
        + "if(els.length){els[0].value=value;els[0].dispatchEvent(new Event('input',{bubbles:true}));els[0].dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({found:true,id:els[0].id||els[0].name,value:value.slice(0,20)});}"
        + "return JSON.stringify({found:false,key:key});"
        + "})()"
      );
      const rawValue = result?.result?.value || result?.value || "null";
      const r = JSON.parse(rawValue || "{}");
      if (r.found) {
        console.log("  FILL " + r.id + " = " + r.value);
      } else {
        console.log("  MISS " + r.key);
      }
    }
  }

  // ### 找并点击按钮
  async clickButton(textMatch) {
    const result = await this.evaluate(
      "(function(){"
      + "var kw=" + JSON.stringify(textMatch.toLowerCase()) + ";"
      + "var btns=document.querySelectorAll('button,[role=button],input[type=submit],a[class*=btn]');"
      + "for(var i=0;i<btns.length;i++){"
      + "var t=(btns[i].textContent||btns[i].value||'').trim().toLowerCase();"
      + "if(t.indexOf(kw)>=0){btns[i].click();return JSON.stringify({clicked:true,text:(btns[i].textContent||'').trim().slice(0,40)});}"
      + "}"
      + "return JSON.stringify({clicked:false,count:btns.length});"
      + "})()"
    );
    const rawValue = result?.result?.value || result?.value || "null";
    const r = JSON.parse(rawValue || "{}");
    if (r.clicked) {
      console.log("  CLICK " + r.text);
    } else {
      console.log("  MISS button '" + textMatch + "' among " + r.count + " buttons");
    }
    return r;
  }
}

module.exports = { Browser };