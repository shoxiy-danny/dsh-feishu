# 使用手册

飞书聊天框就是整个产品。没有网页，没有 TUI。

## 斜杠命令

| 命令 | 做什么 |
|------|--------|
| `/stop` | 立刻停当前任务。若正在跑 Goal，卡片改成可恢复，也可 `/goal resume` |
| `/clear` | 丢掉当前会话，下一句开新的。历史还在，之后仍能 `/resume` |
| `/model` | 列出可用模型。`/model dsf` 热切换，本会话记住 |
| `/status` | 当前模型、上下文占比、本机内存/磁盘/CPU |
| `/compact` | 压缩历史。可带一句焦点：`/compact 只留接口约定` |
| `/resume` | 发会话卡片：点一条切过去，或不选留在当前；`/resume 2` 仍可用 |
| `/rename 名字` | 给当前会话起名 |
| `/goal` | Goal，见下一节 |
| `/bye` | 交给 Agent 做会话收尾。打包提示词会跑 `bye` skill（`examples/skills/bye/`） |

不认识的 `/` 会回本期支持哪些，不会吞掉后转给模型。普通文字才会进 Agent。

## Goal

发 `/goal` 会出一张可点的目标卡。也可以直接：

`/goal 把这个目录的 README 补上安装步骤，最多跑 3 轮`

Agent 自己多轮推进。连续卡住会标 blocked。进程重启后 **不会** 偷偷接着跑，要在卡片上点「恢复自动续跑」，或显式 `/goal resume`。

卡片上：

- 空状态 / 已完成：表单「设定并开始」
- 进行中：表单「保存修改」+ 暂停 / 清除
- 已暂停 / 已阻塞 / 未武装：恢复 + 清除
- 完成变绿，阻塞变红，原地改

斜杠仍然全部可用：

| 命令 | 做什么 |
|------|--------|
| `/goal <目标>` | 设定并开始。句末可写「最多跑3轮」 |
| `/goal` | 看当前状态（刷新卡片） |
| `/goal edit <目标>` | 改目标，不换阶段 |
| `/goal pause` | 暂停自动续跑 |
| `/goal resume` | 续跑 |
| `/goal clear` | 清掉 |

进度卡片带 `G轮次/上限`，快到上限标 `near`。完成 / 阻塞改同一张 Goal 卡，不再另刷纯文字。`/clear` 或切走会话会把旧卡锁成「已失效」。

## 进度卡片

跑的时候一张卡片原地改：

```
[dsf-23% G1/3] Using bash...(2)
```

从左到右：模型别名、上下文占比、Goal 轮次、当前动作。Thinking 和工具名分开计数。跑完变 `Done.`，失败变 `Failed.`，正文另发，不跟进度糊在一起。

## 终局 Done 卡

每轮的最后一条总结回复单独识别：assistant 消息里没有 `tool-call` 块就是本轮末条（与 agent-loop 判定回合结束的规则一致），发绿头 `Done · 别名` 卡；中间过程发言仍是普通蓝头。重启播报和切换回执是青头，绿色只留给「一个完整的回答」。

## 模型

默认只有 DeepSeek 官方一条：

- `dsf` = deepseek-flash（V4.1 Flash）

协议和供应商不在本插件里写死。飞书侧只认一份别名表；真正怎么打 API，交给 dsh 的 `llm-pi-ai`。手写路由能讲的线协议就三个：`openai-completions`、`openai-responses`、`anthropic-messages`。Bedrock / Vertex / Azure / Codex OAuth 不是一把 key，手写路由配不了。

非官方模型的完整可抄例子：`examples/profile.cordis.patch.yml` + `examples/models.json`（别名 `oa` = `gpt-4.1`，OpenAI Chat Completions）。把路由键、`baseURL`、`models[].id`、环境变量名换成你的厂商即可。

### 两份文件，两件事

| 文件 | 谁读 | 干什么 |
|------|------|--------|
| profile 的 `cordis.patch.yml` 里 `llm-pi-ai.providers` | dsh | 这条路由怎么连：协议、地址、密钥环境变量、模型目录 |
| `DSH_FEISHU_MODELS` 指向的 `models.json` | 本插件 | `/model` 列出什么、进度头显示什么。**整表替换**默认的 `dsf`，要留官方那条就自己抄回去 |

两处的 `provider` + `model` 必须对上：json 的 `provider` = yaml 路由键；json 的 `model` = 该路由 `models[].id`。

