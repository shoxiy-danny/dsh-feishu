import { randomUUID } from 'node:crypto'
import { lockedCard, resumeCard } from './cards.js'

export async function presentResume({ store, lark, appId, chatId, items }) {
  for (const rec of store.finds(appId, chatId, 'resume')) {
    store.settle(rec.id, { abort: true, reason: 'replaced' })
  }
  const id = randomUUID()
  const card = resumeCard({ id, items })
  const messageId = await lark.sendCard(chatId, card)
  store.add({
    id,
    kind: 'resume',
    appId,
    chatId,
    messageId,
    lark,
    resolve: (result) => {
      if (result?.stay || result?.picked) return
      if (result?.timeout) {
        void lockResume({ messageId, lark }, {
          title: '会话列表已过期',
          template: 'grey',
          body: '再发 /resume 看新列表。',
        })
        return
      }
      if (result?.abort) {
        const replaced = result.reason === 'replaced'
        const switched = result.reason === 'switched'
        void lockResume({ messageId, lark }, {
          title: replaced ? '已更新' : switched ? '已切换' : '已取消',
          template: switched ? 'turquoise' : 'grey',
          body: replaced ? '请查看下方新卡片。' : switched ? '已用斜杠切到别的会话。' : '未切换会话。',
        })
      }
    },
  })
  return messageId
}

export async function lockResume(rec, { title, template, body }) {
  if (!rec?.messageId || !rec.lark?.editCard) return
  try {
    await rec.lark.editCard(rec.messageId, lockedCard({
      title: title || '已结束',
      template: template || 'grey',
      body: body || '',
    }))
  } catch (err) {
    process.stderr.write(`[dsh-feishu] resume card lock failed: ${err}\n`)
  }
}

export function resumePickFailed(reply) {
  const text = String(reply || '')
  return text.startsWith('切不过去') || text.startsWith('序号无效')
}
