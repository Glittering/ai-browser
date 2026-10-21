# REGISTRY_SYNC_RUNBOOK — MCP Registry 同步操作手册

> 每次 npm 发新版本后，官方 MCP Registry **不会**自动跟进，需要手动同步 server.json。
> 不同步的后果：别人通过 registry.modelcontextprotocol.io 的 `npx` 命令装到的是旧版
> （2026-10-21 时就曾落后 5 个版本，registry latest 停在 1.2.2 而 npm 已是 2.1.1）。
> 本手册流程于 2026-10-21 20:18 实测跑通（1.2.2 → 2.1.1）。

## 网络约束（本机）

- `github.com`（网站主机）直连会被断：`POST https://github.com/login/device/code` 报
  `unexpected EOF` → **`mcp-publisher login github` 的默认设备流在本机不可用**。
- `registry.modelcontextprotocol.io`、`api.github.com`（gh CLI 走这里）均可达。
- 解法：跳过设备流，用 `-token` 直接传 GitHub token（gh CLI 的 OAuth token 即可，
  账号 Glittering，scope 含 repo；registry 只需用它调 `/user` 验证 namespace 归属）。

## 操作步骤（约 2 分钟）

```bash
# 0. 前置：npm 新版已发布（npm view @glittering0717/ai-browser dist-tags 确认 latest）
# 1. 拿 publisher 二进制（curl 直连 GitHub Releases 会超时，用 gh）
gh release download --repo modelcontextprotocol/registry \
  --pattern 'mcp-publisher_darwin_arm64*' --dir /tmp/mcp-pub --clobber
cd /tmp/mcp-pub && tar xzf mcp-publisher_darwin_arm64.tar.gz && chmod +x mcp-publisher

# 2. 升级 server.json：顶层 version 和 packages[0].version 都改成 npm 版本号（两处！）
#    校验 package.json 的 mcpName == server.json 的 name（io.github.Glittering/ai-browser）

# 3. 登录（token 只经内存/环境变量传递，不落盘）
cd /Users/Zhuanz/Documents/trae_projects/ai-browser
/tmp/mcp-pub/mcp-publisher login github -token "$(gh auth token)"

# 4. 校验 + 发布（必须在仓库根目录跑，server.json 在当前目录查找）
/tmp/mcp-pub/mcp-publisher validate
/tmp/mcp-pub/mcp-publisher publish

# 5. 复核（注意 serverName 里的斜杠要 URL 编码成 %2F，否则 404）
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Glittering%2Fai-browser/versions" \
  | python3 -c "import json,sys; [print(v['server']['version'], v['_meta']['io.modelcontextprotocol.registry/official']['isLatest']) for v in json.load(sys.stdin)['servers']]"
```

## 注意事项

- **server.json 两处 version 都要改**（顶层 + packages[0].version），漏改 packages 里的会发布失败或版本不一致。
- 登录态保存在 `~/.config/mcp-publisher/token.json`（旧版在 `~/.mcp-publisher/`，新版搬家了，二进制里有 hint）。
- registry 上旧版本保留 active 状态（isLatest 自动切到新版），不需要手动下架。
- 验证接口 `GET /v0.1/servers/{name}/versions`，`{name}` 含斜杠必须 `%2F` 编码；`?search=` 列表接口对本项目名返回空，别用它判断。
- `mcp-publisher` npm 上有个同名无关包（描述是俄语的"通用 MCP"），**不要装**；官方只有 GitHub Releases 二进制。
- 若 token 过期/失效：重新跑第 3 步即可（`gh auth status` 先确认 gh 登录态）。

## 未做：CI 自动化（后续可选）

`mcp-publisher login github-oidc` 支持 GitHub Actions OIDC，可在 tag 推送时自动同步 registry
（workflow 需 `id-token: write` 权限）。当前仓库只有 ci.yml，未配置——本次手动同步即可，
若以后发版频繁再补 `.github/workflows/publish.yml`。
