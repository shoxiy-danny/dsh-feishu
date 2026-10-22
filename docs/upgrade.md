# 升级

给已经在用这个插件的机器。第一次装看 README 的「安装」，不用看这篇。

装法由 `dsh plugin add` 时写的 spec 决定，升级方式也跟着变。先确认自己是哪一种。

## 0. 先看现在装的是什么

```sh
# profile 目录：$DSH_HOME/profiles/feishu，默认 DSH_HOME 是 ~/.dsh
cat ~/.dsh/profiles/feishu/package.json
```

看 `dependencies` 里 dsh-feishu 那一行：

| 你看到的 | 说明 | 升级方式 |
|---|---|---|
| `"github:shoxiy-danny/dsh-feishu"` | 跟 `main` 分支 | 「A. 浮动分支」 |
| `"github:shoxiy-danny/dsh-feishu#a1b2c3d"` | 钉死某个 commit | 「B. 钉了 commit」 |
| `"link:/你的/路径/dsh-feishu"` | 从本地源码装 | 「C. 本地 link」 |

版本号可以直接看装好的包：

```sh
node -p "require('$HOME/.dsh/profiles/feishu/node_modules/dsh-feishu/package.json').version"
```

## A. 浮动分支

spec 浮着，但 `pnpm-lock.yaml` 里钉着具体 commit。所以能不能升，看的是**重新解析了没有**。

实测结论（pnpm 10.15.1）：

| 命令 | 会不会升 |
|---|---|
| `dsh plugin --profile feishu install` | **会**，重新解析到最新 `main` |
| `dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#main` | **会**，最确定 |
| `pnpm update dsh-feishu`（在 profile 目录里） | 不稳，可能报 Already up to date |

不确定就跑最确定的那条：

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#main
```

加完 spec 变成带 `#main` 的形式。以后想再升，还是跑这一条（`update` 在带 ref 的 spec 上会报
Already up to date，别指望它）。

**注意**：如果 spec 里已经写了 `#<sha>`（不在本节范围），`install` 不会升——见 B 节。

## B. 钉了 commit

钉死之后 `install` 和 `update` 都**不会动**（实测：0.1.9 钉着 f81b576，跑了 `install` 仍然是 0.1.9）。
钉了就是钉了，这是钉版本的目的。想升就显式换新 commit，或换回浮动。

```sh
# 知道目标 commit
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#<新sha>

# 或者干脆改成跟 main（推荐给想一直拿最新的人）
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#main
```

查最新 commit：

```sh
git ls-remote https://github.com/shoxiy-danny/dsh-feishu refs/heads/main
```

## C. 本地 link

从本仓 `scripts/setup.sh` 装的，或者手动 `add /path/to/repo` 的，升级就是拉代码：

```sh
cd /你的/路径/dsh-feishu
git pull
```

link 装没有拷贝步骤，`git pull` 完就是新代码。不用重跑 `setup.sh`，除非 `package.json` 的依赖变了——这次 0.2.0 没加依赖，不用跑。

## 升级之后

```sh
# 1. 重启（插件代码是进程启动时加载的，不重启不生效）
#    先停掉正在跑的 dsh，再用平时的启动方式起来
dsh --profile feishu

# 2. 看启动日志确认版本和模型表
#    日志里应该有这两行：
#    [dsh-feishu] models loaded from ...  (或者没有这行，说明走内置 dsf)
#    [dsh-feishu] prompts v0.1.10 loaded from ...
```

在飞书里按顺序验这三个，能出东西就是新版在跑：

| 发什么 | 旧版（0.1.9） | 新版（0.2.0） |
|---|---|---|
| `/status` | 一段纯文字 | 一张青色卡片 |
| `/usage` | 回「本期支持 …」不含 usage | 用量卡片 |
| `/model`（不带参数） | 一段文字列表 | 一张可点的分组卡 |

