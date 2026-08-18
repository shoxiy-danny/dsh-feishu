# 开发

本仓是纯 JS，git 安装不需要 `prepare` / 构建。

## 本地挂到 profile

```sh
pnpm install
dsh plugin --profile feishu add "$PWD"
dsh --profile feishu --dump-config | grep -A2 dsh-feishu
```

改 `src/` 后重启 `dsh --profile feishu` 即可。Cordis 会按包名解析已 link 的目录。

## 测

```sh
pnpm test
```

假 bot（进程起来之后）：

```sh
./scripts/dsh-feishu-cli ping
./scripts/dsh-feishu-cli send /model
./scripts/dsh-feishu-cli send "只回一个字：通。不要调工具。"
```

## 和自用仓的边界

不要把私有 bot id、本机绝对路径、私有模型供应商写回这个仓。
额外模型、MCP、记忆目录全部走环境变量或用户自己的 profile overlay。
