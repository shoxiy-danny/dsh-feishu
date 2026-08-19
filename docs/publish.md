# 发布到 GitHub / 插件市场

这是作者侧清单，用户装插件不用看。

## 仓库形态

插件市场扫的是 **GitHub 公开仓** 的结构，不是你本机的私有产品仓。

最低要有：

- 根目录 `package.json`，带 `dsh.bundle.patch`
- 根目录 `cordis.patch.yml`
- 入口 `src/index.js`（纯 JS，git 安装不跑 build）
- README
- topic：`dsh-plugin`（市场发现主要靠这个）

建议再加：`dsh` `dsh-bundle` `feishu` `lark`

## 装法用户会看到

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu
```

扫描过的页面会建议钉 commit：

```sh
dsh plugin --profile feishu add github:shoxiy-danny/dsh-feishu#<sha>
```

本仓是 JS，没有 `prepare` / 构建脚本，用户不用给 pnpm `allowBuilds`。

## 提交前自检

```sh
# 1. 不该出现的私货
rg -n 'nimo|Nimo|Madi|kuma-grk|CC-memory|\.nimo|aiproxy|cli_a94|cli_a922|/home/kuma' \
  --glob '!node_modules/**' --glob '!.dsh-home/**'

# 2. 单测
pnpm test

# 3. 结构
test -f package.json && test -f cordis.patch.yml && test -f src/index.js
```

## 第一次推

```sh
git init
git add .
git commit -m "Initial public release of dsh-feishu"
gh repo create shoxiy-danny/dsh-feishu --public --source=. --remote=origin --push
gh repo edit shoxiy-danny/dsh-feishu --add-topic dsh-plugin --add-topic dsh-bundle --add-topic dsh --add-topic feishu --add-topic lark
```

市场按 GitHub topic + 定时扫描收录。发现按 `created` 分片从旧仓往新仓啃，每小时最多 400。新仓常要等十来个小时。插队：打开 [提交页](https://dsh-plugin.market/submit) 贴仓库 URL。`POST /api/submit` 在 2026-08-19 对合法仓一律 500，页面多半也是同一个接口。

## 和自用原版的关系

自用仓继续跑私有配置、私有模型、私有记忆路径。这个公开仓是一份独立拷贝。改公开版不要回写自用版，除非你明确要同步某一处。
