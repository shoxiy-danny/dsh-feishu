# dsh-feishu

<p align="center">
  <img src="https://img.shields.io/badge/dsh--plugin-Feishu-3370ff" alt="dsh-plugin">
  <img src="https://img.shields.io/badge/UI-Feishu_only-00d6b9" alt="Feishu only">
  <img src="https://img.shields.io/badge/no-web_app-lightgrey" alt="No web">
  <img src="https://img.shields.io/badge/runtime-Node_22-339933" alt="Node 22">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

---

# 中文

**DeepSeek Harness 的飞书前端。** 没有网页，没有 TUI，没有审批弹窗。模型、斜杠命令、进度、Goal、会话，全部发生在飞书里。

dsh 官方默认面是 Web。这套插件把它换成一条长连接：进程常驻，飞书就是整个产品。

## 为什么是飞书，不是再做一个网页

写代码的 Agent 已经很强。缺的是一个你每天都在用的入口。

飞书不是旁路通知，是唯一交互面：

- 斜杠命令在飞书里敲，效果跟终端一样
- 模型热切换当场生效，下一轮就换脑子
- 进度头跟着变：现在用哪个模型、上下文占了多少、Goal 跑到第几轮
- 图、语音、文件收得进、发得出
- 重启回来还在刚才那条会话，不用重新自我介绍

一句话：**把 dsh 装进飞书，而不是把飞书接到一个网页旁边。**

## 卖点

### 完全不依赖 Web

不装 `dsh-web-app`，不开 3080，不跑 headless 一次性进程。一个 `dsh --profile feishu` 常驻，飞书 WebSocket 进、飞书卡片出。关掉网页，产品还在。

### 斜杠命令就在聊天框

`/stop` `/clear` `/model` `/status` `/compact` `/resume` `/rename` `/goal` `/bye`

不支持的 `/` 会直接告诉你本期有哪些。完整表见 [docs/handbook.md](docs/handbook.md)。

### 会变的进度头

不是「正在思考…」四个字一直挂着。进度卡片原地改：

```
[dsf-23% G1/3] Using bash...(2)
```

模型别名、上下文占比、Goal 轮次（快到上限会标 near）。跑完变 Done，失败变 Failed，正文另发一条。

### Goal：说一个目标，让它自己跑

`/goal 把这个目录的 README 补上安装步骤，最多跑 3 轮`

Agent 自己多轮推进。重启后 **不会** 偷偷接着烧，要显式 `/goal resume`。

### 一进程多 Bot

同一个 dsh 进程可以挂 2～3 个独立飞书应用。会话按 `(appId, chat_id)` 分开。历史可以互相 `/resume`，同一条 session 不能被两个窗口同时握住。

### 上下文会自己收

新用户轮开始前，更早的 read / glob / grep / bash 大结果收成占位。glob 自动滤掉 `node_modules` / `.git` / `.pnpm`。可选：把生图 / 多步浏览类 MCP 藏到 `enable_mcp` 之后。

### 多模态按飞书的方式走

图 / 语音 / 文件落到本地 inbox，把路径写给模型。**不**把图片塞进 session image block。回图、回文件、回语音走 `send_file`。

## 五分钟跑起来

需要 Node 22 和已安装的 `dsh`（`npm i -g @deepseek-ai/dsh`）。

飞书开放平台建一个**企业自建应用**，事件订阅用长连接（WebSocket），不要 webhook。步骤见 [docs/feishu-setup.md](docs/feishu-setup.md)。

### 从 GitHub 装到独立 profile

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

建议钉扫描过的 commit，和市场页证据对齐：

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#<sha>
```

然后把 App ID / Secret 和 `DEEPSEEK_API_KEY` 放进环境，再：

```sh
dsh --profile feishu
```

### 从本仓脚本装（开发 / 自托管）

```sh
cp .env.example .env
# 填 FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY

