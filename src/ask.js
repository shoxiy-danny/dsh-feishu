import { randomUUID } from 'node:crypto'
import { askCard, lockedCard, waitCard } from './cards.js'

export function attachAsk(ctx, { routeOf, store }) {
  const uq = ctx.get('userQuestions')
  if (!uq?.registerProvider) {
    process.stderr.write('[dsh-feishu] userQuestions missing; ask_user_question not wired\n')
    return
  }

  uq.registerProvider({
    async ask(request) {
      const route = request.agent ? routeOf(request.agent.id) : null
      if (!route?.lark || !route.chatId) {
        throw new Error('当前没有飞书窗口，无法提问')
      }
      const answers = []
      for (const question of request.questions || []) {
        if (request.signal?.aborted) {
          throw Object.assign(new Error('ask_user_question was aborted before the user answered'), { code: 'ASK_ABORTED' })
        }
        answers.push(await askOne({
          question,
          route,
          store,
          signal: request.signal,
        }))
      }
      return { answers }
    },
  })
  process.stderr.write('[dsh-feishu] ask_user_question -> Feishu cards\n')
}

async function askOne({ question, route, store, signal }) {
  const id = randomUUID()
  const options = question.multiSelect ? [] : (question.options || [])
  const card = askCard({
    id,
    header: question.header,
    question: question.question,
    detail: question.detail,
    options,
  })
  const messageId = await route.lark.sendCard(route.chatId, card)
  const rec = {
    id,
    kind: 'ask',
    appId: route.appId,
    chatId: route.chatId,
    messageId,
    questionId: question.id,
    lark: route.lark,
  }

  const onAbort = () => store.settle(id, { abort: true })
  signal?.addEventListener('abort', onAbort, { once: true })
  let result
  try {
    result = await waitCard(store, rec)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  if (result?.timeout) {
    void route.lark.editCard(messageId, lockedCard({
      title: '提问已过期',
      template: 'grey',
      body: question.question,
    }))
    throw new Error('ask_user_question timed out')
  }
  if (result?.abort) {
    void route.lark.editCard(messageId, lockedCard({
      title: '提问已取消',
      template: 'grey',
      body: question.question,
    }))
    throw Object.assign(new Error('ask_user_question was aborted before the user answered'), { code: 'ASK_ABORTED' })
  }

  if (result?.custom) {
    void route.lark.editCard(messageId, lockedCard({
      title: '已用文字回答',
      template: 'green',
      body: `**${question.question}**\n${result.custom}`,
    }))
    return { id: question.id, selected: [], custom: result.custom }
  }

  const selected = Array.isArray(result?.selected) ? result.selected : []
  void route.lark.editCard(messageId, lockedCard({
    title: '已选择',
    template: 'green',
    body: `**${question.question}**\n${selected.join('、') || '（空）'}`,
  }))
  return { id: question.id, selected }
}
