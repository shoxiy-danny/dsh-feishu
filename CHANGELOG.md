# Changelog

## 0.1.5 — 2026-08-22

Goal card collapses after a successful form submit: the card refreshes to status-only (objective, phase, rounds, action buttons) with a "resend /goal" hint instead of re-rendering an edit input. Fixed `/goal pause|resume|clear` against dsh ≥ 0.1.1-rc.1, where `commands.execute` gained an `images` parameter and the old three-argument call threw `Cannot read properties of undefined (reading 'aborted')`.

## 0.1.4 — 2026-08-21

Restart orchestration: on boot the plugin resumes known sessions and posts a green card (session title + model) — no need to speak first. A restart wrapper can pass one LLM-written continue instruction via `$DSH_HOME/restart-continue.json`; the card shows it inline and it is delivered into the session as a new message. Ask/approval cards redesigned: numbered two-per-row option grid with grey description menu, one-row input, action buttons at the bottom. Handbook §模型: how to add a provider (two files, protocol table, per-field); example overlay is a generic skeleton.

## 0.1.3 — 2026-08-19

Resume is a Feishu card: tap a session or stay. `/rename` is also a model tool (`SlashCommand`). Tool results wait until 100K then keep 3 full views before official head/tail.

## 0.1.2 — 2026-08-19

Goal is a Feishu card: create / edit on a form, pause / resume / clear as buttons. Ask cards always include a text form. Complete and blocked update the same card. Packaging: README cover, product mark.

## 0.1.1 — 2026-08-18

High-risk bash waits on an orange Feishu card. `ask_user_question` uses a blue card; typed replies also count. Removed the old "say it twice" grant. Subscribe to `card.action.trigger`.

## 0.1.0 — 2026-08-18

Public first cut. Feishu as the only surface for DeepSeek Harness.

- WebSocket inbound / outbound, markdown cards, files and voice
- Slash commands: `/stop` `/clear` `/model` `/status` `/compact` `/resume` `/rename` `/bye` `/goal`
- Progress card with model alias, context %, Goal rounds
- Multi-bot on one process, session map keyed by `(appId, chat_id)`
- Optional extra models via `DSH_FEISHU_MODELS`
- Optional memory index, MCP pack trim, high-risk bash guard
- Local CLI fake bot for smoke tests
