#!/bin/bash
# data_snapshot.sh — ai-browser 推广数据每日快照
# 用法：bash scripts/marketing/data_snapshot.sh [备注]
# 输出：追加一行到 docs/marketing/DATA_LOG.md
set -u
REPO="/Users/Zhuanz/Documents/trae_projects/ai-browser"
LOG="$REPO/docs/marketing/DATA_LOG.md"
DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)
NOTE="${1:-}"

jqf() { # jqf <gh-api-path> <jq-filter> <default>
  local out
  out=$(gh api "$1" --jq "$2" 2>/dev/null) || out=""
  [ -z "$out" ] && out="$3"
  echo "$out"
}

# --- GitHub ---
STARS=$(jqf "repos/Glittering/ai-browser" '.stargazers_count' '?')
FORKS=$(jqf "repos/Glittering/ai-browser" '.forks_count' '?')
ISSUES=$(jqf "repos/Glittering/ai-browser" '.open_issues_count' '?')
VIEWS14=$(jqf "repos/Glittering/ai-browser/traffic/views" '.count' '?')
UNIQ14=$(jqf "repos/Glittering/ai-browser/traffic/views" '.uniques' '?')
CLONES14=$(jqf "repos/Glittering/ai-browser/traffic/clones" '.count' '?')
CLONEU14=$(jqf "repos/Glittering/ai-browser/traffic/clones" '.uniques' '?')

# --- npm ---
NPM_VER=$(curl -s --max-time 15 "https://registry.npmjs.org/@glittering0717%2Fai-browser" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['dist-tags']['latest'])" 2>/dev/null || echo '?')
NPM_DL=$(curl -s --max-time 15 "https://api.npmjs.org/downloads/point/last-week/@glittering0717/ai-browser" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('downloads','N/A'))" 2>/dev/null || echo 'N/A')

# --- MCP Registry（取 isLatest 条目；API 偶发超时，带重试）---
mcp_fetch() {
  for i in 1 2 3; do
    local out
    out=$(curl -s --max-time 20 "https://registry.modelcontextprotocol.io/v0/servers?search=ai-browser" 2>/dev/null)
    if [ -n "$out" ] && echo "$out" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
      echo "$out"
      return 0
    fi
    sleep 2
  done
  echo ""
}
MCP_INFO=$(mcp_fetch | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for item in d.get('servers',[]):
        s=item.get('server',{})
        if s.get('name')=='io.github.Glittering/ai-browser':
            m=item.get('_meta',{}).get('io.modelcontextprotocol.registry/official',{})
            if m.get('isLatest'):
                print(s.get('version','?'), m.get('status','?'))
                break
except Exception:
    pass
" 2>/dev/null)
MCP_VER=$(echo "$MCP_INFO" | awk '{print $1}')
MCP_STATUS=$(echo "$MCP_INFO" | awk '{print $2}')
[ -z "$MCP_VER" ] && MCP_VER='?'
[ -z "$MCP_STATUS" ] && MCP_STATUS='?'

# --- 文章渠道状态（经 ai-browser 巡查时更新；此处留空由人工/agent 回填）---
printf '| %s %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
  "$DATE" "$TIME" "$STARS" "$FORKS" "$ISSUES" "$VIEWS14" "$UNIQ14" "$CLONES14/$CLONEU14" "$NPM_VER" "$NPM_DL" "$MCP_VER" "$MCP_STATUS" "${NOTE:-}" >> "$LOG"

echo "快照已写入 $LOG"
tail -1 "$LOG"
