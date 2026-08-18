# 使用手册

飞书聊天框就是整个产品。没有网页，没有 TUI。

## 斜杠命令

| 命令 | 做什么 |
|------|--------|
| `/stop` | 立刻停当前任务。若正在跑 Goal，会提示 `/goal resume` |
| `/clear` | 丢掉当前会话，下一句开新的。历史还在，之后仍能 `/resume` |
| `/model` | 列出可用模型。`/model dsf` 热切换，本会话记住 |
| `/status` | 当前模型、上下文占比、本机内存/磁盘/CPU |
| `/compact` | 压缩历史。可带一句焦点：`/compact 只留接口约定` |
| `/resume` | 列出近期会话。`/resume 2` 切到第 2 条 |
| `/rename 名字` | 给当前会话起名 |
| `/goal` | Goal，见下一节 |
| `/bye` | 交给 Agent 做会话收尾（若你的提示词/skill 认这个词） |

不认识的 `/` 会回本期支持哪些，不会吞掉后转给模型。普通文字才会进 Agent。

## Goal

`/goal 把这个目录的 README 补上安装步骤，最多跑 3 轮`

Agent 自己多轮推进。连续卡住会标 blocked。进程重启后 **不会** 偷偷接着跑，要显式 `/goal resume`。

| 命令 | 做什么 |
|------|--------|
| `/goal <目标>` | 设定并开始。句末可写「最多跑3轮」 |
| `/goal` | 看当前状态 |
| `/goal edit <目标>` | 改目标，不换阶段 |
| `/goal pause` | 暂停自动续跑 |
| `/goal resume` | 续跑 |
| `/goal clear` | 清掉 |

进度卡片带 `G轮次/上限`，快到上限标 `near`。完成 / 阻塞会另发一条飞书。

## 进度卡片

跑的时候一张卡片原地改：

```
[dsf-23% G1/3] Using bash...(2)
```

从左到右：模型别名、上下文占比、Goal 轮次、当前动作。Thinking 和工具名分开计数。跑完变 `Done.`，失败变 `Failed.`，正文另发，不跟进度糊在一起。

## 模型

默认只有 DeepSeek 官方两条：

- `dsf` = deepseek-v4-flash
- `dsp` = deepseek-v4-pro

要加自己的供应商：

1. 在 profile 的 `cordis.patch.yml` 配 provider（密钥走环境变量，见 `examples/profile.cordis.patch.yml`）
2. 写一份 `models.json`（见 `examples/models.json`）
3. 启动前设 `DSH_FEISHU_MODELS=/绝对路径/models.json`

`/model` 列的就是这份表。切换写进 chat map，重启还在。全局默认模型不动。

## 多 bot

同一 `dsh --profile feishu` 可以挂 2～3 个飞书应用。历史共用，会话分开。`/resume` 里被另一个窗口握住的会标「占用」。

## 图 / 语音 / 文件

入站附件落到 `DSH_FEISHU_INBOX/inbox/`，路径写给模型。**不**把图片塞进 session image block——不少模型会把后面的纯文字也打挂。

回图、回文件、回语音走工具 `send_file`。音频加 `voice=true` 会转 opus 再发成飞书语音（本机要有 ffmpeg）。

## 记忆（可选）

设 `DSH_FEISHU_MEMORY_DIR` 指向一个含 `MEMORY.md` 的目录。稳定前缀只放指针，不灌全文。不设则完全不加载记忆段。

项目级 `CLAUDE.md` / `AGENTS.md` 默认关。打开：`DSH_FEISHU_PROJECT_CLAUDE_MD=1`。

## MCP 工具裁剪（可选）

默认识图 / 多步浏览类工具藏着，会话里 `enable_mcp pack=omnicore` 或 `pack=browser` 再打开。搜索、读网页若在 always 列表里则常驻。

这套默认名字对齐常见的 OmniCore / browser-mcp。你用别的 MCP，改环境变量：

```
DSH_FEISHU_MCP_PACKS=vision:^mcp__vision__;browse:^mcp__browse__
DSH_FEISHU_ALWAYS_TOOLS=mcp__browse__search
DSH_FEISHU_DROP_TOOLS=mcp__browse__get_html
```

没有这些 MCP 也能跑，只是 `enable_mcp` 打开后找不到对应工具。

## 高爆径

默认拦：未点名/大范围 `rm`、`find -delete`、破坏性 git、删库、磁盘擦除、杀 dsh 进程。同一条命令再说一次才放行。关：`DSH_FEISHU_GUARD=0`。

## 本地假 bot

进程起来后有一个 `appId=cli` 的假通道，不占飞书额度：

```
./scripts/dsh-feishu-cli ping
./scripts/dsh-feishu-cli send /model
./scripts/dsh-feishu-cli send "只回一个字：通。不要调工具。"
```

套接字默认 `/tmp/dsh-feishu-cli.sock`。

## 运行时文件

都在 `$DSH_HOME`（本仓脚本默认 `.dsh-home/`）：

- `feishu-chats.json` — 每个窗口的 session / 模型
- `feishu-history.json` — `/resume` 列表
- `profiles/feishu/` — dsh profile

附件在 `workspace/inbox/`。日志在 `logs/dsh-feishu_YYYY-MM-DD.log`。
