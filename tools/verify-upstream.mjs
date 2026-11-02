// 真实上游验证：积分查询 / 签到状态 / 模型目录
import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const EXE = process.env.WB_EXE || 'E:/Users/Administrator/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe'
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
const accessToken = openField(info.auth.accessToken, key)
const uid = info.account.uid
const domain = info.auth.domain

const BILLING = 'https://www.codebuddy.cn'
const h = {
  'Authorization': `Bearer ${accessToken}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'X-User-Id': uid,
  'X-Domain': domain,
  'User-Agent': 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
}
const post = async (path, body) => {
  const r = await fetch(BILLING + path, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  const t = await r.text()
  let j; try { j = JSON.parse(t) } catch { j = { raw: t.slice(0, 200) } }
  return { status: r.status, ...j }
}

console.log('=== 签到状态 ===')
console.log(JSON.stringify(await post('/v2/billing/meter/checkin-activity-status', {}), null, 1).slice(0, 700))

console.log('\n=== 积分包 ===')
const now = new Date()
const p = n => String(n).padStart(2, '0')
const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
const cr = await post('/v2/billing/meter/get-user-resource', {
  PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
  PackageEndTimeRangeBegin: fmt(now), PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 86400000)),
})
const accs = cr?.data?.Response?.Data?.Accounts
console.log('code =', cr.code, 'msg =', cr.msg, '| 积分包数 =', Array.isArray(accs) ? accs.length : 'n/a')
if (Array.isArray(accs)) {
  for (const a of accs.slice(0, 6)) {
    console.log(`  ${a.PackageName} | 剩余 ${a.CapacityRemain}/${a.CapacitySize} | 周期剩余 ${a.CycleCapacityRemain}/${a.CycleCapacitySize} | 类型 ${a.CapacityType}`)
  }
}

console.log('\n=== 模型目录 ===')
const mr = await fetch('https://copilot.tencent.com/v2/enterprises/personal/models', {
  headers: { ...h, 'X-Requested-With': 'XMLHttpRequest', 'Origin': BILLING, 'Referer': BILLING + '/' },
  signal: AbortSignal.timeout(30000),
})
const mt = await mr.text()
let mj; try { mj = JSON.parse(mt) } catch { mj = null }
console.log('status =', mr.status, '| code =', mj?.code, '| 模型数 =', mj?.data?.models?.length ?? mj?.data?.Models?.length ?? 'n/a')
const models = mj?.data?.models || mj?.data?.Models || []
for (const m of models.slice(0, 12)) console.log('  ', m.id || m.model, '| credits', m.credits, '|', (m.name || '').slice(0, 24))
