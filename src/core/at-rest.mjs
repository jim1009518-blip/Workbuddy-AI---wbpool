/**
 * WorkBuddy 桌面端凭据解密（at-rest）
 *
 * WorkBuddy 从 5.6.0 起不再把 accessToken / refreshToken 存成明文，而是写成字段信封：
 *
 *   { "$wbEncrypted": 1, "envelope": "<base64 的 JSON>" }
 *
 * envelope = { suite, keyId, nonce, authTag, ciphertext }，算法是 AES-256-GCM
 * （12 字节 nonce、16 字节 tag）。AAD 是一段带长度前缀的转录，把 scheme /
 * suite / keyId / framing 都绑进去，所以密文只能用于它被封装时的那个字段形状。
 *
 * 字段密钥不是用户机密：它是编译进 App 自己的 Electron 原生模块
 * `electron_browser_workbuddy_storage` 的构建期常量。App 通过 `loggerGet()`
 * 取回它，并把返回的 base64 **字符串**（不是解码后的字节）做 SHA-256 得到 32
 * 字节密钥；keyId 是该密钥 SHA-256 的前 16 个 hex 字符。
 *
 * 本模块用同样的方式向已安装的 App 索要同一份载荷，因此不需要携带任何
 * 与构建版本绑定的常量。密钥只存在于内存，永不落盘、永不写日志。
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** AAD 转录的域分隔符，固定以 NUL 结尾。 */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
/** 对称信封的方案名。 */
const SYMMETRIC_SCHEME = 'sym-v1'
/** framing 名 → 单字节编码。字段级信封固定用 field。 */
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 }
/** framing 名 → 标准格式标识（参与 AAD 转录）。 */
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' }

/** 指向 WorkBuddy 桌面端可执行文件的环境变量覆盖。 */
export const APP_EXECUTABLE_ENV = 'WB_APP_EXECUTABLE'

/** 冷启动首次 spawn 可达数秒，给足 30s。 */
const KEY_FETCH_TIMEOUT_MS = 30_000

/** 桌面端可执行文件名，按探测顺序。WorkBuddyAI.exe 是国际版。 */
const APP_EXECUTABLE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe']

function u32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

/** 长度前缀 UTF-8 字符串：uint32 big-endian 长度 + 字节。 */
function lenPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([u32(bytes.length), bytes])
}

/**
 * 字段级 (field framing) 信封的 AAD。
 *
 * 只实现 field：这是桌面端用于凭据字段的形状，也不可能与整文件信封混淆，
 * 因此意外的 framing 会变成解析错误，而不是一段悄悄错掉的转录。
 */
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('信封 keyId 格式非法')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lenPrefixed(STANDARD_FORMAT_ID.field),
    lenPrefixed(SYMMETRIC_SCHEME),
    u32(suite),
    lenPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]), // 无序号
    Buffer.from([0]), // 无 final
  ])
}

/** 判断一个值是不是 App 的加密字段包装。 */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && value.$wbEncrypted === 1
    && typeof value.envelope === 'string'
}

/** 由 32 字节密钥推出 keyId：其 SHA-256 的前 16 hex。 */
export function deriveKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * 从 App 给出的载荷派生 32 字节字段密钥。
 *
 * App 哈希的是载荷里的 base64 **字符串**而非解码后的字节，所以这里必须用同样的
 * 拼写；哈希解码结果会得到另一把密钥，每个字段都会解不开。
 */
