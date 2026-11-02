/**
 * WorkBuddy 上游客户端。
 *
 * 对话走 `POST {chatBase}/v2/chat/completions`（OpenAI 兼容、恒为流式）；
 * 计费与签到走 `{billingBase}/v2/billing/meter/*`；模型目录国内版走
 * `/v2/enterprises/personal/models`，国际版走 `/v3/config`。
 *
 * 错误必须分类，因为池子的反应完全不同：
 *   rate-limit → 冷却这个号，换下一个
 *   exhaust    → 这个号积分耗尽，长时间休息
 *   dead       → 凭据失效，只有重新登录能解
 *   server     → 上游抖动，可以重试别的号
 *   client     → 请求本身有问题，换号也没用，直接回给调用方
 */

import { randomUUID, createHash } from 'node:crypto'
import { chatBaseOf, billingBaseOf } from './accounts.mjs'

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const DESKTOP_TASK_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096
const CONVERSATION_SALT = 'conversation'

/** 积分不足的标记（ASCII 小写 + 中文原样）。 */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough', 'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** 会话失效标记：这条凭据死了，换号。 */
const SESSION_DEAD_MARKERS = [
  'offline user session not found', '12153',
  'api key is invalid', 'invalid api key', 'invalid_api_key',
  'api密钥无效', '密钥无效', '无效的密钥',
  'unauthorized', 'token expired', 'token is invalid',
  'login expired', 'please login', '未登录', '登录已失效', '重新登录',
]

/** 今天已签到：非零业务码 + HTTP 400，但这是幂等成功，不是失败。 */
const ALREADY_CHECKIN_MARKERS = ['已签到', 'already']

/** 没有可领的补偿：季节性活动，绝大多数时候就是这个回答，属于成功空操作。 */
const NO_COMPENSATION_MARKERS = [
  '没有可领取', '暂无可领取', '无可领取', '不可领取', '未开启', '没有活动',
  '已领取', '已过期', '活动已结束', '已结束',
  'not eligible', 'no compensation', 'already claimed', 'not found', 'expired',
]

function lower(s) {
  return String(s || '').toLowerCase()
}

/** 判定错误类别。 */
export function classifyUpstreamError(status, text) {
  const body = lower(text)
  if (status === 429) return 'rate-limit'
  if (status === 401 || status === 403) return 'dead'
  for (const m of SESSION_DEAD_MARKERS) if (body.includes(m)) return 'dead'
  for (const m of HARD_CREDIT_MARKERS) if (body.includes(m)) return 'exhaust'
  if (status >= 500) return 'server'
  if (status === 0) return 'server'
  if (status >= 400) return 'client'
  // 200 信封里也可能夹着限流/积分错误
  if (body.includes('rate limit') || body.includes('too many requests') || body.includes('限流')) return 'rate-limit'
  return 'client'
}

/** 公共请求头。 */
function commonHeaders(account) {
  const origin = billingBaseOf(account)
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** 对话请求头：带上身份、会话三元组与客户端标识。 */
export function chatHeaders(account, conversationKey) {
  const headers = {
    ...commonHeaders(account),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${account.accessToken}`,
    'X-Product': 'SaaS',
    ...(account.uid ? { 'X-User-Id': account.uid } : { 'X-No-User-Id': '1' }),
    ...(account.domain ? { 'X-Domain': account.domain } : { 'X-No-Department-Info': '1' }),
    // 桌面端每次对话都带这三个，计费控制台的「使用端」列靠它归属
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': '5.5.6',
  }
  const identity = conversationIdentity(conversationKey)
  headers['X-Conversation-ID'] = identity.id
  headers['X-Conversation-Request-ID'] = identity.requestId
  headers['acp-connection-id'] = identity.acpId
  headers['X-Conversation-Message-ID'] = randomUUID()
  headers['X-Request-ID'] = randomUUID()
  headers['X-Agent-Intent'] = 'craft'
  headers['X-Agent-Purpose'] = 'conversation'
  headers['X-Private-Data'] = 'true'
  headers['x-codebuddy-request'] = '1'
  return headers
}

/**
 * 由对话键派生出稳定的一套会话标识。
 *
 * 同一个对话每轮都必须落在同一组 id 上，否则上游会把它当成陌生会话；
 * 没有对话键时用随机 UUID。
 */
export function conversationIdentity(conversationKey) {
  const base = conversationKey && conversationKey !== '' ? conversationKey : randomUUID()
  const hash = (suffix) => createHash('sha256').update(`${CONVERSATION_SALT}:${suffix}:${base}`).digest('hex')
  const asUuid = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  return {
    id: asUuid(hash('id')),
    requestId: asUuid(hash('request')),
    acpId: asUuid(hash('acp')),
  }
}

/** 计费接口的请求头。 */
function billingHeaders(account) {
  const headers = {
    'Authorization': `Bearer ${account.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (account.uid) headers['X-User-Id'] = account.uid
  if (account.domain) headers['X-Domain'] = account.domain
  return headers
}

/**
 * 规范化请求体。
 *
 * 上游恒为流式，并且要 `include_usage` 才有用量与扣费数字；`developer` 角色
 * 上游不认，要折成 `system`；`tool_choice: none` 时把 tools/functions 去掉，
 * 否则部分模型会报参数错。
 */
export function prepareChatBody(raw, { region = 'cn' } = {}) {
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return raw
  body.stream = true
  const opts = typeof body.stream_options === 'object' && body.stream_options !== null && !Array.isArray(body.stream_options)
    ? body.stream_options
    : {}
  opts.include_usage = true
  body.stream_options = opts

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) continue
      if (msg.role === 'developer') msg.role = 'system'
    }
  }
  const choice = body.tool_choice
  if (typeof choice === 'string' && choice.trim().toLowerCase() === 'none') {
    delete body.tool_choice
    delete body.tools
    delete body.functions
  }
  // 两个网关都不接受 reasoning_effort: 'off'
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
  // 国际版要求首条消息是 system
  if (region === 'global' && Array.isArray(body.messages)) {
    const first = body.messages[0]
    if (!(first && typeof first === 'object' && first.role === 'system')) {
      body.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
    }
  }
  return JSON.stringify(body)
}

