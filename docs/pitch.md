# 一页介绍（可直接贴）

## 短

Harness 长在飞书里，不是飞书遥控网页。给无头常驻用，不是笔记本扫码版。Goal 卡片、一进程多 bot、会变的进度头。

```
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

## 稍长

插件市场里 feishu / lark 已经三十多个。多数是通知器、多 IM 网关，或挂在官方网页旁边的桥。飞书只是遥控器，网页还在。不少还默认你坐在个人 PC 前，终端里弹二维码，手机扫一下就建好应用。

dsh-feishu 是跑在飞书里的 harness，部署面是无头常驻：macOS、Linux、WSL 都能跑。一个 `dsh --profile feishu` 当守护进程，日志进文件，没有要人盯着的 TTY。首个 bot 在开放平台建好、凭据写进环境变量再启动——无头机器上没处可贴码。已经通了的 bot 再开第二个，码可以打回飞书，那是后话。

不跟货架比按钮：没有打字机答案卡。要比的是长在飞书里（不是遥控网页）、Goal 卡片（设定/暂停/恢复都在卡上，重启不偷跑）、一进程多 bot、进度头 `[dsf-23% G1/3]`。

GitHub 上另有 `PGZXB/dsh-feishu`，飞书控制台 + 卡内审批，官方 Web 还在。owner 不同。

文档：<https://github.com/shoxiy-danny/dsh-feishu>

## 市场页 description（中英）

The harness lives in Feishu, as a headless daemon. Not a remote for the webpage, not a laptop QR setup. Goal cards, multi-bot, a live progress header.

Harness 长在飞书里，给无头常驻用。不是遥控网页，也不是笔记本扫码版。Goal 卡片、一进程多 bot、会变的进度头。
