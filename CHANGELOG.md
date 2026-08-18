# Changelog

## 0.1.0 — 2026-08-18

Public first cut. Feishu as the only surface for DeepSeek Harness.

- WebSocket inbound / outbound, markdown cards, files and voice
- Slash commands: `/stop` `/clear` `/model` `/status` `/compact` `/resume` `/rename` `/bye` `/goal`
- Progress card with model alias, context %, Goal rounds
- Multi-bot on one process, session map keyed by `(appId, chat_id)`
- Optional extra models via `DSH_FEISHU_MODELS`
- Optional memory index, MCP pack trim, high-risk bash guard
- Local CLI fake bot for smoke tests
