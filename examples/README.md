# examples

| 路径 | 干什么 |
|------|--------|
| `profile.cordis.patch.yml` + `models.json` | 非官方模型 |
| `memory/` | 全局记忆空索引 + 四类样例。拷到 `$DSH_FEISHU_MEMORY_DIR` |
| `project/` | 项目 `INDEX.md` + `log.YYYY-MM-DD.md`（拷到项目 `logs/`） |
| `skills/bye/` `skills/note/` | 拷到 dsh 会扫的 skills 目录（常见 `~/.dsh/skills/`） |

技能不会随插件自动安装。记忆目录不设则前缀不加载记忆段。