密钥只放环境变量。yaml 里写 `apiKeyEnv: MY_KEY`，进程环境里再 `export MY_KEY=...`。别把 key 写进文件。

后叠的 `cordis.patch.yml` **整段替换**同 id 的 `config`，不深合并。额外供应商全部写进同一个 `providers` 字典。

### 三步

1. 把 `examples/profile.cordis.patch.yml` 里的 `llm-pi-ai` 段抄进 `~/.dsh/profiles/feishu/cordis.patch.yml`（或你的 `$DSH_HOME/profiles/feishu/`）
2. 复制 `examples/models.json`。这份文件**整表替换**内置表，要留 `dsf` 就留着，再加自己的别名。路径必须是绝对路径。多一条时形状是：

```json
"mine": {
  "provider": "my-gateway",
  "model": "the-model-id",
  "label": "mine = the-model-id",
  "window": 262144
}
```

3. 启动前：`export DSH_FEISHU_MODELS=/绝对路径/models.json`，以及 yaml 里写过的那些 `*KEY`

`/model` 列的就是这份 json。`/model 别名` 热切换，写进该飞书窗口的 chat map，重启还在。不改 dsh 全局默认。

### `models.json` 字段

顶层一个对象，键是别名（会转成小写）。缺 `provider` 或 `model` 的条目会被丢掉；文件无效则回退内置 `dsf`。

| 字段 | 必填 | 含义 |
|------|------|------|
| （键） | 是 | `/model xxx` 用的短名 |
| `provider` | 是 | yaml 里的路由键 |
| `model` | 是 | 该路由上的模型 `id` |
| `label` | 否 | `/model` 列表文案。默认 `别名 = model` |
| `window` | 否 | 上下文窗口，只给进度头算占比。默认 `1000000`。应和 yaml 里的 `contextWindow` 一致 |

### 路由：目录路由 vs 手写路由

yaml 的 `providers` 字典，**键就是路由名**。

- 键是 dsh / pi-ai 已经内置的名字（如 `openai`、`anthropic`）：这是**目录路由**。可只写 `apiKeyEnv`，协议、地址、模型目录都继承。要收窄或改窗口，再写 `models` / `modelOverrides`。
- 键是你自起的名字：这是**手写路由**。必须同时有 `api`、`baseURL`、非空且 `id` 不重复的 `models`。缺一项，加载直接拒。

一条路由只能一种协议。两套协议就拆成两个键。

### 手写路由：每次都要写的

| 字段 | 怎么填 |
|------|--------|
| （键） | 你起的 provider 名。只允许字母数字和连字符。之后 json 的 `provider` 抄它 |
| `api` | 三个之一，见下表 |
| `baseURL` | 按厂商文档原样抄，当**前缀**用，不会再帮你拼主机。`openai-completions` 会再接 `/chat/completions`，`openai-responses` 接 `/responses`。多一个或少一个 `/v1` 是最常见的 404 |
| `apiKeyEnv` | 环境变量**名**。启动时必须能读到。本地无密钥的服务也要给个占位变量或在 `headers` 里写 `Authorization`，否则 OpenAI 兼容实现会拒 |
| `models` | 至少一条。`id` 是请求里的模型名，必须和厂商文档一致 |

`api`：

| 值 | 线协议 | 什么时候选 |
|----|--------|------------|
| `openai-completions` | `POST {baseURL}/chat/completions` | 多数国内网关、自建 vLLM / llama.cpp、文档写 Chat Completions 的 |
| `openai-responses` | `POST {baseURL}/responses` | 文档写 Responses API 的 |
| `anthropic-messages` | Anthropic `/v1/messages` | 文档写 Messages API、或明确提供 Anthropic 兼容端点的 |

看厂商文档的路径，不要看营销名。同一品牌两套协议，拆两条路由。

### 手写路由：按需再写

都不写也能跑。出问题再加。

