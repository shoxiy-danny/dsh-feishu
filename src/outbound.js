import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const MAX_BYTES = 25 * 1024 * 1024

export function attachOutbound(ctx, { routeOf }) {
  const tools = ctx.get('tools')
  if (!tools) {
    process.stderr.write('[dsh-feishu] tools missing; send_file not registered\n')
    return
  }

  tools.register({
    name: 'send_file',
    description:
      '发送本地文件/图片到当前飞书会话。图片按图片发；voice=true 且是音频时发成飞书语音。不要用来回普通文字。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '本地绝对路径' },
        voice: { type: 'boolean', description: '音频是否作为语音消息发送', default: false },
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

      const result = await route.lark.sendFile(route.chatId, filePath, { voice: Boolean(args.voice) })
      return { result }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '发送飞书文件',
      kind: 'other',
      rawInput: args?.file_path,
    }),
  })

  process.stderr.write('[dsh-feishu] send_file registered\n')
}
