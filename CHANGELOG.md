# Changelog

## 0.1.8 — 2026-09-10

Drop built-in `dsp`. Default alias is only `dsf` = `deepseek-flash`. README install is a numbered prerequisite list for a human or another agent. `examples/` now ships a copy-paste unofficial OpenAI-compatible model (`oa` = gpt-4.1): yaml route + models.json.

## 0.1.7 — 2026-09-10

Default `dsf` alias now points at `deepseek-flash` (V4.1 Flash). Official V4 Flash is retired; the old id still routes there, but the catalog name is `deepseek-flash`. `dsp` stays `deepseek-v4-pro`. Overlay `examples/models.json` matches.

## 0.1.6 — 2026-08-24

Final replies get their own card: when an assistant message carries no `tool-call` block it is the last message of the turn (same rule the agent loop uses to conclude a turn), so it is sent as a green "Done · alias" card instead of the plain blue one. Intermediate narration is unchanged. Restart announce and switch receipts move to turquoise so green now means "a finished answer".

Scheduled sends can target real chats: `dsh-feishu-cli send -b <appId> -c <chatId> [-m <model>]` delivers through the bridge, and the reply goes out from that bot into that Feishu chat. `-m` overrides the model for that single turn without touching the session's saved choice. Bot aliases resolve via the `DSH_FEISHU_CLI_BOTS` JSON env.

Goal create/edit confirmations collapse to a compact status card (objective + rounds) instead of re-rendering the full form.

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
