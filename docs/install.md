# 安装

从零装到能用。已经在跑老版本的看 [upgrade.md](upgrade.md)。

## 0. 前置

四样齐了再往下，缺一样后面会起不来。

**1. Node 22+**

```sh
node -v   # 要 v22.x
```

不够就装 Node 22，不要用 18 / 20。

**2. DeepSeek Harness CLI**

```sh
npm i -g @deepseek-ai/dsh
dsh --version
```

装完 `dsh --version` 要能印出版本号。印不出来就查 `npm prefix -g` 在不在 `PATH` 里。

**3. 模型 key**

DeepSeek 官方：去 [platform.deepseek.com](https://platform.deepseek.com) 建一把，变量名 `DEEPSEEK_API_KEY`。

用别的供应商（OpenAI 兼容网关、其它厂商）：key 名字随便，后面在 `cordis.patch.yml` 里引用。见「4. 加自己的模型」。

**4. 飞书企业自建应用**

去 [open.feishu.cn/app](https://open.feishu.cn/app) 建一个企业自建应用，记下 App ID 和 App Secret。

要点（逐步截图级说明见 [feishu-setup.md](feishu-setup.md)）：

- 权限：发消息、读群信息、以应用身份发消息、上传图片/文件、给消息加表情
- 事件订阅选**长连接 / WebSocket**，不要 Webhook
- 事件勾 `im.message.receive_v1`
- 回调勾 `card.action.trigger`（不勾则所有卡片按钮点了没反应）
- 打开「机器人」能力

无头服务器没地方贴二维码，所以第一个 bot 只能这样手建。

## 1. 装插件

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

装完会生成 `~/.dsh/profiles/feishu/`。确认一下：

```sh
node -p "require('$HOME/.dsh/profiles/feishu/node_modules/dsh-feishu/package.json').version"
```

要钉版本（推荐发给别人时这么装，免得哪天上游改了行为）：

```sh
git ls-remote https://github.com/shoxiy-danny/dsh-feishu refs/heads/main   # 取 sha
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#<sha>
```

## 2. 写环境变量

```sh
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export DEEPSEEK_API_KEY=sk-xxx
```

想长期用就把这几行放进 `~/.bashrc`，或者写在 `.env` 里用启动脚本 source。全部变量见 [env.md](env.md)。

## 3. 启动

```sh
dsh --profile feishu
```

日志里出现 `ready bots=` 就算起来了。拿不准就重定向到文件：

```sh
dsh --profile feishu >> ~/dsh-feishu.log 2>&1 &
tail -f ~/dsh-feishu.log
```

## 4. 验收

在自己应用的**单聊**里发一句「你好」。按顺序应该看到：

1. 消息上加了个表情（已收到）
2. 进度头 `[dsf-3%] Using ...` 之类
3. 正文回答

再试这几个，能出东西就说明主要功能都通了：

| 发什么 | 应该看到 |
|---|---|
| `/status` | 一张青色卡片，有机型/模型/上下文占用 |
| `/model` | 一张分组选型卡，能点 |
| `/usage` | 调用量卡片 |
| `/goal` | 目标设定卡 |
| `/resume` | 会话卡（第一次可能说没有可恢复的会话，正常） |

高危命令审核卡：让它跑一句 `rm -rf`，应该弹橙卡，点「允许这一次」才执行。

## 5. 加自己的模型（可选）

内置只有 `dsf` = `deepseek-flash`。要接别的供应商，改两个文件。

**a. 路由**：把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 的内容并进 `~/.dsh/profiles/feishu/cordis.patch.yml`，填你的 baseURL 和 key 变量名。

**b. 模型表**：把 [examples/models.json](../examples/models.json) 拷到某处，改好后：

```sh
export DSH_FEISHU_MODELS=/绝对路径/models.json
```

注意 `DSH_FEISHU_MODELS` 是**整表替换**——设了之后内置的 `dsf` 就没了，要留就自己抄回去。

`models.json` 的字段（含 `tier` / `short` / `vision`）见 [env.md](env.md#模型)。

**c. 重启**，然后发 `/model` 看卡片里有没有你加的。

## 从本仓脚本装（开发 / 自托管）

不想走 github 源、想改代码，就 clone 下来用脚本：

```sh
git clone https://github.com/shoxiy-danny/dsh-feishu.git
cd dsh-feishu
cp .env.example .env
# 填 FEISHU_APP_ID / FEISHU_APP_SECRET / DEEPSEEK_API_KEY
chmod +x scripts/*.sh scripts/dsh-feishu-cli
./scripts/setup.sh
./scripts/start.sh
```

`setup.sh` 会建 profile、装插件、dump 一份配置做自检（没有 web / headless 行才算过）。`start.sh` 会 source `.env`、按天切日志到 `logs/`。

这种方式升级就是 `git pull`，见 [upgrade.md](upgrade.md) C 节。

## 常见失败

| 现象 | 原因 |
|---|---|
| `dsh-feishu: FEISHU_APP_ID / FEISHU_APP_SECRET missing` | 环境变量没进到进程。检查是否 source 了 `.env` |
| `dsh-feishu: DSH_HOME is required` | 没用 `dsh` 命令起，或 `DSH_HOME` 被清空 |
| 日志无 `ready bots=`，发消息没反应 | 长连接没起来。检查事件订阅是不是选了 WebSocket、权限是否审批通过 |
| 卡片按钮点了没反应 | 回调没订 `card.action.trigger` |
| `Unknown command /xxx` | 该子命令这版还没有。发 `/` 会回本期支持列表 |
| 模型切换后报 400 且带 `image` | 目标模型不吃图。`models.json` 里别给它标 `vision: true`，重启即可；会话里的历史图会在启动/切换时自动换成路径 |