| 字段 | 默认 | 什么时候改 |
|------|------|------------|
| `displayName` | 路由键 | 给人看的名字 |
| `defaultContextWindow` | `262144` | 某条 `models` 没写 `contextWindow` 时用。按厂商标称窗口改 |
| `defaultMaxTokens` | `32768` | 模型**能力**上限，不是每次请求的输出帽 |
| `defaultInput` | `[text]` | 整条路由的模型都能看图时写成 `[text, image]`。本插件默认不把飞书图塞进 session；没把握别开 |
| `reasoning` | 不传 | 每轮都要带思考时再写。取值：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `compat.thinkingFormat` | 按 `baseURL` 猜 | **仅** `openai-completions`。私有网关 URL 认不出来、思考块或工具调用乱套时再写。取值：`openai` `deepseek` `openrouter` `together` `zai` `qwen` `string-thinking` `ant-ling` |
| `compat.supportsReasoningEffort` | 检测 | 同样只对 `openai-completions`。厂商不吃 `reasoning_effort` 就设 `false` |
| `headers` | 无 | 厂商要额外头（版本号、组织 id）。别在这里写密钥；`Authorization` 只留给没有 `apiKeyEnv` 的本地服务 |
| `streamIdleTimeoutMs` | `300000` | 思考很久、流中间停太久被掐时再加大 |
| `timeoutMs` | 适配器默认 | HTTP 整段超时 |
| `retryPolicy` | 普通重试 | 一般不用动 |

### `models[]` 一条模型

| 字段 | 必填 | 含义 |
|------|------|------|
| `id` | 是 | 发给厂商的模型名；json 的 `model` 抄它 |
| `name` | 否 | 展示名，默认等于 `id` |
| `contextWindow` | 否 | 上下文容量。不写走路由的 `defaultContextWindow` |
| `maxTokens` | 否 | 单次输出能力。不写走 `defaultMaxTokens` |
| `input` | 否 | 如 `[text]` 或 `[text, image]`。不写则继承目录或 `defaultInput` |
| `reasoningEfforts` | 否 | 思考档位 → 线上字面量。键是 `off`/`low`/`high`/`max` 这些档，值是厂商要的字符串。`off` 可以留空，表示这个档不传字段。`false` 关掉思考 |
| `compat` | 否 | 覆盖这一条的 `thinkingFormat` / `supportsReasoningEffort`，规则同上 |

目录路由还可以用 `modelOverrides`：按 `id` 改某一个内置模型，其余目录保留。手写路由没有内置目录，不要写 `modelOverrides`。

完整可抄骨架见 `examples/profile.cordis.patch.yml` 和 `examples/models.json`。字段真源是 dsh 包 `@deepseek-ai/dsh-llm-pi-ai`。

## 多 bot

同一 `dsh --profile feishu` 可以挂 2～3 个飞书应用。历史共用，会话分开。`/resume` 里被另一个窗口握住的会标「占用」。

## 图 / 语音 / 文件

入站附件落到 `DSH_FEISHU_INBOX/inbox/`，路径写给模型。**不**把图片塞进 session image block——不少模型会把后面的纯文字也打挂。

回图、回文件、回语音走工具 `send_file`。音频加 `voice=true` 会转 opus 再发成飞书语音（本机要有 ffmpeg）。

## 记忆 / 笔记 / 收尾（可选）

三层，插件代码不用改：

| 层 | 落在哪 | 怎么开 |
|---|---|---|
| 全局记忆 | `$DSH_FEISHU_MEMORY_DIR`/`MEMORY.md` 索引 + 分文件 | 设环境变量。空模板：`examples/memory/` |
| 项目索引 | 项目根 `INDEX.md` | 提示词：点名项目先读它。模板：`examples/project/` |
| 项目日志 | `<项目>/logs/项目名_YYYY-MM-DD.md` | checkpoint 一行；`/bye` 收拢成摘要 |

设 `DSH_FEISHU_MEMORY_DIR` 指向一个含 `MEMORY.md` 的目录。稳定前缀只放指针，不灌全文。不设则完全不加载记忆段。拷贝空索引时不要覆盖已有文件。

随手记是 `note` skill（`examples/skills/note/`）→ `~/notes.md`。「记住 / 忘掉」走全局记忆，不进笔记。本插件没有内置 cron，「提醒我」不要写进笔记假装会响。

`/bye` 原样交给 Agent。把 `examples/skills/bye/` 拷到 dsh 会扫的 skills 目录（常见 `~/.dsh/skills/`）才会真正改文件。bye 对账 `~/notes.md` 的 `[待办]`。

技能不会随插件自动安装，要拷一次。

项目级 `CLAUDE.md` / `AGENTS.md` 默认关。打开：`DSH_FEISHU_PROJECT_CLAUDE_MD=1`。那是路径上溯的指令头，不是项目记忆。

