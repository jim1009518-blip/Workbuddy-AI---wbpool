/**
 * 渠道登录会话管理。
 *
 * CodeArts 的登录是本项目里唯一能在云端完整跑通的一条：
 * 生成登录链接 → 用户在浏览器登录 → 后台轮询凭据 → 落盘。
 *
 * 会话放在内存（一次登录几分钟就结束，不需要持久化），
 * 凭据落盘到 ~/.wbpool/channels.json，重启后仍在。
 */

import { PATHS, readJson, writeJson, log } from './config.mjs'
import * as codearts from './codearts.mjs'

const STORE = PATHS.channels

/** 进行中的登录：ticketId -> 会话 */
const sessions = new Map()
/** 凭据内存缓存 */
let cache

function loadStore() {
  if (cache) return cache
  cache = readJson(STORE, { version: 1, codearts: null })
  if (!cache.codearts) cache.codearts = null
  return cache
}

function saveStore() {
  writeJson(STORE, loadStore())
}

/** 已登录的 CodeArts 凭据（含过期判断）。 */
export function getCodearts() {
  const store = loadStore()
  if (!store.codearts) return null
  if (!codearts.credentialAlive(store.codearts)) return null
  return store.codearts
}

export function codeartsStatus() {
  const cred = getCodearts()
  const store = loadStore()
  return {
    loggedIn: cred !== null,
    expired: store.codearts !== null && cred === null,
    expiresAt: store.codearts?.expires_at ?? '',
    user: store.codearts?.user_name ?? '',
    userId: store.codearts?.user_id ?? '',
  }
}

/**
 * 发起一次登录。
 *
 * 注意：这里**立刻**开始后台轮询，而不是等回调到了才轮询。
 * 因为用户可能关掉标签页、或者回调地址在网关后面被改写，
 * 只要他真的在华为云登录了，ticket 那条路就能把凭据捞回来。
 */
export function startCodeartsLogin(publicBase, { taskId } = {}) {
  const callbackUrl = `${publicBase}/oauth/callback`
  const session = codearts.startLogin(callbackUrl)
  const record = {
    ...session,
    id: session.ticketId,
    status: 'pending',
    error: '',
    createdAt: Date.now(),
    callbackUrl,
  }
  sessions.set(session.ticketId, record)

  // 后台轮询，不阻塞 HTTP 响应
  ;(async () => {
    try {
      const credential = await codearts.pollCredential(session.ticketId, session.secret, { attempts: 150 })
      record.status = 'ok'
      record.credential = credential
      const store = loadStore()
      store.codearts = { ...credential, loggedAt: Date.now() }
      saveStore()
      log(`CodeArts 登录成功${credential.user_name ? `：${credential.user_name}` : ''}`)
      // 顺手拉一次模型，确认凭据真能用
      try {
        const models = await codearts.listModels(credential)
        record.models = models.length
      } catch { /* 模型列表失败不影响登录结果 */ }
    } catch (error) {
      record.status = 'error'
      record.error = String(error.message || error)
      log('CodeArts 登录失败', record.error)
    }
  })().catch(() => {})

  return {
    ok: true,
    id: record.id,
    loginUrl: record.loginUrl,
    callbackUrl,
    expiresInSec: 150,
  }
}

/** 查一次登录会话。 */
export function codeartsLoginStatus(id) {
  const record = sessions.get(id)
  if (!record) {
    // 会话可能因为重启丢了，但凭据可能已经存下来了
    const st = codeartsStatus()
    if (st.loggedIn) return { ok: true, status: 'ok', restored: true, ...st }
    return { ok: false, status: 'unknown', error: '会话不存在或已过期' }
  }
  return {
    ok: true,
    status: record.status,
    error: record.error,
    loginUrl: record.loginUrl,
    models: record.models ?? 0,
    user: record.credential?.user_name ?? '',
  }
}

/** 接收本机登录推上来的凭据。 */
export function importCodearts(credential) {
  const store = loadStore()
  store.codearts = { ...credential, loggedAt: Date.now(), source: 'local-login' }
  saveStore()
  log(`CodeArts 凭据已导入${credential.user_name ? `：${credential.user_name}` : ''}`)
  return codeartsStatus()
}

/** 退出 CodeArts。 */
export function logoutCodearts() {
  const store = loadStore()
  store.codearts = null
  saveStore()
  sessions.clear()
  return true
}

/** 其它渠道的登录能力说明（哪些能在云端完成）。 */
export const CHANNEL_CAPABILITY = {
  // 实测结论：即使在本机起 127.0.0.1 回调、并完整走完华为云登录，
  // 「登录中…」页面也不会跳转过来（3 分钟内零请求），ticket 始终被判无效。
  // 该页面强依赖 JetBrains IDE 插件环境，纯浏览器/服务端无法完成。
  codearts: {
    cloudLogin: false,
    localTool: true,
    reason: '页面强依赖本机 IDE 插件，浏览器登录不会回调；已备本机登录器 tools/codearts-login.mjs',
  },
  buddy: { cloudLogin: false, reason: '腾讯 SSO + 设备绑定，只能导入凭据' },
  workbuddy: { cloudLogin: false, reason: '腾讯 SSO + 设备绑定，只能导入凭据' },
  lobsterai: { cloudLogin: false, reason: '登录态绑定浏览器会话，需本机导出' },
  qoder: { cloudLogin: false, reason: 'PKCE + 自定义 uri_scheme，只能本机完成' },
  qodercn: { cloudLogin: false, reason: 'PKCE + 自定义 uri_scheme，只能本机完成' },
  trae: { cloudLogin: false, reason: '需本机客户端签名' },
  cline: { cloudLogin: false, reason: 'GitHub OAuth 回调固定为扩展地址' },
  loomy: { cloudLogin: false, reason: '需本机客户端' },
  raccoon: { cloudLogin: false, reason: '需本机客户端' },
  minimax: { cloudLogin: false, reason: '需本机客户端' },
  zcode: { cloudLogin: false, reason: '需本机客户端' },
  gemini: { cloudLogin: false, reason: 'Google OAuth 客户端受限' },
}
