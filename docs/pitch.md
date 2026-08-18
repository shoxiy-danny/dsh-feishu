# 一页介绍（可直接贴）

## 短

DeepSeek Harness 的飞书前端。没有网页，没有 TUI。斜杠命令、模型热切换、进度卡片、Goal、多 bot、重启续聊，全部在飞书里。

```
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

## 稍长

dsh 官方面是 Web。dsh-feishu 把它换成一条飞书长连接：一个常驻进程，飞书进、飞书出。

和「外面 webhook、里面再 spawn 一次 CLI」不同。这是 Cordis 插件，create / followup / steer / cancel / resume 都在同一进程。补一句会并进当前轮，`/stop` 立刻停，进度卡片自己改，重启回到刚才那条会话。

适合已经在飞书办公、想把 coding agent 做成 7×24 同事的人。不适合还想留官方网页、或只把飞书当通知渠道的人。

文档：<https://github.com/shoxiy-danny/dsh-feishu>

## 市场页 description（中英）

Feishu / Lark as the only UI for DeepSeek Harness. No web app. Slash commands, live progress, Goal loops, multi-bot, resume after restart.

DeepSeek Harness 的飞书前端。没有网页。斜杠命令、进度卡片、Goal、多 bot、重启续聊，全部发生在飞书里。
