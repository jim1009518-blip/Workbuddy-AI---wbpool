/**
 * WorkBuddy 账号池。
 *
 * 桌面端同一时间只保留「当前登录账号」的凭据（每次换号都会覆盖同一个文件），
 * 所以池子必须自己把账号记下来：每次扫描都把读到的账号并入 accounts.json，
 * 换号之后的旧账号仍然留在池里，重启也不丢。
 *
 * 扫描来源：
 *   1. WorkBuddy 桌面端的 auth 目录（当前登录账号）
 *   2. accounts.json 里已经收进来的历史账号
 *
 * 池子负责：凭据解密、按域名分国内外、429/积分耗尽/凭据失效三种冷却、
 * 分配策略（priority / round-robin / balanced / sticky / expiry）、token 续期。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { decodeAuthInfo, ensureKeys } from './at-rest.mjs'
import { PATHS, readJson, writeJson, log } from './config.mjs'

/** 国际版登录域名（其余一律按国内版处理）。 */
const GLOBAL_HOSTS = ['workbuddy.ai', 'workbuddy.cc', 'codebuddy.ai']

export function regionOf(domain) {
  const d = String(domain || '').trim().toLowerCase()
  for (const host of GLOBAL_HOSTS) {
    if (d === host || d.endsWith(`.${host}`)) return 'global'
  }
  return 'cn'
}

