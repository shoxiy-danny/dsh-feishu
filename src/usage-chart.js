// 飞书卡片原生 chart 组件（基于 VChart）。不依赖外部渲染，客户端直接画。
// 单卡建议最多 5 个图表；移动端不支持 texture / conical / extensionMark 图片等属性，这里都不使用。

const DAY_MS = 86_400_000
const BJ_OFFSET = 8 * 3600 * 1000

const PALETTE = ['#3D7EFF', '#00C2A8', '#FF8A3D', '#9B6BFF', '#F25C8A', '#4BC0E8', '#C6A24B', '#7A8CA6']

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 轴刻度缩写，别让 300000000 把屏占满
function fmtTok(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}K`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}

function dayLabel(start, now) {
  const t = new Date(Number(start) + BJ_OFFSET)
  const todayStart = Math.floor((Number(now) + BJ_OFFSET) / DAY_MS) * DAY_MS - BJ_OFFSET
  return start === todayStart ? '今天' : WEEKDAY[t.getUTCDay()]
}

export function modelsInOrder(report) {
  return (report.models || []).map((row) => row.alias || row.model || '?')
}

function colorMap(names) {
  const map = new Map()
  names.forEach((name, i) => map.set(name, PALETTE[i % PALETTE.length]))
  return map
}

// 图 1：近 7 天每日 token，一天一根柱（模型构成交给饼图）
export function dailyStackChart(report) {
  // 按量级选单位，左轴不出现一长串 0；柱顶数值保留一位小数
  const peak = Math.max(0, ...(report.daily || []).map((row) => row.input + row.output))
  const unit = peak >= 1_000_000 ? { div: 1_000_000, name: 'M' } : { div: 1000, name: 'K' }
  const field = `tokens (${unit.name})`
  const values = []
  for (const row of report.daily || []) {
    const tok = row.input + row.output
    if (!tok) continue
    values.push({ day: dayLabel(row.start, report.now), [field]: Number((tok / unit.div).toFixed(1)) })
  }
  if (!values.length) return null
  return {
    tag: 'chart',
    aspect_ratio: '16:9',
    chart_spec: {
      type: 'bar',
      data: [{ id: 'tokens', values }],
      xField: 'day',
      yField: field,
      barMaxWidth: 26,
      label: { visible: true, position: 'top', style: { fontSize: 10 } },
      color: ['#3D7EFF'],
      legends: { visible: false },
      axes: [
        // 柱顶已标绝对值，左轴不再画刻度数字
        { orient: 'left', grid: { visible: true, style: { lineDash: [3, 3] } }, label: { visible: false }, domainLine: { visible: false }, tick: { visible: false } },
        { orient: 'bottom', label: { style: { fontSize: 10 } } },
      ],
      animation: false,
    },
  }
}

// 图 3：模型 token 占比（环形）
export function modelShareChart(report) {
  const rows = (report.models || []).filter((row) => row.input + row.output > 0).slice(0, 8)
  if (rows.length < 2) return null
  const sum = rows.reduce((acc, row) => acc + row.input + row.output, 0)
  // 图例直接显示「别名 占比%」，饼面不挂标签
  const values = rows.map((row) => {
    const alias = row.alias || row.model || '?'
    const tok = row.input + row.output
    const pct = sum > 0 ? ((100 * tok) / sum).toFixed(1) : '0.0'
    return { 模型: `${alias} ${pct}%`, tokens: tok }
  })
  const colors = colorMap(values.map((v) => v.模型))
  return {
    tag: 'chart',
    aspect_ratio: '4:3',
    chart_spec: {
      type: 'pie',
      data: [{ id: 'share', values }],
      valueField: 'tokens',
      categoryField: '模型',
      outerRadius: 0.85,
      innerRadius: 0.5,
      color: values.map((v) => colors.get(v.模型)),
      label: { visible: false },
      legends: { visible: true, orient: 'right', item: { label: { style: { fontSize: 12 } } } },
      padding: { left: 4, top: 4, bottom: 0, right: 0 },
      animation: false,
    },
  }
}

export function chartElements(report) {
  return [dailyStackChart(report), modelShareChart(report)].filter(Boolean)
}