export function deriveKey(payloadJson) {
  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('at-rest 载荷不是合法 JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('at-rest 载荷不是对象')
  }
  const secret = payload.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('at-rest 载荷缺少 atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** 信封声明的 keyId（用于多版本共存时选对密钥）。 */
export function envelopeKeyId(field) {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
    return typeof record.keyId === 'string' ? record.keyId : undefined
  } catch {
    return undefined
  }
}

/**
 * 用派生密钥解开一个加密字段，返回明文。
 *
 * 信封畸形、属于别的密钥、或认证失败都会抛错：GCM tag 不匹配就是「转录或密钥
 * 错了」的信号，绝不能被降级成一段被截断的 token。
 */
export function openEncryptedField(field, key) {
  let envelope
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('加密字段信封不是合法 JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('加密字段信封不是对象')
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('加密字段信封缺少 suite 或 keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('加密字段信封缺少 nonce / authTag / ciphertext')
  }
  const expected = deriveKeyId(key)
  if (keyId !== expected) {
    throw new Error(`字段属于密钥 ${keyId}，当前密钥是 ${expected}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 读一个可能是明文字符串、也可能是加密信封的字段。 */
export function readField(value, key, label) {
  if (typeof value === 'string') return value
  if (isEncryptedFieldWrapper(value)) {
    if (key === undefined) throw new Error(`${label} 是加密字段，但取不到 at-rest 密钥`)
    return openEncryptedField(value, key)
  }
  return undefined
}

/**
 * 桌面端可执行文件的候选路径。
 *
 * 安装位置随机器而变（本机就装在 E: 盘的用户目录下），所以除了
 * LOCALAPPDATA / Program Files 等常规位置，还会扫每个盘符的常见安装根。
 */
export function appExecutableCandidates(env = process.env) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  const override = env[APP_EXECUTABLE_ENV]
  if (override) push(override)
  const home = homedir()
  const roots = [
    env.LOCALAPPDATA,
    env.APPDATA,
    join(home, 'AppData', 'Local'),
    join(home, 'AppData', 'Roaming'),
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter(Boolean)
  for (const root of roots) {
    for (const sub of [['Programs', 'WorkBuddy'], ['WorkBuddy'], ['Programs', 'WorkBuddyAI'], ['WorkBuddyAI'], ['workbuddy'], ['workbuddyai']]) {
      for (const exe of APP_EXECUTABLE_NAMES) push(join(root, ...sub, exe))
    }
  }
  // 逐个盘符的常见安装根（本机 E: 盘就命中这一条）
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    for (const sub of [['workbuddy'], ['workbuddyai'], ['Programs', 'WorkBuddy'], ['Users', env.USERNAME || '', 'AppData', 'Local', 'Programs', 'WorkBuddy']]) {
      for (const exe of APP_EXECUTABLE_NAMES) push(`${drive}:/${sub.join('/')}/${exe}`)
    }
  }
  return out.filter((p) => {
    try { return existsSync(p) } catch { return false }
  })
}

/**
 * 让已安装的桌面端以纯 Node 模式（ELECTRON_RUN_AS_NODE）跑一次，向它自己的
 * 原生绑定索要密钥载荷。
 *
 * 这个绑定是 App 对外的公开接口，所以我们不必携带任何与构建版本绑定的常量：
 * 直接问写这个文件的那个构建。子进程不给 stdin，有硬超时，只读 stdout。
 */
export function fetchKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`桌面端没有给出 at-rest 密钥（${String(stderr || '').trim() || error.message}）`))
          return
        }
        const payload = String(stdout).trim()
        if (payload === '') {
          reject(new Error('桌面端返回了空的 at-rest 密钥载荷'))
          return
        }
        resolve(payload)
      },
    )
  })
}

/** 已加载的密钥，按各自 keyId 索引。进程内缓存，永不落盘。 */
const keyById = new Map()
let inflight = undefined
let lastFailureAt = 0
const FAILURE_BACKOFF_MS = 60_000

/**
 * 加载本机每个桌面端构建的密钥。
 *
 * 逐个探测全部候选（不只第一个存在的），每个成功返回的构建都保留其密钥：
 * 某个构建失败（超时、单实例锁、旧版本没有该原生模块）只跳过它自己，不会毒化
 * 其它构建 —— 这正是「单候选」路径的老毛病：一次坏 spawn 会把 undefined 缓存
 * 整个进程，之后每个加密字段都报「找不到 App」。
 */
export function ensureKeys(env = process.env) {
  if (keyById.size > 0) return Promise.resolve()
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return Promise.resolve()
  inflight ??= (async () => {
    const candidates = appExecutableCandidates(env)
    if (candidates.length === 0) {
      lastFailureAt = Date.now()
      return
    }
    let anySuccess = false
    await Promise.all(candidates.map(async (executable) => {
      try {
        const payload = await fetchKeyPayload(executable)
        const key = deriveKey(payload)
        keyById.set(deriveKeyId(key), key)
        anySuccess = true
      } catch {
        // 一个构建失败不能掩盖其它构建
      }
    }))
    lastFailureAt = anySuccess ? 0 : Date.now()
  })().finally(() => { inflight = undefined })
  return inflight
}

/** 取指定 keyId 的密钥；没有则 undefined。 */
export async function keyForId(keyId) {
  await ensureKeys()
  return keyById.get(keyId)
}

/** 取任意一把可用密钥（单构建机器的便捷视图）。 */
export async function anyKey() {
  await ensureKeys()
  for (const key of keyById.values()) return key
  return undefined
}

/** 清空缓存（诊断用）。 */
export function clearKeyCache() {
  keyById.clear()
  inflight = undefined
  lastFailureAt = 0
}

/**
 * 从 .info 文件里读出 account（明文）与 auth 字段（可能加密）。
 * 返回 { auth: {accessToken, refreshToken, expiresAt, ...}, account }。
 */
export async function decodeAuthInfo(infoText) {
  let info
  try {
    info = JSON.parse(infoText)
  } catch {
    throw new Error('auth 文件不是合法 JSON')
  }
  const auth = info.auth ?? {}
  const account = info.account ?? {}
  // 昵称也是加密字段，一起算进「需不需要密钥」
  const needsKey = isEncryptedFieldWrapper(auth.accessToken)
    || isEncryptedFieldWrapper(auth.refreshToken)
    || isEncryptedFieldWrapper(account.nickname)
  let key
  if (needsKey) {
    const wantedId = envelopeKeyId(auth.accessToken) ?? envelopeKeyId(auth.refreshToken)
    key = wantedId ? await keyForId(wantedId) : await anyKey()
    if (key === undefined) {
      throw new Error('凭据是加密的，但取不到 at-rest 密钥：请确认 WorkBuddy 桌面端已安装并至少启动过一次')
    }
  }
  // 昵称解不开不算错，退化成空串（显示时再回退到 uin）
  let nickname = ''
  try {
    nickname = readField(account.nickname, key, 'nickname') ?? ''
  } catch { nickname = '' }

  return {
    nickname,
    accessToken: readField(auth.accessToken, key, 'accessToken') ?? '',
    refreshToken: readField(auth.refreshToken, key, 'refreshToken') ?? '',
    expiresAt: Number(auth.expiresAt) || 0,
    refreshExpiresAt: Number(auth.refreshExpiresAt) || 0,
    domain: typeof auth.domain === 'string' ? auth.domain : '',
    account: info.account ?? {},
    accounts: Array.isArray(info.accounts) ? info.accounts : [],
  }
}

export { readdirSync, readFileSync }
