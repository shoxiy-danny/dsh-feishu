# 环境变量

一张表看全。所有变量都可不设——不设就走默认，插件照常起来。

## 必填（三个，缺一个起不来）

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` | 飞书企业自建应用 App ID。见 [feishu-setup.md](feishu-setup.md) |
| `FEISHU_APP_SECRET` | 同上，App Secret |
| `DEEPSEEK_API_KEY` | DeepSeek API key。用别的供应商就改成那个供应商的 key |

## 多 bot

| 变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_APP_ID_2` / `FEISHU_APP_SECRET_2` | 空 | 第二个 bot |
| `FEISHU_APP_ID_3` / `FEISHU_APP_SECRET_3` | 空 | 第三个 bot |
| `FEISHU_APP_ID_4` / `FEISHU_APP_SECRET_4` | 空 | 第四个 bot |
| `DSH_FEISHU_BOT_LABELS` | 空 | bot 显示名，`cli_aaa=Alice,cli_bbb=Bob`。不设显示 App ID 前 10 位 |

一个进程能挂 4 个 bot。历史共用，会话分开；同一条 session 不能两个窗口同时握。

## 路径

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | dsh 的数据目录。profile 在 `$DSH_HOME/profiles/feishu` |
| `DSH_FEISHU_CWD` | 家目录 | Agent 的工作目录，也就是它 bash 的 cwd |
| `DSH_FEISHU_INBOX` | `$DSH_HOME/../workspace` | 入站附件落 `<这个>/inbox/` |
| `DSH_FEISHU_WORKSPACE` | 空 | `DSH_FEISHU_INBOX` 的旧名，两个都没设才用默认 |
| `DSH_FEISHU_MEMORY_DIR` | 空 | 记忆根，指向含 `MEMORY.md` 的目录。不设则完全不加载记忆段 |

## 模型

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FEISHU_MODELS` | 空 | 指向 `models.json`。**设了就整表替换**内置的 `dsf`，要留官方那条自己抄回去 |

`models.json` 每条支持：

| 字段 | 必填 | 说明 |
|---|---|---|
| `provider` | 是 | 路由名，要和 `cordis.patch.yml` 里的 provider 对上 |
| `model` | 是 | 上游真实模型 id |
| `label` | 否 | `/model` 和进度头上显示的名字 |
| `window` | 否 | 上下文窗口，默认 1000000 |
| `short` | 否 | 卡片上的短名，默认用 `model` |
| `tier` | 否 | `/model` 卡片分组：`pro` / `flash` / `cb` / `other`，默认 `other` |
| `vision` | 否 | 是否原生吃图，默认 `false`。详见下方「图」 |

样例：[examples/models.json](../examples/models.json)。

## 图 / 多模态

没有开关变量，按模型表里的 `vision` 走：

- `vision: true`：飞书发来的图作为图片块直接进本轮，模型看像素。
- `vision` 缺省或 `false`：图落本地，只把路径写给模型，再 `enable_mcp pack=omnicore` 用 OmniCore 识图。

切到不吃图的模型时，会话里已有的图片块会就地换成路径文字，避免下一轮请求 400。

## MCP 工具裁剪

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FEISHU_MCP_PACKS` | `omnicore:^mcp__OmniCore__;browser:^mcp__browser-mcp__` | 分组规则，分号分组、冒号分「组名:正则」。组名自动成为 `enable_mcp` 的选项 |
| `DSH_FEISHU_ALWAYS_TOOLS` | `mcp__browser-mcp__web_search,mcp__browser-mcp__fetch_page` | 逗号分隔。列进去的工具不受 `enable_mcp` 管，一直可见 |

不设就用默认的 OmniCore / browser-mcp 命名。

## 安全

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FEISHU_GUARD` | 开 | 设 `0` 关掉高危命令审核卡。**不建议关** |
| `DSH_FEISHU_RESTART_SCRIPT` | 空 | 指定重启脚本的绝对路径。设了以后，bash 调这个脚本且没带 `appId::chatId` 时自动补当前窗口 |

拦什么：未点名或大范围的 `rm`、`find -delete`、`xargs rm`、破坏性 git（force push / reset --hard / clean -f / 宽范围 checkout）、删库、磁盘擦除、杀自己的进程（`pkill -f dsh-*`）。

不拦：点名到具体项目的删除、`~/.claude/skills` 或 `~/.dsh/skills` 下的单文件、目标里带未展开 shell 变量的 `rm`（`$TMP_FILE`、`$(mktemp)`）。

## CLI / 本地 socket

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FEISHU_CLI_SOCK` | `/tmp/dsh-feishu-cli.sock` | 本地 CLI 的 unix socket 路径 |
| `DSH_FEISHU_CLI_BOTS` | 空 | CLI `-b` 用的别名表，JSON：`{"work":"cli_..."}` |

用于 `scripts/dsh-feishu-cli`，crontab 定时投递等场景。

## 指令头

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_FEISHU_PROJECT_CLAUDE_MD` | `0` | 设 `1` 打开项目级 `CLAUDE.md` / `AGENTS.md` 自动注入 |
| `DSH_FEISHU_CLAUDE_MD_EXCLUDES` | 空 | 逗号分隔的排除路径 |

关着的时候不扫项目指令头，只吃插件自带的提示词 + `DSH_FEISHU_MEMORY_DIR` 里的记忆索引。