/** 扣掉上游多塞的 usage 尾帧，让转发的流保持调用方期望的形状。 */
export function stripUsageFrame(frame) {
  if (!frame || typeof frame !== 'string') return frame
  const trimmed = frame.trim()
  if (!trimmed.startsWith('{')) return frame
  try {
    const obj = JSON.parse(trimmed)
    if (obj && obj.usage && (!Array.isArray(obj.choices) || obj.choices.length === 0)) return null
  } catch {
    return frame
  }
  return frame
}

/**
 * 解析一条成长任务。
 *
 * 上游不标「可领取」，只能用「进度到位且没领过」自己推：accept_status 为
 * claimed 表示已领；进度可能在顶层，也可能嵌在 progress 里。
 */
export function parseGrowthTask(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const taskCode = typeof value.task_code === 'string' ? value.task_code : ''
  if (taskCode === '') return undefined
  const num = (k) => (typeof value[k] === 'number' ? value[k] : 0)
  let current = num('current')
  let target = num('target')
  const progress = value.progress
  if (typeof progress === 'object' && progress !== null) {
    const nc = typeof progress.current === 'number' ? progress.current : 0
    const nt = typeof progress.target === 'number' ? progress.target : 0
    if (nt > 0 || nc > 0) { current = nc; target = nt }
  }
  const acceptStatus = typeof value.accept_status === 'string' ? value.accept_status : ''
  return {
    taskCode,
    title: typeof value.title === 'string' && value.title !== '' ? value.title : taskCode,
    credit: num('reward_credit'),
    energy: num('reward_energy'),
    hasReward: value.has_reward === true,
    target,
    current,
    acceptStatus,
    claimed: acceptStatus === 'claimed',
    /** 进度到位且没领过才算可领 */
    claimable: target > 0 && current >= target && acceptStatus !== 'claimed',
  }
}

/** 解析 "x0.05" / "x0.00 credits" 这类倍率为数字。 */
export function parseCreditMultiplier(raw) {
  if (typeof raw !== 'string') return undefined
  const m = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(raw)
  return m ? Number(m[1]) : undefined
}

/** 模型目录缓存：per account region，5 分钟。 */
const catalogCache = new Map()
const CATALOG_TTL_MS = 5 * 60_000

