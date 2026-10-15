# GitHub Support 工单：请求解除账号级 Actions 禁用

> 提交入口（需登录 Glittering 账号）：https://support.github.com/contact?tags=actions
> 若该入口 503，备选：https://support.github.com/contact 选 "Actions, Packages & Codespaces"
> **已提交：2026-10-15，工单 #4860380（状态：打开，优先级：正常）**
> 查看：https://help.github.com/ticket/personal/0/4860380 ｜ 回复会发到 zhaoshichengzhao@sina.com
> 向导判定原文："This looks consistent with a GitHub-controlled account flag, not a repository Actions setting."

---

## Subject

GitHub Actions is disabled at account level — please review (long-standing active account)

## Body

Hi GitHub Support,

GitHub Actions is currently disabled for my personal account, and I could not find any account-level setting to re-enable it. Could you please review the flag?

**Account**

- Login: Glittering
- Account ID: 20500187
- Account created: 2016-07-17 (nine years old, 170+ public repositories)
- Two-factor authentication: enabled
- Primary verified email: zhaoshichengzhao@sina.com
- I am located in Guangzhou, China, and recently signed in on a new macOS device (Chrome, IP geolocated to Guangzhou). That sign-in was genuinely me — no credentials have been shared.

**What I see**

1. On https://github.com/Glittering/ai-browser/actions:
   "GitHub Actions is currently disabled for your account. Please reach out to GitHub Support for assistance."
2. Triggering a workflow via the API returns:
   HTTP 422 — "Actions has been disabled for this user"
   (POST /repos/Glittering/ai-browser/actions/workflows/ci.yml/dispatches)
3. The repository-level Actions permission is enabled:
   GET /repos/Glittering/ai-browser/actions/permissions → {"enabled":true,"allowed_actions":"all"}
   so the block appears to be an account-level flag rather than a repository setting.

**Why I need it**

I maintain an open-source project (Glittering/ai-browser, MIT licensed) and just published v1.2.1 to npm and the official MCP Registry. CI is required for pull request checks and release builds, and multiple collaborators on an awesome-list PR will benefit from green checks.

I believe this may be an automated security flag triggered by the recent sign-in from a new location/device. Everything about the activity is legitimate. Please let me know if any additional verification is needed — happy to confirm identity any way that helps.

Thank you!
