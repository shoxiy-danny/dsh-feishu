---
name: bye
description: 会话收尾。用户说 bye / /bye 时必须执行。更新项目文档、当天任务日志、记忆、会话名，让下次会话能快速上手。
---

# Bye - 会话收尾

知识库编辑，不是记录员：合并优于追加，删除优于保留。
目标只有一个——**下一个会话不用问你就能进入状态。**

用户说 bye 或 `/bye` 就跑。别的词（再见 / 退出 / 结束 / 整理）不触发。

dsh-feishu 把 `/bye` 原样交给 Agent，插件自己不收尾。本 skill 负责真正改文件。拷到 dsh 会扫的 skills 目录，例如 `~/.dsh/skills/bye/`。

## 路径

| | 默认 |
|---|---|
| 记忆目录 | `$DSH_FEISHU_MEMORY_DIR`（须含 `MEMORY.md`） |
| 任务日志 | `<项目>/logs/项目名_YYYY-MM-DD.md` |
| 退出摘要 | `<项目>/logs/项目名_YYYY-MM-DD_摘要.md` |
| 改名 | `SlashCommand({ command: "/rename 短名" })` |

未设 `DSH_FEISHU_MEMORY_DIR` 或目录里没有 `MEMORY.md`：跳过记忆，摘要里写一句「记忆未配置」。不要去猜别人的记忆路径。

不改全局 `CLAUDE.md` / `AGENTS.md`。项目根已有 `README.md` 才考虑改；没有可运行代码不新建。

## 五步

### 1. 盘点（一次 bash，不要多轮）

```bash
date
echo "MEMORY=${DSH_FEISHU_MEMORY_DIR:-unset}"
ls "${DSH_FEISHU_MEMORY_DIR:-/dev/null}" <project-root>/ <project-root>/docs/ 2>/dev/null
find <project-root> -maxdepth 2 -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null
ls <project-root>/logs/*_$(date +%Y-%m-%d)* 2>/dev/null
```

只 Read：`MEMORY.md`（若已配置）、项目根 `README.md`、**本次会话触及**的 docs / memory、上面捞到的当天日志。其余不读。

### 2. 改（真 Edit/Write，不是描述）

顺序：项目文档 → 任务日志 → 记忆。每个本次改动都先判断「改 / 不改」，不改的在摘要里说一句为什么。

- **项目文档**：只有真新增/改了能力（API、特性、数据结构、运维步骤、环境变量）才动。改旧档，不另建。读者是第一次接触项目的人。跨项目改动（共享协议 / 配置 / 端点）两边都对齐。
- **任务日志**：`<项目>/logs/项目名_YYYY-MM-DD.md` 补本次做了什么、结论、遗留。盘点范围是全会话。会话中途的 `[进度]` checkpoint 行只是参考原料，用来核对和拾遗，不是唯一来源。叙事用 `## bye HH:mm` 追加在文件末尾，不改已有 `[进度]` 行。bye 本身不写 checkpoint。没有就建。这是下次会话第一入口。
- **记忆**：并入旧条目；重复合并；过期改掉；完成的计划删掉。单文件 + frontmatter，再更新 `MEMORY.md` 索引一行（~150 字）。相对日期换绝对日期。已有同主题先改旧文件。不要把正文写进 `MEMORY.md`。

frontmatter：

```
---
name: 短名
description: 一行，供以后判断是否相关
type: user | feedback | project | reference
---
```

四类：`user`（角色、目标、偏好）/ `feedback`（纠正过的做法：规则 + **Why:** + **How to apply:**）/ `project`（进行中的事，相对日期写成绝对日期）/ `reference`（外部系统指针）。

不写进记忆：代码模式 / 架构 / 路径（读现码）、git 史、调试菜谱、已在提示词或项目文档里的、会话流水账。

自检：触及的记忆 description 对得上；改动文件里 `grep -E "今天|昨天|刚刚|最近|上周"` 清零。

### 3. 对账 Todo

读 `~/notes.md`（没有就跳过）：做完的 `[待办]` 改 `[完成]` 并追加 `（YYYY-MM-DD 完成）`；新待办按 `HH:mm [待办] 【项目名】 内容` 补登。没变化就跳过。不把 todo 写进记忆文件。

### 4. 退出摘要

写 `<项目>/logs/项目名_YYYY-MM-DD_摘要.md`：做了什么、改了哪些文档/记忆、遗留与未处理。再给用户一段短同步，只列实际变更；无变更也明示「审查过了，无变更」。拿不准的列「未处理」。

### 5. 会话命名

只有本次有文件被 Edit/Write 才命名。主题 ≤20 字，动词+对象。已有贴切名字就跳过。调 `SlashCommand({ command: "/rename 短名" })`，不要请用户手打、不要 bash 改名。

## 边界

- 记忆互相矛盾无法判断 → 列「未处理」，其余自己拍板。
- 项目还在 vibe、没有可运行代码 → 不建 README。
- 发现以前漏同步 → 顺手修。
- 提示词里应有一句：用户说 bye 或 `/bye` 就跑本 skill。没有这句时，本文件仍按触发词执行。