export class WorkBuddyClient {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl
  }

  /** 一次非流式 JSON 调用，返回 { ok, status, json, text }。 */
  async json(account, path, { method = 'POST', body = '{}', headers, timeout = JSON_TIMEOUT_MS } = {}) {
    const url = `${billingBaseOf(account)}${path}`
    let response
    try {
      response = await this.fetch(url, {
        method,
        headers: headers ?? billingHeaders(account),
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeout),
      })
    } catch (error) {
      return { ok: false, status: 0, json: null, text: `transport: ${String(error)}` }
    }
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { ok: response.ok, status: response.status, json, text }
  }

  /** 模型目录（带 5 分钟缓存）。 */
  async fetchModels(account, { force = false } = {}) {
    const key = `${account.region}:${account.id}`
    const cached = catalogCache.get(key)
    if (!force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.models

    const isGlobal = account.region === 'global'
    const url = isGlobal
      ? `${chatBaseOf(account)}/v3/config`
      : `${chatBaseOf(account)}/v2/enterprises/personal/models`
    const headers = {
      ...commonHeaders(account),
      'Authorization': `Bearer ${account.accessToken}`,
      'X-Product': 'SaaS',
      ...(isGlobal ? { 'User-Agent': 'WorkBuddy/5.5.2' } : {}),
      ...(account.uid ? { 'X-User-Id': account.uid } : {}),
      ...(account.domain ? { 'X-Domain': account.domain } : {}),
    }
    const response = await this.fetch(url, { headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`模型目录不是 JSON（HTTP ${response.status}）`) }
    if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
      throw new Error(`模型目录请求失败（HTTP ${response.status} / code ${payload.code}）`)
    }
    const data = payload.data ?? {}
    const raw = data.models ?? data.Models ?? data.config?.models ?? []
    const models = (Array.isArray(raw) ? raw : []).map((m) => ({
      id: m.id ?? m.model ?? '',
      name: m.name ?? m.id ?? '',
      vendor: m.vendor ?? '',
      credits: parseCreditMultiplier(m.credits),
      creditsRaw: typeof m.credits === 'string' ? m.credits : undefined,
      freeTag: Array.isArray(m.tags) ? m.tags.find((t) => typeof t === 'string' && t.includes('免费')) : undefined,
      supportsImages: m.supportsImages === true,
      supportsToolCall: m.supportsToolCall === true,
      supportsReasoning: m.supportsReasoning === true,
      maxInputTokens: m.maxInputTokens ?? m.maxAllowedSize ?? 0,
      maxOutputTokens: m.maxOutputTokens ?? 0,
      description: m.descriptionZh ?? m.descriptionEn ?? '',
      isDefault: m.isDefault === true,
    })).filter((m) => m.id)
    catalogCache.set(key, { at: Date.now(), models })
    return models
  }

  /** 剩余积分（按积分包聚合，不消耗额度）。 */
  async fetchCredits(account) {
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const fmt = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    const body = JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 86400_000)),
    })
    const res = await this.json(account, '/v2/billing/meter/get-user-resource', { body })
    if (!res.ok || !res.json || res.json.code !== 0) {
      throw new Error(`积分查询失败（HTTP ${res.status} / ${res.json?.msg ?? res.text.slice(0, 160)}）`)
    }
    const accounts = res.json.data?.Response?.Data?.Accounts ?? []
    let total = 0
    let expiringSoon = 0
    let nearestExpiryMs
    const SOON = 3 * 86400_000
    const packages = []
    const parseDate = (raw) => {
      if (typeof raw === 'number' && raw > 1e12) return raw
      if (typeof raw === 'string' && raw) {
        const t = Date.parse(raw)
        return Number.isNaN(t) ? undefined : t
      }
      return undefined
    }
    for (const a of accounts) {
      if (typeof a !== 'object' || a === null) continue
      const num = (k) => (typeof a[k] === 'number' ? a[k] : 0)
      const monthly = num('CapacityType') === 4
      const remain = monthly ? num('CycleCapacityRemain') : num('CapacityRemain')
      const size = monthly ? num('CycleCapacitySize') : num('CapacitySize')
      const capped = remain < 0 ? 0 : remain
      const cycleEnd = parseDate(a.CycleEndTime)
      const expiresAt = monthly ? undefined : (parseDate(a.ExpiredTime) ?? cycleEnd)
      if (!monthly && (capped <= 0 || (expiresAt !== undefined && expiresAt <= Date.now()))) continue
      total += capped
      if (expiresAt !== undefined) {
        if (nearestExpiryMs === undefined || expiresAt < nearestExpiryMs) nearestExpiryMs = expiresAt
        if (expiresAt - Date.now() <= SOON) expiringSoon += capped
      }
      packages.push({
        name: typeof a.PackageName === 'string' ? a.PackageName : '(未命名)',
        remain: capped,
        size,
        monthly,
        expiresAt,
        refreshAt: monthly && cycleEnd ? cycleEnd + 1000 : undefined,
      })
    }
    const value = { total, packages, expiringSoon, nearestExpiryMs, at: Date.now() }
    account.credits = value
    return value
  }

  /** 今天的签到状态（只读）。 */
  async fetchCheckin(account) {
    const res = await this.json(account, '/v2/billing/meter/checkin-activity-status', { body: '{}' })
    if (!res.ok || !res.json || res.json.code !== 0) {
      throw new Error(`签到状态查询失败（HTTP ${res.status} / ${res.json?.msg ?? res.text.slice(0, 160)}）`)
    }
    const d = res.json.data ?? {}
    const num = (k) => (typeof d[k] === 'number' ? d[k] : 0)
    return {
      active: d.active === true,
      todayCheckedIn: d.today_checked_in === true,
      streakDays: num('streak_days'),
      dailyCredit: num('daily_credit'),
      todayCredit: num('today_credit'),
      isStreakDay: d.is_streak_day === true,
      nextStreakDay: num('next_streak_day'),
      streakBonusDays: num('streak_bonus_days'),
      streakBonusCredit: num('streak_bonus_credit'),
      claimButtonText: typeof d.claim_button_text === 'string' ? d.claim_button_text : '',
    }
  }

  /** 领取今天的签到奖励。已领过会返回幂等成功。 */
  async claimCheckin(account) {
    const res = await this.json(account, '/v2/billing/meter/daily-checkin', { body: '{}' })
    const message = lower(res.json?.msg ?? res.text)
    if (ALREADY_CHECKIN_MARKERS.some((m) => message.includes(m))) {
      return { ok: true, already: true, credit: 0, streakDays: 0 }
    }
    if (!res.ok || !res.json || res.json.code !== 0) {
      return { ok: false, message: res.json?.msg ?? res.text.slice(0, 200) }
    }
    const d = res.json.data ?? {}
    return {
      ok: true,
      already: false,
      credit: typeof d.credit === 'number' ? d.credit : 0,
      streakDays: typeof d.streak_days === 'number' ? d.streak_days : 0,
      isStreakDay: d.is_streak_day === true,
    }
  }

  /** 服务中断补偿：查询。注意这条路径没有 /v2 前缀。 */
  async fetchCompensation(account) {
    const res = await this.json(account, '/billing/meter/compensation-status', { body: '{}' })
    if (!res.ok || !res.json || res.json.code !== 0) {
      throw new Error(`补偿状态查询失败（HTTP ${res.status}）`)
    }
    const d = res.json.data ?? {}
    return { active: d.active === true, credit: typeof d.credit === 'number' ? d.credit : 0, raw: d }
  }

  /** 领取服务中断补偿。没有可领的属于成功空操作。 */
  async claimCompensation(account) {
    const res = await this.json(account, '/billing/meter/compensation-claim', { body: '{}' })
    const message = lower(res.json?.msg ?? res.text)
    if (NO_COMPENSATION_MARKERS.some((m) => message.includes(m))) {
      return { ok: true, empty: true, credit: 0 }
    }
    if (!res.ok || !res.json || res.json.code !== 0) {
      return { ok: false, message: res.json?.msg ?? res.text.slice(0, 200) }
    }
    const d = res.json.data ?? {}
    return { ok: true, empty: false, credit: typeof d.credit === 'number' ? d.credit : 0 }
  }

  /** 刷新令牌。 */
  async refreshToken(account) {
    if (!account.refreshToken) throw new Error('没有 refreshToken，无法续期')
    const url = `${chatBaseOf(account)}/v2/plugin/auth/token/refresh`
    const headers = {
      ...commonHeaders(account),
      'X-Refresh-Token': account.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
    }
    const response = await this.fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`续期返回非 JSON（HTTP ${response.status}）`) }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`续期失败（HTTP ${response.status} / ${payload.msg ?? text.slice(0, 120)}）`)
    }
    const d = payload.data ?? {}
    if (typeof d.accessToken !== 'string' || d.accessToken === '') {
      throw new Error('续期没有返回 accessToken，请回桌面端重新登录')
    }
    const expiresInSec = typeof d.expiresIn === 'number' && d.expiresIn > 0 ? d.expiresIn : 0
    account.accessToken = d.accessToken
    if (typeof d.refreshToken === 'string' && d.refreshToken !== '') account.refreshToken = d.refreshToken
    if (expiresInSec > 0) account.expiresAt = Date.now() + expiresInSec * 1000
    if (typeof d.domain === 'string' && d.domain !== '') account.domain = d.domain
    return account
  }

  /**
   * 令牌快过期就先续期。
   *
   * 只改池里的副本，不写回桌面端的 .info：桌面端自己会续期，两边同时写同一个
   * 文件会互相踩。池里那份足够长命即可。
   */
  async ensureFreshToken(account) {
    const margin = 5 * 60_000
    if (!account.expiresAt || account.expiresAt - Date.now() > margin) return account
    if (account.refreshExpiresAt && account.refreshExpiresAt <= Date.now()) {
      throw new Error('refreshToken 也已过期，请回 WorkBuddy 桌面端重新登录')
    }
    return this.refreshToken(account)
  }

  /**
   * 发起一次流式对话，返回 Response（由调用方读流）。
   *
   * 失败不抛异常，而是返回分类结果，让池子决定换号还是收工。
   */
  async chatStream(account, preparedBody, { conversationKey, signal } = {}) {
    const url = `${chatBaseOf(account)}/v2/chat/completions`
    let response
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: chatHeaders(account, conversationKey),
        body: preparedBody,
        signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, kind: 'aborted', status: 0, message: '调用方取消' }
      return { ok: false, kind: 'server', status: 0, message: `传输错误：${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, kind: classifyUpstreamError(response.status, text), status: response.status, message: text }
  }

  /**
   * 成长中心任务列表。
   *
   * 和对话共用 chatHeaders：这些端点被上游归到同一个客户端通道。
   */
  async listTasks(account) {
    const url = `${chatBaseOf(account)}/v2/activity/growth/tasks`
    let response
    try {
      response = await this.fetch(url, { headers: chatHeaders(account), signal: AbortSignal.timeout(JSON_TIMEOUT_MS) })
    } catch (error) {
      throw new Error(`任务列表传输错误：${String(error)}`)
    }
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`任务列表非 JSON（HTTP ${response.status}）`) }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`任务列表失败（HTTP ${response.status} / ${payload.msg ?? text.slice(0, 120)}）`)
    }
    const raw = Array.isArray(payload.data?.tasks) ? payload.data.tasks : []
    return raw.map(parseGrowthTask).filter((t) => t !== undefined)
  }

  /**
   * 接取任务。
   *
   * 接取只是「报名」，本身不产生进度；上游对已接取的任务也回成功，
   * 所以重放是安全的。进度靠真实使用行为点亮。
   */
  async acceptTasks(account, taskCodes) {
    if (!taskCodes || taskCodes.length === 0) return
    const url = `${chatBaseOf(account)}/v2/activity/growth/tasks/accept`
    const response = await this.fetch(url, {
      method: 'POST',
      headers: chatHeaders(account),
      body: JSON.stringify({ task_codes: [...taskCodes] }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`接取任务返回非 JSON（HTTP ${response.status}）`) }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`接取任务失败（HTTP ${response.status} / ${payload.msg ?? text.slice(0, 120)}）`)
    }
  }

  /**
   * 领取单个任务的奖励。
   *
   * 三个细节都是关键：任务码走**路径**不走 body；这条路径在 **web 主域**而不是
   * 对话网关；必须带成长中心的 Origin/Referer 与 `x-client-platform: web`。
   * 重复领取会回 already_claimed + 0 积分，按成功处理以保持幂等。
   */
  async claimTaskReward(account, taskCode) {
    const host = account.region === 'global' ? chatBaseOf(account) : 'https://www.workbuddy.cn'
    const origin = host
    const headers = {
      ...billingHeaders(account),
      'Accept': 'application/json, text/plain, */*',
      'Origin': origin,
      'Referer': `${origin}/profile/growth-center`,
      'x-client-platform': 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    }
    const url = `${host}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
    const response = await this.fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new Error(`领取奖励返回非 JSON（HTTP ${response.status}）`) }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`领取奖励失败（HTTP ${response.status} / ${payload.msg ?? text.slice(0, 120)}）`)
    }
    const d = payload.data ?? {}
    if (d.already_claimed === true) return { credit: 0, energy: 0, already: true }
    return {
      credit: typeof d.credit === 'number' ? d.credit : 0,
      energy: typeof d.energy === 'number' ? d.energy : 0,
      already: false,
    }
  }

  /** 桌面端上报接口（积分自动化的一部分）。 */
  async reportDesktop(account, payload) {
    const url = `${billingBaseOf(account)}/v2/report`
    const headers = {
      ...commonHeaders(account),
      'Authorization': `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': DESKTOP_TASK_UA,
      ...(account.uid ? { 'X-User-Id': account.uid } : {}),
      ...(account.domain ? { 'X-Domain': account.domain } : {}),
    }
    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    return { ok: response.ok, status: response.status, text: await response.text().catch(() => '') }
  }
}
