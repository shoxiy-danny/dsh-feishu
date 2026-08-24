import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { CLI_APP_ID, makeInbound } from './cli-lark.js'

const DEFAULT_SOCK = '/tmp/dsh-feishu-cli.sock'
const DEFAULT_CHAT = 'local'

export function attachCliServer({ socketPath = DEFAULT_SOCK, lark, bridge, onInbound, waitIdle }) {
  let server
  try { unlinkSync(socketPath) } catch { /* ok */ }

  server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        void handleLine(sock, line)
      }
    })
  })

  server.on('error', (err) => {
    process.stderr.write(`[dsh-feishu] cli socket: ${err}\n`)
  })

  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600) } catch { /* ignore */ }
    process.stderr.write(`[dsh-feishu] cli bot ${CLI_APP_ID} socket=${socketPath}\n`)
  })

  async function handleLine(sock, line) {
    let req
    try { req = JSON.parse(line) } catch {
      reply(sock, { ok: false, error: 'bad json' })
      return
    }
    const id = req.id
    const cmd = String(req.cmd || 'send')
    const chatId = String(req.chatId || DEFAULT_CHAT)
    try {
      if (cmd === 'ping') {
        reply(sock, { id, ok: true, pong: true })
        return
      }
      if (cmd === 'drain') {
        reply(sock, { id, ok: true, events: lark.drain(chatId) })
        return
      }
      if (cmd !== 'send') {
        reply(sock, { id, ok: false, error: `unknown cmd ${cmd}` })
        return
      }

      const text = String(req.text ?? '')
      // 定向投递：req.appId 指定真实 bot 时走 bridge.deliver，回复从该 bot 发进对应飞书会话
      if (req.appId && req.appId !== CLI_APP_ID) {
        if (!bridge) {
          reply(sock, { id, ok: false, error: 'bridge unavailable' })
          return
        }
        await bridge.deliver(String(req.appId), chatId, text, undefined, req.model)
        if (req.wait !== false && typeof waitIdle === 'function') {
          try { await waitIdle(String(req.appId), chatId) } catch { /* no session yet */ }
        }
        reply(sock, { id, ok: true, inboundId: `deliver-${chatId}` })
        return
      }
      const inbound = makeInbound({ chatId, text, resources: req.resources })
      await onInbound(inbound)
      if (req.wait !== false && typeof waitIdle === 'function') {
        try { await waitIdle(CLI_APP_ID, chatId) } catch { /* no session yet */ }
      }
      reply(sock, { id, ok: true, inboundId: inbound.messageId, events: lark.drain(chatId) })
    } catch (err) {
      reply(sock, { id, ok: false, error: String(err?.message || err), events: lark.drain(chatId) })
    }
  }

  function reply(sock, obj) {
    try { sock.write(JSON.stringify(obj) + '\n') } catch { /* closed */ }
  }

  return {
    stop() {
      try { server?.close() } catch { /* ignore */ }
      try { unlinkSync(socketPath) } catch { /* ignore */ }
    },
    ready: new Promise((resolve) => {
      if (server.listening) resolve()
      else server.once('listening', resolve)
    }),
  }
}
