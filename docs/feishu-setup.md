# 飞书应用怎么开

给要装这套插件的人（或 Agent）逐步做。不是飞书官方教程，只写真正用到的最小集。国际版 Lark 一样，域名用 `FEISHU_DOMAIN`。

部署面是无头常驻（Linux / macOS / WSL）。首个 bot **不要指望终端扫码**：无头进程没有 TTY，码没处可贴。先在开放平台建好企业自建应用，凭据写进环境变量，再启动 `dsh --profile feishu`。已经通了的 bot 再开第二个，才谈得上把码打回飞书。

装插件、写环境、启动的顺序见仓库 README「安装」。本页只覆盖开放平台那一步。

## 1. 新建企业自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)
2. 创建企业自建应用
3. 记下 App ID / App Secret，填进 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`

不要复用已经挂在别的长连接上的应用。两个进程抢同一个 app = 互踢或双回。

## 2. 权限

在「权限管理」打开：

- 获取与发送单聊、群组消息
- 获取群组信息
- 以应用身份发消息
- 上传图片 / 文件（要回图、回文件、回语音才需要）
- 给消息加表情（入站确认）

群里用的话，把应用加进目标群，并打开「机器人」能力。

## 3. 事件订阅：长连接，不要 Webhook

插件走飞书 SDK 的 WebSocket，进程自己连出去。

- 订阅方式选 **长连接 / WebSocket**
- 不要填 webhook URL，不要在本机开一个收事件的 HTTP 口
- 事件至少勾：`im.message.receive_v1`
- 回调再勾：`card.action.trigger`（高危审核卡、提问卡。没订则按钮点了没反应）

保存后启动 `dsh --profile feishu`。日志出现 `ready bots=...` 再在单聊里打一句。

## 4. 第二个、第三个 bot

同一进程可以挂最多三个应用：

```
FEISHU_APP_ID_2=
FEISHU_APP_SECRET_2=
FEISHU_APP_ID_3=
FEISHU_APP_SECRET_3=
```

提示词、工具、模型表共用一份。会话按 `(appId, chat_id)` 分开。`/resume` 能看到另一个 bot 的近期历史，但同一条 session 不能被两个窗口同时握住。

可选：

```
DSH_FEISHU_BOT_LABELS=cli_xxx=Work,cli_yyy=Home
```

占用提示会显示这个短名，而不是截断的 App ID。

## 5. 验一下

启动后在这个应用的单聊发「你好」。应先收到一个拇指表情，再看到进度卡片，然后是正文。

收不到：

- 事件是不是还停在 webhook
- 权限有没有审过
- 是不是另一个进程已经连着同一个 App ID
- 看当天日志 `logs/dsh-feishu_YYYY-MM-DD.log`
