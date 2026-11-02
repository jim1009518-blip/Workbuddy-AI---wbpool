// 验证对话链路：模型目录结构 + 真实流式补全
import { createDecipheriv, createHash, randomUUID, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const EXE = 'E:/Users/Administrator/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe'
const AUTH = 'C:/Users/Administrator/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'

const u32 = n => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b }
const lp = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]) }
const fieldAad = (keyId, suite) => Buffer.concat([
  Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'),
  u32(suite), lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
])
const getPayload = () => new Promise((res, rej) => execFile(EXE, ['-e',
  "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 },
  (e, o, s) => e ? rej(new Error(s || e.message)) : res(o.trim())))
function openField(field, key) {
  const env = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 })
  d.setAAD(fieldAad(env.keyId, env.suite))
  d.setAuthTag(Buffer.from(env.authTag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8')
}
const secret = JSON.parse(await getPayload()).atRestSecretKey
const key = createHash('sha256').update(secret, 'utf8').digest()
const info = JSON.parse(readFileSync(AUTH, 'utf8'))
const token = openField(info.auth.accessToken, key)
const uid = info.account.uid, domain = info.auth.domain

const BASE = 'https://copilot.tencent.com'
const base = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
  'Origin': 'https://www.codebuddy.cn',
  'Referer': 'https://www.codebuddy.cn/',
  'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
  'X-User-Id': uid, 'X-Domain': domain, 'X-Product': 'SaaS',
}

// 1) 目录
const r = await fetch(`${BASE}/v2/enterprises/personal/models`, { headers: base, signal: AbortSignal.timeout(30000) })
const j = await r.json()
console.log('目录 code =', j.code, '| data keys =', Object.keys(j.data || {}).slice(0, 8))
const arr = j.data?.models || j.data?.Models || j.data?.list || j.data?.List || []
console.log('模型 raw 数量 =', Array.isArray(arr) ? arr.length : 'n/a')
if (Array.isArray(arr) && arr[0]) console.log('样本:', JSON.stringify(arr[0]).slice(0, 400))

const modelId = (arr[0] && (arr[0].id || arr[0].model || arr[0].ModelId)) || 'hy3'
console.log('\n使用模型 =', modelId)

// 2) 对话
const hash = s => createHash('sha256').update(`conversation:${s}:chat-probe`).digest('hex')
const uuid = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
const cid = uuid(hash('id')), rid = uuid(hash('req')), acp = uuid(hash('acp'))

const body = {
  model: modelId,
  stream: true,
  messages: [{ role: 'user', content: '只回复两个字：你好' }],
  stream_options: { include_usage: true },
}
const cr = await fetch(`${BASE}/v2/chat/completions`, {
  method: 'POST',
  headers: {
    ...base,
    'X-IDE-Name': 'WorkBuddy', 'X-IDE-Type': 'WorkBuddy', 'X-IDE-Version': '5.5.6',
    'X-Conversation-ID': cid, 'X-Conversation-Request-ID': rid, 'acp-connection-id': acp,
    'X-Conversation-Message-ID': randomUUID(), 'X-Request-ID': randomUUID(),
    'X-Agent-Intent': 'craft', 'X-Agent-Purpose': 'conversation',
    'X-Private-Data': 'true', 'x-codebuddy-request': '1',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(90000),
})
console.log('\n对话 HTTP =', cr.status, cr.headers.get('content-type'))
if (!cr.ok) { console.log('错误体:', (await cr.text()).slice(0, 600)); process.exit(0) }

let text = '', frames = 0
const reader = cr.body.getReader()
const dec = new TextDecoder()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = dec.decode(value, { stream: true })
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    frames++
    try {
      const f = JSON.parse(payload)
      const d = f.choices?.[0]?.delta
      if (d?.content) text += d.content
      if (f.usage) console.log('usage =', JSON.stringify(f.usage))
    } catch { /* 非 JSON 帧 */ }
  }
}
console.log('SSE 帧数 =', frames)
console.log('回复内容 =', JSON.stringify(text.slice(0, 200)))
