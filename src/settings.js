export function loadSettings() {
  const excludes = String(process.env.DSH_FEISHU_CLAUDE_MD_EXCLUDES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    projectClaudeMd: process.env.DSH_FEISHU_PROJECT_CLAUDE_MD === '1',
    claudeMdExcludes: excludes,
  }
}
