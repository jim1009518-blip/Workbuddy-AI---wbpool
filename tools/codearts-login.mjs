/**
 * CodeArts 本机登录器。
 *
 * 为什么必须在本机跑：华为云的「登录中」页面是给本机 JetBrains 插件用的，
 * 回调地址必须是 127.0.0.1 上真实监听的端口。云端做不到这一点——
 * 实测窗口内随便造的 ticket 会被判「无效ticketId」，secret 也只能从回调里拿。
 *
 * 所以流程是：本机起回调 → 你在浏览器登录 → 拿到 AK/SK → 推到云端。
 *
 * 用法：node tools/codearts-login.mjs
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as codearts from '../src/core/codearts.mjs'

const remote = JSON.parse(readFileSync('data/remote.json', 'utf8'))

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', `"${url}"`] : [url]
  try {
    const child = execFile(cmd, args, { windowsHide: true })
    child.on('error', () => {})
  } catch { /* 打不开就手点 */ }
}

function pickToken(params) {
  return params.get('token') ?? params.get('access_token') ?? params.get('accessToken') ?? params.get('authCode') ?? ''
}

const ticketId = randomUUID()

const result = new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith('/authentication')) {
      res.writeHead(404).end('not found')
      return
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    const params = url.searchParams

    const done = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>CodeArts 登录</title>
<style>body{background:#0b0f14;color:#e6edf3;font-family:system-ui,"Microsoft YaHei",sans-serif;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center;font-size:15px;line-height:1.8}</style></head><body><div class="c">${html}</div></body></html>`)
    }

    // 1) 直接给 token
    const direct = pickToken(params)
    if (direct) {
      done('✅ 已收到令牌，可以关闭此页回到终端')
      resolve({ kind: 'token', token: direct })
      return
    }
    // 2) fingerprint 里包着 token
    const fp = params.get('fingerprint')
    if (fp) {
      try {
        const inner = new URL(Buffer.from(fp, 'base64').toString())
        const t = pickToken(inner.searchParams)
        if (t) {
          done('✅ 已收到令牌，可以关闭此页回到终端')
          resolve({ kind: 'token', token: t })
          return
        }
      } catch { /* 继续 */ }
    }
    // 3) 正常路径：回调带 secret，用它去换 AK/SK
    const secret = params.get('secret')
    if (secret) {
      done('✅ 登录已完成，正在换取凭据…<br><span style="color:#8b98a5;font-size:13px">请回到终端查看结果</span>')
      resolve({ kind: 'secret', secret })
      return
    }
    done('⚠️ 回调里没有 token 也没有 secret<br><span style="color:#8b98a5;font-size:13px">请回到终端按提示操作</span>')
    reject(new Error('回调缺少参数'))
  })

  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    // 上游的拼法：callback 指向本地端口
    const callbackUrl = `http://127.0.0.1:${port}/authentication`
    const redirectUrl = `https://devcloud.cn-north-4.huaweicloud.com/doer/redirect`
      + `?IdeaType=jetbrains`
      + `&auth_callback_url=${encodeURIComponent(callbackUrl)}`
      + `&plugin-name=snap_jetbrains`
      + `&plugin-version=26.3.3`
      + `&ticket_id=${encodeURIComponent(ticketId)}`
    const loginUrl = `https://auth.huaweicloud.com/authui/login.html?service=${encodeURIComponent(redirectUrl)}`

    console.log('')
    console.log('  CodeArts 登录')
    console.log('  ' + '─'.repeat(46))
    console.log(`  本地回调：${callbackUrl}`)
    console.log(`  ticket  ：${ticketId.slice(0, 8)}…`)
    console.log('')
    console.log('  已尝试打开浏览器。如果没有自动打开，请手动访问：')
    console.log('  ' + loginUrl)
    console.log('')
    console.log('  登录完成后这个窗口会自动继续，最多等 3 分钟…')
    console.log('')
    openBrowser(loginUrl)

    // 超时保护
    setTimeout(() => reject(new Error('等待回调超时（3 分钟）')), 180_000)
  })
})

let outcome
try {
  outcome = await result
} catch (error) {
  console.error('\n  ✗ ' + String(error.message || error))
  process.exit(1)
}

// 拿到凭据
let credential
if (outcome.kind === 'secret') {
  process.stdout.write('  正在用 ticket + secret 换凭据 … ')
  try {
    credential = await codearts.pollCredential(ticketId, outcome.secret, { attempts: 60 })
    console.log('ok')
  } catch (error) {
    console.log('失败：' + String(error.message || error))
    process.exit(1)
  }
} else {
  console.log('\n  收到了裸 token，但 CodeArts 需要 AK/SK 才能签名调用。')
  console.log('  请改用正常流程（浏览器里完成一次完整登录）。')
  process.exit(1)
}

console.log(`  凭据：AK ${String(credential.access_key_id).slice(0, 8)}…  用户 ${credential.user_name || '-'}`)
console.log(`  到期：${credential.expires_at || '-'}`)

// 推云端
process.stdout.write('  推送到云端 … ')
try {
  const res = await fetch(`${remote.baseUrl}/api/channels/codearts/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': remote.syncSecret },
    body: JSON.stringify({ credential }),
    signal: AbortSignal.timeout(30000),
  })
  const d = await res.json()
  if (res.ok && d.ok) {
    console.log('ok')
    console.log('\n  ✅ 完成。云端已可用：model = "codearts/<模型名>"')
    console.log(`  控制台：${remote.baseUrl}/`)
  } else {
    console.log('失败：' + (d.error || res.status))
  }
} catch (error) {
  console.log('失败：' + String(error.message || error))
}
process.exit(0)