chmod +x scripts/*.sh scripts/dsh-feishu-cli
./scripts/setup.sh
./scripts/start.sh
```

启动后到这个应用的单聊打一句。应先收到表情，再看到进度头，然后是正文。

工作目录默认家目录；附件落 `workspace/inbox/`。第二个 bot 再填 `FEISHU_APP_ID_2` / `FEISHU_APP_SECRET_2`。

## 和「再包一层飞书 Bot」的差别

多数方案是：外面一个 webhook 进程，里面再 spawn 一次 CLI。这条路对不上常驻、补话、进度、`/stop`、重启续聊。

这是 **dsh 的 Cordis 插件**。Agent 的 create / followup / steer / cancel / resume 都在同一进程里。飞书是面，不是壳外面再套的壳。

## 适合谁

- 已经在用飞书办公，不想再开一个 Agent 网页
- 想把 dsh 做成 7×24 云端同事，而不是本地 TUI
- 需要同一套 Agent、多个飞书身份
- 想要 Goal 这种「交代完让它自己盯」的能力，但中断和续跑必须自己说了算

不适合：还想保留官方 Web 控制台、需要人工点审批弹窗、或把飞书只当通知渠道的人。

## 文档

| 文件 | 内容 |
|------|------|
| [docs/handbook.md](docs/handbook.md) | 斜杠命令、Goal、模型、多 bot、MCP、假 bot |
| [docs/feishu-setup.md](docs/feishu-setup.md) | 飞书应用、权限、长连接 |
| [docs/publish.md](docs/publish.md) | 作者：GitHub topic 和市场收录 |
| [examples/](examples/) | 模型表、profile overlay 样例 |

默认模型只有 DeepSeek 官方 `dsf` / `dsp`。加自己的供应商见手册「模型」一节。

需要 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。发现页：[dsh-plugin.market](https://dsh-plugin.market/)。

---

# English

**Feishu / Lark as the only UI for DeepSeek Harness.** No web app. No TUI. No approval popup. Models, slash commands, progress, Goal, and sessions all live in chat.

The official dsh surface is a website. This bundle replaces it with one long-lived process and a Feishu WebSocket.

## Why Feishu, not another web UI

Coding agents are already strong. What's missing is an entry you already open every day.

Feishu is not a side-channel for notifications. It is the product:

- Slash commands in chat, same effect as a terminal
- Hot-swap models; the next turn uses the new brain
- A live progress header: which model, how full the context is, which Goal round
- Images, voice, and files in and out
- After a restart you are still in the same session

In one line: **put dsh inside Feishu, don't bolt Feishu onto a webpage.**

## Features

### No web dependency

No `dsh-web-app`, no port 3080, no one-shot headless runner. `dsh --profile feishu` stays up. Feishu WebSocket in, Feishu card out. Close the browser; the product is still there.

### Slash commands in the composer

`/stop` `/clear` `/model` `/status` `/compact` `/resume` `/rename` `/goal` `/bye`

Unknown `/` replies with the supported list. Full table: [docs/handbook.md](docs/handbook.md).

### A progress header that actually changes

Not a frozen "Thinking…". The card edits in place:

```
[dsf-23% G1/3] Using bash...(2)
```

Model alias, context %, Goal round (`near` when the cap is close). Done / Failed on the card; the reply is a separate message.

### Goal: name an objective, let it run

`/goal add an install section to this README, max 3 rounds`

The agent continues across turns. After a process restart it will **not** keep burning tokens until you say `/goal resume`.

### Several bots, one process

The same dsh process can hold 2–3 Feishu apps. Sessions are keyed by `(appId, chat_id)`. History can `/resume` across bots; one session cannot be held by two windows at once.

### Context trims itself

Before a new user turn, older bulky `read` / `glob` / `grep` / `bash` results collapse to placeholders. `glob` drops `node_modules` / `.git` / `.pnpm`. Optional: hide vision / multi-step browser MCP until `enable_mcp`.

### Multimodal the Feishu way

Inbound images / voice / files land in a local inbox; the model gets a path. Images are **not** stuffed into session image blocks. Replies go through `send_file`.

## Five minutes

Need Node 22 and `dsh` (`npm i -g @deepseek-ai/dsh`).

Create a Feishu **enterprise self-built app**. Subscribe to events over **WebSocket**, not webhook. Details: [docs/feishu-setup.md](docs/feishu-setup.md).

### Install from GitHub

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

Pin a scanned commit if you want the same evidence the market page shows:

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#<sha>
```

Put `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `DEEPSEEK_API_KEY` in the environment, then:

```sh
dsh --profile feishu
```

### Install from this repo (dev / self-host)

```sh
cp .env.example .env
# fill FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY

chmod +x scripts/*.sh scripts/dsh-feishu-cli
./scripts/setup.sh
./scripts/start.sh
```

Then send one message in a p2p chat with that app. You should get a reaction, a progress header, then the reply.

Default cwd is the home directory; attachments land in `workspace/inbox/`. A second bot is `FEISHU_APP_ID_2` / `FEISHU_APP_SECRET_2`.

## Not "a webhook that shells out to a CLI"

Most Feishu bots spawn a CLI per message. That cannot do a long-lived agent, mid-turn followups, live progress, `/stop`, or resume after restart.

This is a **Cordis plugin for dsh**. `create` / `followup` / `steer` / `cancel` / `resume` stay in one process. Feishu is the surface, not a wrapper around a wrapper.

## Who this is for

- Already lives in Feishu, does not want another Agent webpage
- Wants dsh as a 24/7 coworker, not a local TUI
- Needs one agent, several Feishu identities
- Wants Goal ("leave it running") but pause / resume must be explicit

Not for: people who still want the official web console, a human approval popup, or Feishu-as-notifications-only.

## Docs

| File | What |
|------|------|
| [docs/handbook.md](docs/handbook.md) | Commands, Goal, models, multi-bot, MCP, fake CLI bot |
| [docs/feishu-setup.md](docs/feishu-setup.md) | Feishu app, scopes, long connection |
| [docs/publish.md](docs/publish.md) | Author: GitHub topics and market listing |
| [examples/](examples/) | Model table and profile overlay samples |

Ships DeepSeek official aliases only: `dsf` / `dsp`. Extra providers: see the handbook.

Requires [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Discovery: [dsh-plugin.market](https://dsh-plugin.market/).

MIT. Issues and PRs welcome.
