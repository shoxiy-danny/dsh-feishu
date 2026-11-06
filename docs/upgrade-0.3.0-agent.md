# 把 dsh-feishu 升到 0.3.0

给已经在跑这个插件的机器上的 Agent。人读变化看 [0.3.0 升级了什么](whats-new-0.3.0.md)。第一次安装不要看这篇，看 README。

目标版本：`0.3.0`，commit `de77276`，仓库 `github:shoxiy-danny/dsh-feishu`。
发布日：2026-11-06。没有新增 npm 依赖。不要改用户的 `models.json`，不要动密钥。

## 1. 确认现在装的是哪一种

```sh
cat "${DSH_HOME:-$HOME/.dsh}/profiles/feishu/package.json"
node -p "require((process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/feishu/node_modules/dsh-feishu/package.json').version"
```

`dependencies` 里 dsh-feishu 那一行决定升级命令：

| 看到的 | 怎么升 |
|---|---|
| `"github:shoxiy-danny/dsh-feishu"` 或带 `#main` | 跑下面的 A |
| `"github:shoxiy-danny/dsh-feishu#<sha>"` | 跑下面的 B。`install` 和 `pnpm update` 都不会动钉死的 sha |
| `"link:/某路径/dsh-feishu"` | 跑下面的 C |

profile 不叫 `feishu` 就换成实际名字。`DSH_HOME` 不是默认时，上面的路径也要换。

## 2. 升级

### A. 跟 main

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#main
```

`pnpm update dsh-feishu` 可能报 Already up to date，不要用它判断。

### B. 钉 commit

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#de77276
```

想以后跟最新，改用 A。

### C. 本地 link

```sh
cd /那个/路径/dsh-feishu
git pull
node -p "require('./package.json').version"   # 应是 0.3.0
```

不要重跑 `setup.sh`。这次没加依赖。

## 3. 重启

插件在进程启动时加载。不重启等于没升。

先停掉正在跑的 `dsh --profile feishu`，再用这台机器平时的启动方式起来。不要 `pkill -f dsh` 去扫别的进程。有包装脚本就用包装脚本。

## 4. 验收

启动日志里应有：

```text
[dsh-feishu] prompts v0.1.11 loaded from
[dsh-feishu] send_file / buzz_user registered
```

装好的包版本：

```sh
node -p "require((process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/feishu/node_modules/dsh-feishu/package.json').version"
```

应打印 `0.3.0`。

飞书里让用户发一轮会调用工具的话（例如「读一下当前目录」）。通过标准：

- 工具收进一张灰色折叠卡，不是一条条蓝色进度行
- 终局仍是绿头 `Done · dsf`（或当前别名）
- `/usage` 有反应

`/usage` 在 0.1.9 上没有。0.2.0 已有，所以它只能证明不是 0.1.x，不能证明是 0.3.0。认版本号和折叠卡。

## 5. 可选，不配也能用

```sh
# 长任务结束时加急。默认 300000（5 分钟）。0 = 关
export DSH_FEISHU_LONG_BUZZ_MS=300000
# 提问卡 / 审批卡没人理就加急。默认 120000（2 分钟）。0 = 关
export DSH_FEISHU_WAIT_BUZZ_MS=120000
```

要用加急：飞书开放平台给这个应用开 `im:message.urgent`。每个应用单独开。没开时文本仍发出，加急那一步失败，对话不受影响。

## 6. 不要做

- 不要把别的机器上的模型表、App ID、密钥抄进这个仓库或这个 profile
- 不要为了升级改 `cordis.patch.yml` 里已有的 provider
- 不要删 `feishu-chats.json` / `feishu-history.json`。这次没改它们的格式
- 文件收发：先看装好的版本。0.1.9 及更早，富文本里夹的文件收不到，升到 0.3.0 会好。已经是 0.2.0 还收不到，这次升级修不了，查开放平台是否开了「上传图片 / 文件」、事件是否为长连接、文件是否超过 25MB、日志里有没有 `附件失败`

## 7. 退回 0.2.0

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#2aaecc4
```

然后重启。
