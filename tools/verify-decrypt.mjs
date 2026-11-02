// 验证 WorkBuddy 凭据信封解密链路是否可行
import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'

const EXE = 'E:/Users/Administrator/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe'
const AUTH = 'C:/Users/Administrator/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'

function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b }
function lp(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]) }
function fieldAad(keyId, suite) {
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    u32(suite),
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

const getPayload = () => new Promise((res, rej) => {
  execFile(EXE, ['-e',
    "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}" +
    "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 },
    (err, stdout, stderr) => err ? rej(new Error(stderr || err.message)) : res(stdout.trim()))
})

const payload = await getPayload()
const secret = JSON.parse(payload).atRestSecretKey
// 注意：对 base64 字符串本身做 SHA-256，不是解码后的字节
const key = createHash('sha256').update(secret, 'utf8').digest()
const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
console.log('derived keyId =', keyId)

const info = JSON.parse(readFileSync(AUTH, 'utf8'))
const env = JSON.parse(Buffer.from(info.auth.accessToken.envelope, 'base64').toString('utf8'))
console.log('envelope keyId =', env.keyId, 'suite =', env.suite, 'match =', env.keyId === keyId)

const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 })
d.setAAD(fieldAad(env.keyId, env.suite))
d.setAuthTag(Buffer.from(env.authTag, 'base64'))
const token = Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8')
console.log('accessToken 解密成功, 长度 =', token.length, '前缀 =', token.slice(0, 8) + '***')

// 顺带解 nickname / refreshToken
for (const field of ['refreshToken']) {
  const e2 = JSON.parse(Buffer.from(info.auth[field].envelope, 'base64').toString('utf8'))
  const d2 = createDecipheriv('aes-256-gcm', key, Buffer.from(e2.nonce, 'base64'), { authTagLength: 16 })
  d2.setAAD(fieldAad(e2.keyId, e2.suite))
  d2.setAuthTag(Buffer.from(e2.authTag, 'base64'))
  const v = Buffer.concat([d2.update(Buffer.from(e2.ciphertext, 'base64')), d2.final()]).toString('utf8')
  console.log(field, '解密成功, 长度 =', v.length)
}
console.log('domain =', info.auth.domain, '| uid =', info.account.uid, '| 账号数 =', (info.accounts || []).length)
