# AGENTS.md

TRSS-Yunzai 插件：把 HAPI（Claude Code / Codex / Cursor / Grok / Kimi / OpenCode / Pi）的远程编码会话接进聊天窗口，并内置 QQ 开放平台官方机器人适配器。

安装与使用见 `README.md`；适配器行为见 `docs/qqbot-adapter.md`。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in this repo (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Matt's default vocabulary, unchanged: `bug` / `enhancement` plus `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
