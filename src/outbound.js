import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_BYTES = 25 * 1024 * 1024

export function attachOutbound(ctx, { routeOf, senderOf }) {
  const tools = ctx.get('tools')
  if (!tools) {
    process.stderr.write('[dsh-feishu] tools missing; send_file not registered\n')
    return
  }

  tools.register({
    name: 'send_file',
    description:
      '发送本地文件/图片/语音到当前飞书会话。图片按图片发；voice=true 且是音频时发成语音。'
      + '发语音时把这份语音的文字内容放进 text，飞书会跟着再发一条文字。'
      + '不要用它回普通文字。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '本地绝对路径' },
        voice: { type: 'boolean', description: '音频是否作为语音消息发送', default: false },
        text: {
          type: 'string',
          description: '这份语音说的内容（原文）。voice=true 时建议带上，不方便听的时候直接看文字',
          default: '',
        },
      },
      required: ['file_path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.result ?? '') }]
      },
    },
    async execute(args, exec) {
      const filePath = resolve(String(args.file_path || ''))
      if (!filePath || !existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`)
      }
      const st = statSync(filePath)
      if (!st.isFile()) throw new Error(`不是文件: ${filePath}`)
      if (st.size > MAX_BYTES) {
        throw new Error(`文件太大: ${(st.size / 1024 / 1024).toFixed(1)}MB，最大 25MB`)
      }

      const route = routeOf(String(exec.agent?.id || ''))
      if (!route?.chatId || !route.lark) throw new Error('当前没有对应的飞书会话')

      const result = await route.lark.sendFile(route.chatId, filePath, {
        voice: Boolean(args.voice),
        text: String(args.text || ''),
      })
      return { result }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '发送飞书文件',
      kind: 'other',
      rawInput: args?.file_path,
    }),
  })

  tools.register({
    name: 'buzz_user',
    description:
      '给用户发一条加急（buzz）提醒，客户端会弹横幅并响提示音。'
      + '只在用户明确要求「做完叫我 / 好了提醒我 / 提醒我一下」时调用；'
      + '或者这一轮明显跑很久、结果需要用户马上处理时主动调用一次。不要每轮都用，不要用来代替正常回复。',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '提醒时说的一句话，默认「任务做完了」',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value?.result ?? '') }]
      },
    },
    async execute(args, exec) {
      const route = routeOf(String(exec.agent?.id || ''))
      if (!route?.chatId || !route.lark) throw new Error('当前没有对应的飞书会话')
      const openId = senderOf?.(route.chatKey) || ''
      if (!openId && route.lark?.needsOpenId !== false) {
        throw new Error('没有记录到用户 open_id，先给机器人发一条消息')
      }
      const text = String(args.text || '').trim() || '任务做完了'
      const res = await route.lark.buzz(route.chatId, openId, text)
      if (!res.ok) throw new Error(`buzz 失败: ${res.reason}`)
      return { result: `已加急提醒：${text}` }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '加急提醒',
      kind: 'other',
      rawInput: args?.text,
    }),
  })

  process.stderr.write('[dsh-feishu] send_file / buzz_user registered\n')
}