最省事的一个判据：**`/usage` 有反应**就是升级成功了（0.1.9 根本没这个命令）。

如果 `/status` 还是纯文字，说明跑的还是旧代码——检查是不是重启了另一个 profile，或者 `DSH_HOME` 指到了别的目录。

## 0.1.9 → 0.2.0 要注意的

这次没有破坏性改动，老的 `models.json` 直接能用。但有几点变了：

1. **`models.json` 多了三个可选字段**：`tier` / `short` / `vision`。

   ```json
   {
     "oa": {
       "provider": "my-openai",
       "model": "gpt-4.1",
       "label": "oa = gpt-4.1",
       "window": 1048576,
       "tier": "pro",
       "short": "gpt-4.1",
       "vision": false
     }
   }
   ```

   - `tier`：`/model` 卡片的分组。可选 `pro` / `flash` / `cb` / `other`。不写就进「未分组」。
   - `short`：卡片上的短名。不写就用 `model`。
   - `vision`：这个模型能不能原生吃图。**默认 false**。标了 `true` 才会把飞书发来的图当图片块送进会话。

   不写这三个字段完全不影响运行，只是 `/model` 卡片分组难看一点、图仍然走路径 + OmniCore。

2. **`/status` 从纯文字变成卡片**。CLI bot 仍是文字，脚本里解析文本的注意一下。

3. **`/clear` 回执变成卡片**，正文多了当前模型名。

4. **`/model` 不带参数变成选型卡**。以前回一段文字列表，现在出卡片。CLI bot 仍是文字。

5. **`/resume` 变成每页 8 条**，超过出翻页按钮。

6. **图片行为变了**：以前一律落盘给路径；现在如果模型标了 `vision: true`，图会直接进会话。
   如果你在 0.1.9 上跑得好好的、不想改，**什么都别做**——默认全是 `false`，行为和以前一样。

7. **bot 名字**：`/usage` 和卡片里显示的 bot 名现在读 `DSH_FEISHU_BOT_LABELS`：

   ```sh
   export DSH_FEISHU_BOT_LABELS='cli_aaa=Alice,cli_bbb=Bob'
   ```

   不配就显示 App ID 前 10 位。0.1.9 没有 `/usage`，所以这条只影响新功能。

8. **重启脚本挂接（可选）**：想让重启后的回执知道往哪个窗口发，设 `DSH_FEISHU_RESTART_SCRIPT`：

   ```sh
   export DSH_FEISHU_RESTART_SCRIPT=/绝对路径/restart.sh
   ```

   之后模型 bash 调这个脚本、没带 `appId::chatId` 时，插件会自动补当前窗口作为最后一参。
   不设则完全不碰命令。

## 回滚

想回 0.1.9（`f81b576` 是 0.1.9 的 commit）：

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#f81b576
```

然后重启。已实测：0.2.0 → 0.1.9 能干净退回去。

0.2.0 没有改任何持久化格式（`feishu-chats.json` / `feishu-history.json` 结构没变），回滚不用清数据。
`models.json` 里新加的 `tier` / `short` / `vision` 字段 0.1.9 会忽略。

## 排错

**升级完行为没变**

没重启。插件在进程启动时加载，`pnpm` 装完不重启等于没装。

**`pnpm update` 说 Already up to date，但版本还是老的**

lock 里钉着旧 commit。用 A 节里带 `#main` 的 `add`。

**启动报 `dsh-feishu: FEISHU_APP_ID / FEISHU_APP_SECRET missing`**

环境变量没进到进程。`source` 了 `.env` 吗？用 `scripts/start.sh` 起会自动 source。

**飞书里发命令没反应**

看日志有没有 `ready bots=`。长连接没起来多半是权限或事件订阅没对，见 [feishu-setup.md](feishu-setup.md)。

**卡片按钮点了没反应**

开放平台没订 `card.action.trigger`。见 [feishu-setup.md](feishu-setup.md)。