/** 登录域名 → 对话网关。国际版按品牌域名分开，令牌不可互换。 */
export function chatBaseOf(account) {
  if (regionOf(account.domain) !== 'global') return 'https://copilot.tencent.com'
  const d = String(account.domain || '').toLowerCase()
  if (d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return 'https://www.workbuddy.ai'
}

/** 登录域名 → 计费/控制台网关。 */
export function billingBaseOf(account) {
  if (regionOf(account.domain) !== 'global') return 'https://www.codebuddy.cn'
  return chatBaseOf(account)
}

/**
 * 桌面端 auth 目录候选。
 *
 * 换号时桌面端覆盖的是同一个文件，所以「目录里有什么」等于「当前登录是谁」；
 * 历史账号靠 accounts.json 兜住。
 */
export function authDirs(env = process.env) {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  // 显式指定目录时只用它：测试要隔离，用户也可能把桌面端装在非标准位置
  if (env.WB_AUTH_DIR) return [env.WB_AUTH_DIR]
  const roots = [env.LOCALAPPDATA, env.APPDATA, join(env.USERPROFILE || '', 'AppData', 'Local')].filter(Boolean)
  for (const root of roots) {
    push(join(root, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
    push(join(root, 'CodeBuddyExtension', 'Data', 'auth'))
  }
  return out
}

/** 稳定账号 id：uid 优先，否则用 uin，再否则用令牌指纹。 */
function accountIdOf(cred) {
  const uid = String(cred.account?.uid || '').trim()
  if (uid) return uid
  const uin = String(cred.account?.uin || '').trim()
  if (uin) return `uin-${uin}`
  return `tok-${createHash('sha256').update(cred.accessToken).digest('hex').slice(0, 16)}`
}

/**
 * 显示名优先级：真昵称 > uin > uid 前 8 位。
 * 昵称是加密字段，解不开时不能报错，只能退化。
 */
function labelOf(cred) {
  const nick = String(cred.nickname || '').trim()
  if (nick) return nick
  const uin = String(cred.account?.uin || '')
  if (uin) return `账号 ${uin}`
  const uid = String(cred.account?.uid || '').slice(0, 8)
  return `账号 ${uid || 'unknown'}`
}

const DAY = 24 * 3600 * 1000

export class AccountPool {
  constructor(config, options = {}) {
    this.config = config
    /**
     * 账号快照的落盘位置。
     *
     * 默认写 ~/.wbpool/accounts.json。测试必须传临时路径 —— 否则跑一次自测就会
     * 把仿真的假账号写进用户真实池子里（这个坑第一版就踩了）。
     */
    this.storePath = options.storePath ?? PATHS.accounts
    /** @type {Map<string, any>} */
    this.byId = new Map()
    /** sticky：对话键 → 账号 id */
    this.stickyBindings = new Map()
    /** round-robin 游标 */
    this.rrCursor = 0
    this.lastScan = 0
    this.lastScanErrors = []
    this.load()
  }

  load() {
    const stored = readJson(this.storePath, { accounts: [] })
    for (const acc of stored.accounts ?? []) {
      if (acc && acc.id) this.byId.set(acc.id, acc)
    }
  }

  persist() {
    writeJson(this.storePath, {
      version: 1,
      updatedAt: Date.now(),
      accounts: [...this.byId.values()],
    })
  }

  /**
   * 扫桌面端 auth 目录，把读到的账号并入池。
   *
   * 每次调用都会重新读文件：桌面端刷新 token 后写回的是明文（或新信封），
   * 池子要跟上，否则会拿过期令牌去请求。
   */
  async scan() {
    await ensureKeys()
    this.lastScanErrors = []
    const found = []
    for (const dir of authDirs()) {
      if (!existsSync(dir)) continue
      let files = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.info'))
      } catch (error) {
        this.lastScanErrors.push(`${dir}: ${String(error.message || error)}`)
        continue
      }
      for (const file of files) {
        const path = join(dir, file)
        try {
          const cred = await decodeAuthInfo(readFileSync(path, 'utf8'))
          if (!cred.accessToken) {
            this.lastScanErrors.push(`${file}: 没有 accessToken`)
            continue
          }
          found.push({ cred, path, file, mtime: statSync(path).mtimeMs })
        } catch (error) {
          this.lastScanErrors.push(`${file}: ${String(error.message || error)}`)
        }
      }
    }

    let added = 0
    for (const { cred, path, file, mtime } of found) {
      const id = accountIdOf(cred)
      const prev = this.byId.get(id)
      const now = Date.now()
      const account = {
        id,
        // 昵称变了（重新登录换了昵称）也要跟着更新，所以不是 prev?.label 优先
        label: labelOf(cred),
        uid: String(cred.account?.uid || ''),
        uin: String(cred.account?.uin || ''),
        domain: cred.domain,
        region: regionOf(cred.domain),
        accessToken: cred.accessToken,
        refreshToken: cred.refreshToken || prev?.refreshToken || '',
        expiresAt: cred.expiresAt || prev?.expiresAt || 0,
        refreshExpiresAt: cred.refreshExpiresAt || prev?.refreshExpiresAt || 0,
        sourceFile: path,
        sourceMtime: mtime,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastUsedAt: prev?.lastUsedAt ?? 0,
        // 冷却与统计跨扫描保留
        cooldownUntil: prev?.cooldownUntil ?? 0,
        cooldownReason: prev?.cooldownReason ?? '',
        credits: prev?.credits ?? null,
        checkin: prev?.checkin ?? null,
        probeError: '',
        requestCount: prev?.requestCount ?? 0,
        failureCount: prev?.failureCount ?? 0,
        inputTokens: prev?.inputTokens ?? 0,
        outputTokens: prev?.outputTokens ?? 0,
        creditSpent: prev?.creditSpent ?? 0,
      }
      if (!prev) added++
      this.byId.set(id, account)
    }
    this.lastScan = Date.now()
    if (added > 0 || found.length > 0) this.persist()
    return { found: found.length, added, total: this.byId.size, errors: this.lastScanErrors }
  }

  /**
   * 合并外部推送进来的账号（云端模式）。
   *
   * 云端没有 WorkBuddy 桌面端，解不开凭据，所以账号一律由本机解密后推上来。
   * 这里只做合并：同 id 覆盖令牌与有效期、保留统计与冷却；令牌变了说明重新
   * 登录过，顺手把「凭据失效」的冷却清掉，让它立刻可用。
   */
  syncAccounts(list) {
    const now = Date.now()
    let added = 0
    let updated = 0
    let expired = 0
    for (const raw of list ?? []) {
      if (!raw || typeof raw !== 'object') continue
      const id = String(raw.id || raw.uid || '').trim()
      if (!id || typeof raw.accessToken !== 'string' || raw.accessToken === '') continue
      const prev = this.byId.get(id)
      const tokenChanged = prev !== undefined && prev.accessToken !== raw.accessToken
      const domain = raw.domain || prev?.domain || 'www.workbuddy.cn'
      const account = {
        id,
        label: raw.label || prev?.label || `账号 ${id.slice(0, 8)}`,
        uid: String(raw.uid || id),
        uin: String(raw.uin || prev?.uin || ''),
        domain,
        region: regionOf(domain),
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken || prev?.refreshToken || '',
        expiresAt: Number(raw.expiresAt) || 0,
        refreshExpiresAt: Number(raw.refreshExpiresAt) || 0,
        sourceFile: '',
        sourceMtime: now,
        syncedAt: now,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastUsedAt: prev?.lastUsedAt ?? 0,
        cooldownUntil: tokenChanged ? 0 : (prev?.cooldownUntil ?? 0),
        cooldownReason: tokenChanged ? '' : (prev?.cooldownReason ?? ''),
        credits: raw.credits ?? prev?.credits ?? null,
        checkin: prev?.checkin ?? null,
        probeError: '',
        requestCount: prev?.requestCount ?? 0,
        failureCount: prev?.failureCount ?? 0,
        inputTokens: prev?.inputTokens ?? 0,
        outputTokens: prev?.outputTokens ?? 0,
        creditSpent: prev?.creditSpent ?? 0,
      }
      if (account.expiresAt && account.expiresAt <= now) expired++
      if (prev) updated++
      else added++
      this.byId.set(id, account)
    }
    this.lastScan = now
    if ((list ?? []).length > 0) this.persist()
    return { added, updated, expired, total: this.byId.size }
  }

  /** 从池里删掉一个账号（手动清理用）。 */
  removeAccount(id) {
    const existed = this.byId.delete(id)
    if (existed) this.persist()
    return existed
  }

  accounts() {
    return [...this.byId.values()]
  }

  get(id) {
    return this.byId.get(id)
  }

  /** 每号留底的积分阈值（0 = 不保留，烧完才换号）。 */
  creditsReserve() {
    return reserveOf(this.config)
  }

  /**
   * 这个号是不是已经落进「留底区」，该让位给下一个号了。
   *
   * 积分未知（null 或没有 total）时返回 false：新号还没探测过余额，先让它试；
   * 真耗尽会被上游判 exhaust 进冷却，顺带把余额记成 0，之后就自动让位了。
   */
  belowReserve(account) {
    return belowReserveOf(account, this.config)
  }

  /** 一个账号能不能用：没在冷却、令牌没过期、积分没跌破留底线。 */
  isUsable(account, now = Date.now()) {
    if (!account) return false
    if (account.cooldownUntil > now) return false
    // accessToken 过期但 refreshToken 还有效 → 可救，算可用（取用时会刷新）
    if (account.expiresAt && account.expiresAt <= now && account.refreshExpiresAt <= now) return false
    if (this.belowReserve(account)) return false
    return true
  }

  /** 因为留底而暂时让位的账号数（界面用）。 */
  heldByReserve() {
    return this.accounts().filter((a) => this.belowReserve(a)).length
  }

  usable(now = Date.now()) {
    return this.accounts().filter((a) => this.isUsable(a, now))
  }

  cooldownOf(account, now = Date.now()) {
    const ms = (account?.cooldownUntil ?? 0) - now
    return ms > 0 ? ms : 0
  }

  /** 标记冷却。原因：rate-limit / exhaust / dead。 */
  markCooldown(account, kind, ms) {
    const now = Date.now()
    account.cooldownUntil = Math.max(account.cooldownUntil || 0, now + ms)
    account.cooldownReason = kind
    // 上游明确说积分不够 → 本地余额直接记 0。
    // 否则冷却结束后会被重新选中、再撞一次 402，白烧一次往返。
    if (kind === 'exhaust') {
      account.credits = { ...(account.credits || {}), total: 0, at: now }
    }
    this.persist()
    log(`账号 ${account.label} 进入冷却(${kind}) ${Math.round(ms / 1000)}s`)
  }

  markSuccess(account) {
    if (!account) return
    account.lastUsedAt = Date.now()
    account.requestCount = (account.requestCount || 0) + 1
    if (account.cooldownUntil && account.cooldownUntil < Date.now()) {
      account.cooldownUntil = 0
      account.cooldownReason = ''
    }
  }

  markFailure(account) {
    if (!account) return
    account.failureCount = (account.failureCount || 0) + 1
  }

  clearCooldowns() {
    for (const acc of this.byId.values()) {
      acc.cooldownUntil = 0
      acc.cooldownReason = ''
    }
    this.persist()
  }

  /**
   * 选一个账号。
   *
   * conversationKey 用于 sticky：同一个对话尽量落在同一个账号上。
   * 上游 prompt 缓存按账号隔离，中途换号等于把整段对话的缓存作废。
   */
  pick({ conversationKey, exclude } = {}) {
    const now = Date.now()
    const mode = this.config.distribution || 'priority'
    const skip = exclude instanceof Set ? exclude : new Set(exclude ?? [])

    if (mode === 'sticky' && conversationKey) {
      const bound = this.stickyBindings.get(conversationKey)
      if (bound && !skip.has(bound)) {
        const acc = this.byId.get(bound)
        if (this.isUsable(acc, now)) return acc
      }
    }

    const pool = this.usable(now).filter((a) => !skip.has(a.id))
    if (pool.length === 0) return undefined

    // priority / sticky 的缺省顺序：按加入时间，先用完一个号
    const ordered = [...pool].sort((a, b) => (a.firstSeenAt || 0) - (b.firstSeenAt || 0))

    let chosen
    if (mode === 'round-robin') {
      chosen = ordered[this.rrCursor % ordered.length]
      this.rrCursor++
    } else if (mode === 'balanced') {
      // 权重 = 1 + 闲置小时数，上限 6；闲置越久越容易被抽到
      const weights = ordered.map((a) => {
        if (!a.lastUsedAt) return 6
        const hours = Math.max(0, (now - a.lastUsedAt) / 3600_000)
        return 1 + Math.min(hours * 0.5, 5)
      })
      const total = weights.reduce((s, w) => s + w, 0)
      let r = Math.random() * total
      chosen = ordered[ordered.length - 1]
      for (let i = 0; i < ordered.length; i++) {
        r -= weights[i]
        if (r <= 0) { chosen = ordered[i]; break }
      }
    } else if (mode === 'expiry') {
      // 先用积分包最早过期的账号，避免「放着过期」
      const score = (a) => a.credits?.nearestExpiryMs ?? Number.MAX_SAFE_INTEGER
      chosen = [...ordered].sort((a, b) => score(a) - score(b))[0]
    } else {
      chosen = ordered[0]
    }

    // sticky 的新对话也按游标往前走，否则所有新会话都压在第一个号上
    if (mode === 'sticky') {
      chosen = ordered[this.rrCursor % ordered.length]
      this.rrCursor++
    }

    if (mode === 'sticky' && conversationKey && chosen) {
      if (this.stickyBindings.size > 200) {
        const oldest = this.stickyBindings.keys().next().value
        this.stickyBindings.delete(oldest)
      }
      this.stickyBindings.set(conversationKey, chosen.id)
    }
    return chosen
  }
}

/**
 * 留底阈值的纯函数版本（模块级，供 summarize 用）。
 * 与 Pool#creditsReserve / #belowReserve 保持同一套规则。
 */
export function reserveOf(config) {
  const n = Number(config?.minCredits)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function belowReserveOf(account, config) {
  const reserve = reserveOf(config)
  if (reserve <= 0 || !account) return false
  const total = account.credits?.total
  if (typeof total !== 'number') return false
  return total <= reserve
}

/** 账号的展示用摘要（不含令牌）。 */
export function summarize(account, config) {
  const now = Date.now()
  return {
    id: account.id,
    label: account.label,
    uid: account.uid,
    uin: account.uin,
    region: account.region,
    domain: account.domain,
    expiresAt: account.expiresAt,
    refreshExpiresAt: account.refreshExpiresAt,
    tokenValid: !account.expiresAt || account.expiresAt > now,
    lastSeenAt: account.lastSeenAt,
    lastUsedAt: account.lastUsedAt,
    cooldownMs: Math.max(0, (account.cooldownUntil || 0) - now),
    cooldownReason: account.cooldownReason || '',
    usable: (account.cooldownUntil || 0) <= now && !belowReserveOf(account, config),
    // 因积分留底被让位（区别于冷却/失效）
    reserveHold: belowReserveOf(account, config),
    reserve: reserveOf(config),
    credits: account.credits,
    checkin: account.checkin,
    requestCount: account.requestCount || 0,
    failureCount: account.failureCount || 0,
    inputTokens: account.inputTokens || 0,
    outputTokens: account.outputTokens || 0,
    creditSpent: account.creditSpent || 0,
    defaultCooldownMs: config?.cooldownMs ?? 60_000,
  }
}

export { DAY }
