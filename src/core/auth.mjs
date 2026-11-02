/**
 * 访问鉴权：只认一个密码。
 *
 * 不用 HTTP Basic，因为 Basic 的浏览器弹窗硬性要求填用户名。这里改成自己的登录页：
 * 输入密码 → 种一个 HMAC 签名的 cookie → 之后免输。
 *
 * 同时保留两种机器调用方式，方便脚本和 WorkBuddy：
 *   Authorization: Bearer <password | gatewayKey>
 *   Authorization: Basic <任意用户名:password>（用户名不校验）
 *
 * cookie 只签名不加密：里面除了过期时间什么都没有，改不动也算不出签名。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'wbpool_session'
/** 登录有效期：30 天。 */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export { COOKIE_NAME }

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex')
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** 解析 Cookie 头。 */
export function parseCookies(req) {
  const out = {}
  const raw = req.headers?.cookie
  if (typeof raw !== 'string' || raw === '') return out
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

/** 生成一个带过期时间的会话值。 */
export function createSession(secret, now = Date.now()) {
  const exp = String(now + SESSION_TTL_MS)
  return `${exp}.${sign(secret, exp)}`
}

/** 校验会话值。 */
export function verifySession(secret, value, now = Date.now()) {
  if (typeof value !== 'string') return false
  const idx = value.indexOf('.')
  if (idx <= 0) return false
  const exp = value.slice(0, idx)
  const sig = value.slice(idx + 1)
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false
  if (!safeEqual(sig, sign(secret, exp))) return false
  return Number(exp) > now
}

/** 这个请求是否已经通过鉴权。 */
export function isAuthorized(req, config) {
  const auth = config.auth ?? {}
  const password = auth.password || auth.adminPassword || ''
  // 没设密码 = 本机调试模式，不校验
  if (password === '') return true

  const sessionSecret = auth.sessionSecret || auth.syncSecret || 'wbpool'
  const cookies = parseCookies(req)
  if (verifySession(sessionSecret, cookies[COOKIE_NAME])) return true

  const header = String(req.headers.authorization ?? '')
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim()
    return safeEqual(token, password) || (config.gatewayKey ? safeEqual(token, config.gatewayKey) : false)
  }
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const idx = decoded.indexOf(':')
    // 用户名不校验，只认密码 —— 兼容各种只填密码的客户端
    const given = idx >= 0 ? decoded.slice(idx + 1) : decoded
    return safeEqual(given, password)
  }
  return false
}

/** 校验用户提交的密码。 */
export function checkPassword(config, input) {
  const auth = config.auth ?? {}
  const password = auth.password || auth.adminPassword || ''
  if (password === '') return true
  return safeEqual(String(input ?? ''), password)
}

/** 组 Set-Cookie。 */
export function sessionCookie(config, req, { clear = false } = {}) {
  const auth = config.auth ?? {}
  const secret = auth.sessionSecret || auth.syncSecret || 'wbpool'
  const secure = config.remoteMode || String(req.headers['x-forwarded-proto'] ?? '') === 'https'
  const parts = [
    `${COOKIE_NAME}=${clear ? '' : createSession(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