## MCP 工具裁剪（可选）

默认识图 / 多步浏览类工具藏着，会话里 `enable_mcp pack=omnicore` 或 `pack=browser` 再打开。搜索、读网页若在 always 列表里则常驻。

这套默认名字对齐常见的 OmniCore / browser-mcp。你用别的 MCP，改环境变量：

```
DSH_FEISHU_MCP_PACKS=vision:^mcp__vision__;browse:^mcp__browse__
DSH_FEISHU_ALWAYS_TOOLS=mcp__browse__search
DSH_FEISHU_DROP_TOOLS=mcp__browse__get_html
```

没有这些 MCP 也能跑，只是 `enable_mcp` 打开后找不到对应工具。

## SlashCommand

模型可用 `SlashCommand({ command: "/rename 短名" })` 给当前会话改名。只允许 `/rename`。用户手打 `/status` `/clear` `/stop` 仍走入站，不给模型。

## 上下文 8K 门

累计过 100K 才开门。之后名单内、超过 8K 的 `tool/result` 完整看 3 次，第 4 次发送前剪成官方头 4K 尾 1K。skill / 报错 / 开门前历史不过。规格见 [PRUNE.md](../PRUNE.md)。

## 高爆径

默认拦：未点名/大范围 `rm`、`find -delete`、破坏性 git、删库、磁盘擦除、杀 dsh 进程。飞书出橙卡，点「允许这一次」才跑。打字同意不算批准。关：`DSH_FEISHU_GUARD=0`。

提问走 `ask_user_question`：有选项出蓝卡，选项两列一排带序号、说明是灰字菜单，卡内有填空「提交回答」（默认一行），也可以直接打字。先到的算数。开放平台须订回调 `card.action.trigger`。

## 重启续跑

进程重启后插件主动 resume 所有已知会话（不再等第一条消息），并向每个会话发青头播报卡：会话名 + 模型名。

重启包装脚本可以在重启前往 `$DSH_HOME/restart-continue.json` 写一条「续跑指令」：

```json
{ "text": "继续刚才的工作：……", "chatKey": "cli_xxx::oc_xxx", "ts": 1755000000000 }
```

- `text` — 一句话指令，由调用方（通常是模型自己）在重启前按当时的工作状态设计
- `chatKey` — 目标会话 `appId::chatId`；省略时若只有一个活跃飞书会话则投给它
- `ts` — 写入时间戳（毫秒）；超过 10 分钟视为过期不投

启动流程读到该文件后：目标会话的青卡内直接展示指令全文，并把 `text` 作为新消息投进该会话。文件读后立即覆写为 `{"consumed":true}`，防崩溃重投。

## 本地假 bot

进程起来后有一个 `appId=cli` 的假通道，不占飞书额度：

```
./scripts/dsh-feishu-cli ping
./scripts/dsh-feishu-cli send /model
./scripts/dsh-feishu-cli send "只回一个字：通。不要调工具。"
```

套接字默认 `/tmp/dsh-feishu-cli.sock`。

### 定向投递到真实会话

`-b` 指定真实 bot（appId，或在 `DSH_FEISHU_CLI_BOTS` 里定义的别名），消息经 bridge 投进该 bot 的飞书会话，回复也从该 bot 发出；适合 crontab 定时任务：

```json
{ "work": "cli_xxxxxxxxxxxxxxxx" }
```

```
DSH_FEISHU_CLI_BOTS='{"work":"cli_..."}' ./scripts/dsh-feishu-cli send -b work -c oc_xxx --no-wait "提醒：……"
./scripts/dsh-feishu-cli send -b work -c oc_xxx -m oa "用 overlay 里的 oa 跑这一轮"
```

`-m` 单次覆盖模型（别名来自模型文件），只影响这一轮，不改会话保存的选型。消息进入的是该会话的现有历史，之后可以继续追问。

## 运行时文件

都在 `$DSH_HOME`（本仓脚本默认 `.dsh-home/`）：

- `feishu-chats.json` — 每个窗口的 session / 模型
- `feishu-history.json` — `/resume` 列表
- `restart-continue.json` — 重启续跑指令（读后即焚，见「重启续跑」）
- `profiles/feishu/` — dsh profile

附件在 `workspace/inbox/`。日志在 `logs/dsh-feishu_YYYY-MM-DD.log`。
