# CLI — 不用 MCP 也能干活的那条路

## 什么时候得用它

`browse_*` 工具是 MCP 层的东西。MCP 要挂上，得经过客户端的三道闸门：配置文件、一次性授权、
会话启动时的工具快照。任何一环没走完（最常见：**改完配置没开新会话**），工具就不出现。

这时候别顺着"配置 → 授权 → 重启"往下修 —— 那条路在客户端手里，你改不动。
CLI 是同一个 JSON-RPC 的另一个门，只依赖一件事：命令能在 PATH 里跑起来。

```bash
ai-browser call ui.get_tree '{"subset":"interactive"}'
# 没装全局命令时：
npx -y @glittering0717/ai-browser call ui.get_tree '{"subset":"interactive"}'
```

stdout 只有 result（紧凑 JSON，可直接 `| jq`），进度和错误走 stderr。

## 先确认它是不是活着

```bash
ai-browser status          # {"running":true,"pid":…,"port":9223,"tabs":[…]}
ai-browser ensure          # 幂等：没开就拉起，开了就直接返回
ai-browser call ui.get_tree   # 连不上会自动 ensure 再重试一次
```

`status` **不会**拉起浏览器 —— 它问的是"在跑吗"，答"不在"才算答对。
`call` 会。想快速失败（脚本里）加 `--no-start`。

## 方法对照表

MCP 工具名去掉 `browse_`，换成 `ui.`，就是 CLI 方法名。

| 一一对应 | get_tree · act · navigate · evaluate · scroll · wait · screenshot · errors · capabilities · downloads · quit · auth_state · repaint |
|---|---|
| `browse_tabs` | `ui.list_tabs` / `ui.new_tab` / `ui.close_tab` / `ui.set_active_tab` |
| `browse_network` | `ui.network_list` / `ui.network_get`（两个，不是一个） |
| `browse_canvas` | `ui.canvas_list` / `ui.canvas_read` / `ui.canvas_capture` / `ui.canvas_configure` |
| `browse_diff` | `ui.snapshot` / `ui.diff` |

## 常用参数（底层契约，CLI 直传）

```bash
ai-browser call ui.navigate '{"url":"https://example.com","tab":1,"wait_until":"load"}'
ai-browser call ui.get_tree '{"tab":1,"subset":"interactive"}'    # 交互树
ai-browser call ui.get_tree '{"tab":1,"ax":true}'                # 阅读树（长正文用它）
ai-browser call ui.act '{"action":"click","target":"e:a-3"}'
ai-browser call ui.act '{"action":"type","target":"e:input-1","text":"关键词"}'
ai-browser call ui.evaluate '{"js":"document.title"}'
ai-browser call ui.evaluate '{"frame_ref":"frame-1","js":"document.body.innerText"}'
ai-browser call ui.wait '{"condition":"text_contains","text":"加载完成"}'
ai-browser call ui.network_list '{"tab":1}'
ai-browser call ui.screenshot '{"tab":1}'
```

`ui.act` 的 `target` 只认树里的 `id`（形如 `e:a-3`），不认页面上的文字。

长 JSON 别跟 shell 引号搏斗，用 `-` 从 stdin 读：

```bash
echo '{"action":"type","target":"e:input-1","text":"很长很长的内容"}' | ai-browser call ui.act -
```

## 没连上时它在说什么

| stderr 里出现 | 意思 | 下一步 |
|---|---|---|
| `没在 127.0.0.1:9223 上跑` | 浏览器没起（`--no-start` 时最常见） | 去掉 `--no-start`，或 `ai-browser ensure` |
| `could not start the browser: …cause: exited early` | 拉起了但立刻崩 | 看 cause：`ELECTRON_RUN_AS_NODE` 没清 / Chromium 沙箱被拦 / 二进制没装全 |
| `Method not found (ui.xxx)` | 方法名错（拼错，或用了 MCP 的名字） | 对照上面的表 |
| `no reply from … within …ms` | 方法执行太慢 | 加大 `--timeout` |

## 端口与多实例

```bash
ai-browser status --port 9701
AI_BROWSER_PORT=9701 AI_BROWSER_USER_DATA=/tmp/ab-test ai-browser ensure
```

同一 `AI_BROWSER_USER_DATA` 有单实例锁 —— 换 profile 才能开第二个。
搞 e2e / 并行任务时必须换，否则会撞锁，端口永远不开。
