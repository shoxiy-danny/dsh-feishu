# 工具结果 8K 门（keep 3）

日期：2026-08-19
状态：已实施
范围：只改本仓。不改 dsh 底座。

替换现自制 `microcompact.js`：每轮 step 1、超 400 整段换成 `[旧工具结果已清]`。那套关掉。

---

## 1. 要解决什么

短任务尽量只追加，护 implicit cache。上下文过线之后，只瘦「已经给模型看过三遍」的大工具结果。用户话、模型正文、工具指令不动。

不做：冷启动先瘦、按 `payload.step` / `turn` 计数、次数写进 session、回砍启动前历史。

---

## 2. 两把尺

### 2.1 启动闩

- 量：`tokenMeter.measure(session).totalTokens`
- 线：累计 **100_000**
- 过线只开门，不剪任何已有结果
- 记下开门那一刻已在场的 `tool/result`（按 surface seq / callId）。这些是冻住的脑袋，之后永不走 8K 门
- 未过线：行为等于只追加

### 2.2 8K 门

只处理同时满足：

- 产生于启动闩打开**之后**
- 类型是 `tool/result`，非 `isError`，尚未剪过
- 工具名在过门名单
- 正文 Unicode 码点 **> 8192**

刀法用底座同一套数字，不另发明：

- `thresholdChars = 8192`
- `headChars = 4096`
- `tailChars = 1024`
- 中间插入 `\n\n[... tool result middle pruned ...]\n\n`

实现优先调 `ctx.toolResultPruner` 的单条剪法（`pruneContent` / 等价 API）。不要对整场 `pruneSession`：那会回头动启动前的大结果。

不到 8192 的结果：不计次、不剪、不打标。

---

## 3. keep 3

按**条**计，不数 step，不看 turn。

一条过门候选每完整进入一次发给 LLM 的 prompt（含纯文字那次调用），算看过一遍。满 3 次之后，**第 4 次组装 prompt 之前**把头尾剪进 surface。

典型：搜 → 读 → 改，三次决定都能看见该条全文；之后再调模型，这条已是头尾。

次数推导，不落盘：

- 用现成 `tool/result` 的 `turn` + `step`（结果首次出现时的模型往返）和当前即将发送的往返序
- 两次往返之间隔了几次 LLM 调用，就是已看次数
- 计数器不写 session、不写 meta、不进模型上下文
- `/resume` 后按字段重算，不依赖 WeakMap

≤8K 的结果不参与这套计数。

剪完用官方标记识别，不再剪第二次。

---

## 4. 名单

过门：

- `read` `glob` `grep` `bash`
- `web_search` `web_fetch`
- `mcp__browser-mcp__web_search` `mcp__browser-mcp__fetch_page`

不过门：

- `skill`（已定）
- `write` / `edit`（回执本来就短，自然跳过）
- OmniCore、browser 交互、`enable_mcp`、`send_file`、`ask_user`、`subagent`
- 用户 `user/message`、助手 text、`tool/call`

只 `replace` 表层 `tool/result` 正文。jsonl 原文保留。

---

## 5. 挂哪

`agent/pre-step`，每个即将发给模型的往返都进（含纯文字）。

顺序建议：

1. 量 token；未过 100K 则 `next()`
2. 若刚跨线，冻结当前已有 result 集合，`next()`（本拍不剪）
3. 已开门：对「启动后、名单内、>8K、未剪、已看满 3 次」的结果做头尾 replace
4. `next()`，让底座 `compaction-basic` 照旧跑

底座托底保留，与本方案不互斥。

---

## 6. 缓存

- 100K 前不改历史，前缀只追加
- 开门不改字节
- 第一次动刀发生在某条大结果第 4 次发送前，刀口在这条结果上，从这里往后重算
- 不往 session 写计数，避免 ≤8K 的结果因 meta 变化打断前缀

---

## 7. 明确不做

- 冷启动 TTL / 先瘦后发
- 按 turn 整轮清空
- 超线整段换成一行字
- 次数或 keep 标记写进 session / 发给模型
- 回砍启动前历史
- 改 dsh 底座 pruner 默认值
- skill 过门

---

## 8. 改哪些文件

- 已重写 `src/microcompact.js`：`attachMicroCompact` 仍由 `src/index.js` 挂 `agent/pre-step`
- 单测 `src/microcompact.test.js`：未过 100K 不剪；刚过线不回砍；>8K 看满 3 次才剪；≤8K / skill / 报错不剪
- 次数用后续 `step/start` 条数推导（`pre-step` 早于当拍 `step/start`）
- 启动闩的冻结集合挂进程内 WeakMap，不写 session。重启后若仍 ≥100K，会把当时在场的结果重新冻结
