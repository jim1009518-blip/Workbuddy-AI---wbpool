/**
 * CodeArts 通道：登录 + 华为云签名 + 对话。
 *
 * 协议来自上游渠道包（MIT，gitee.com/iJetLi/deepseek-harness-codearts）：
 *   1. 客户端生成 ticket_id 与 secret，拼一个华为云登录地址
 *   2. 用户在浏览器完成登录，华为云回调到给定的 auth_callback_url（带 secret）
 *   3. 服务端用 ticket_id + secret 轮询凭据端点，拿回 AK/SK/securityToken
 *   4. 之后每次调用都用 AK/SK 做 SDK-HMAC-SHA256 签名
 *
 * 和上游的区别：上游把回调地址写死成 http://127.0.0.1:port（因为它跑在本机插件里）。
 * 这里跑在云服务器上，所以回调地址由调用方传入（公网地址），登录才能真正走完。
 */

import { createHash, createHmac, randomUUID, randomBytes } from 'node:crypto'

const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'
const API_BASE = 'https://snap-access.cn-north-4.huaweicloud.com'
const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'

const sha256hex = (data) => createHash('sha256').update(data).digest('hex')
const hmacHex = (key, data) => createHmac('sha256', key).update(data).digest('hex')

/**
 * 生成一次登录。
 *
 * callbackUrl 必须是**公网可达**的地址（用户浏览器要跳得回来），
 * 例如 https://你的域名/wbpool/oauth/callback
 */
export function startLogin(callbackUrl) {
  const ticketId = randomUUID()
  const secret = randomBytes(32).toString('hex')
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains`
    + `&auth_callback_url=${encodeURIComponent(callbackUrl)}`
    + `&plugin-name=${PLUGIN_NAME}`
    + `&plugin-version=${PLUGIN_VERSION}`
    + `&ticket_id=${encodeURIComponent(ticketId)}`
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
  return { ticketId, secret, loginUrl, createdAt: Date.now() }
}

/** 解析凭据响应（上游两种形状都见过）。 */
function parseCredential(data) {
  if (!data || typeof data !== 'object') return null
  const c = data.credential
  if (c && typeof c === 'object') {
    const ak = c.access ?? ''
    const st = c.securitytoken ?? c.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: c.secret ?? '',
        security_token: st,
        expires_at: c.expires_at ?? c.expiresAt ?? '',
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  const r = data.result
  if (r && typeof r === 'object') {
    const ak = r.accessKeyId ?? ''
    const st = r.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: r.secretAccessKey ?? '',
        security_token: st,
        expires_at: r.expiration ?? r.expiresAt ?? '',
      }
    }
  }
  return null
}

/**
 * 轮询凭据。
 *
 * 登录完成后，凭据不是由回调直接给的，而是靠 ticket + secret 反查 ——
 * 所以即使用户的回调没走通（关掉了标签页），只要他确实登录了，这里也能捞到。
 */
export async function pollCredential(ticketId, secret, { attempts = 100, intervalMs = 1000, signal } = {}) {
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs))
    if (signal?.aborted) throw new Error('已取消')
    let res
    try {
      res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': PLUGIN_NAME,
          'plugin-version': PLUGIN_VERSION,
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      continue
    }
    if (!res.ok) continue
    let data
    try { data = await res.json() } catch { continue }
    const cred = parseCredential(data)
    if (cred) return cred
  }
  throw new Error('登录超时（没有等到凭据）')
}

/**
 * 华为云 SDK-HMAC-SHA256 签名。
 *
 * 这套签名对 URI / query / header 的规范化很挑剔：URI 必须以 / 结尾、
 * header 名要排序后参与签名、payload 用 SHA-256 摘要。
 */
export async function signRequest(credential, method, urlStr, body, extraHeaders) {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payload = typeof body === 'string' ? body : (body === undefined ? '' : JSON.stringify(body))
  const payloadHash = sha256hex(payload)

  const headers = new Map()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', credential.security_token)
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.set(k.toLowerCase(), v)
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const names = [...headers.keys()].sort()
  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    query,
    names.map((k) => `${k}:${headers.get(k)}`).join('\n'),
    '',
    names.join(';'),
    payloadHash,
  ].join('\n')

  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${sha256hex(canonicalRequest)}`
  const signature = hmacHex(credential.secret_access_key, stringToSign)
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${credential.access_key_id},SignedHeaders=${names.join(';')},Signature=${signature}`)
  return { headers: Object.fromEntries(headers), payload }
}

/** 内置模型目录。 */
export async function listModels(credential) {
  const url = `${API_BASE}/v1/model/builtin`
  const { headers } = await signRequest(credential, 'GET', url, '')
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`模型列表失败 HTTP ${res.status}`)
  const data = await res.json()
  const raw = data.models ?? data.data ?? data.result ?? []
  return (Array.isArray(raw) ? raw : []).map((m) => ({
    id: m.model_id ?? m.id ?? m.name,
    name: m.name ?? m.model_id ?? m.id,
  })).filter((m) => m.id)
}

/**
 * 发起对话。
 *
 * body 就是 OpenAI 形状，直接透传；部分「福利模型」需要额外带 maas_type: benefit，
 * 不带会被拒，所以这里在失败时自动补一次。
 */
export async function chat(credential, body) {
  const url = `${API_BASE}/api/v2/chat/completions`
  const payload = typeof body === 'string' ? body : JSON.stringify(body)

  const attempt = async (extra) => {
    const { headers, payload: p } = await signRequest(credential, 'POST', url, payload, extra)
    return fetch(url, { method: 'POST', headers, body: p, signal: AbortSignal.timeout(120000) })
  }

  let res = await attempt(undefined)
  if (!res.ok && (res.status === 400 || res.status === 403)) {
    // 福利模型可能需要 maas_type 头，补一次
    const retry = await attempt({ maas_type: 'benefit' })
    if (retry.ok) return retry
    res = retry
  }
  return res
}

/** 判断凭据是否还新鲜（华为云临时凭据有有效期）。 */
export function credentialAlive(credential, skewMs = 5 * 60_000) {
  if (!credential?.expires_at) return true
  const t = Date.parse(credential.expires_at)
  if (Number.isNaN(t)) return true
  return t - Date.now() > skewMs
}
