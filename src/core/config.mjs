/**
 * 配置与运行时目录。
 *
 * 数据统一放在 ~/.wbpool（可用 WBPOOL_HOME 覆盖），与 WorkBuddy 自己的
 * 配置目录分开：池的账号快照、账本、第三方 key 都属于本工具，不该混进
 * WorkBuddy 的目录里。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.WBPOOL_HOME || join(homedir(), '.wbpool')

export const PATHS = {
  home: HOME,
  config: join(HOME, 'config.json'),
  accounts: join(HOME, 'accounts.json'),
  stats: join(HOME, 'stats.json'),
  automation: join(HOME, 'automation.json'),
  channels: join(HOME, 'channels.json'),
  log: join(HOME, 'wbpool.log'),
}

export function ensureHome() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true })
  return HOME
}

/** 默认配置。第三方渠道默认一家都不开，填了 key 才亮。 */
export const DEFAULTS = {
  /** 网关监听端口。 */
  port: 8788,
  /** 绑定地址。默认只回环，避免把池子暴露到局域网。 */
  host: '127.0.0.1',
  /**
   * 账号分配方式：
   *  - priority（默认）先用完一个号
   *  - round-robin 按顺序轮换
   *  - balanced 随机，偏向闲置久的
   *  - sticky 一个对话只用一个账号，新对话才换下一个
   *  - expiry 先用快过期的积分包
   */
  distribution: 'priority',
  /** 单账号 429 冷却时长（毫秒）。 */
  cooldownMs: 60_000,
  /** 积分耗尽后的休息时长（毫秒）。 */
  exhaustCooldownMs: 30 * 60_000,
  /** 凭据被上游拒绝后的休息时长（毫秒），只有重新登录能解。 */
  credentialDeadCooldownMs: 30 * 60_000,
  /** 提前多久刷新 token（毫秒）。 */
  refreshMarginMs: 5 * 60_000,
  /** 调用方只写 `wbpool` 时，实际转发到哪个上游模型。 */
  defaultModel: 'auto',
  /** 第三方渠道：{ [providerId]: { apiKey, enabled, baseUrl?, models? } }。 */
  providers: {},
  /**
   * 模型路由：把几个模型串成一条链，调用时按顺序/轮换。
   * [{ id, name, strategy: 'sequential'|'round-robin', models: ['wbpool/hy3', 'groq/...'] }]
   */
  routes: [],
  /**
   * 被勾选要注册成 WorkBuddy 独立模型条目的模型 id。
   * 例如 wbpool.hy3 / wbpool.deepseek:deepseek-chat
   */
  selectedModels: [],
  /** 第三方渠道在池子里的优先级：数字越小越先用；WorkBuddy 账号恒为 0。 */
  thirdPartyAfterWorkBuddy: true,
  /** 网关的本地密钥；WorkBuddy 的 models.json 里要用同一个。 */
  gatewayKey: 'wbpool-local',
  /**
   * 访问鉴权。
   *
   * 本地跑（127.0.0.1）时 adminPassword 为空即不校验；部署到公网必须设，
   * 因为网关手里是你的账号 token，谁能访问谁就能烧额度。
   */
  auth: {
    /** 唯一凭证：只认密码，不要用户名。 */
    password: '',
    /** 兼容字段（旧版 Basic 用的用户名），不参与校验。 */
    adminUser: 'admin',
    /** 本机往云端推 token 时的共享密钥。 */
    syncSecret: '',
    /** 登录 cookie 的签名密钥；为空时退回用 syncSecret。 */
    sessionSecret: '',
  },
  /** 云端模式：不接受本机 auth 目录扫描，只认同步进来的凭据。 */
  remoteMode: false,
  /**
   * 对外公网地址（含挂载路径），例如 https://1.2.3.4/wbpool。
   * 渠道登录要回调到这里，所以必须能在公网打开。
   */
  publicBaseUrl: '',
  /** 积分自动化。 */
  automation: {
    enabled: true,
    /** 每日签到跑的时间点（本地时间 HH:MM）。云端默认 00:01。 */
    checkinAt: '00:01',
    /** 补偿 / 任务奖励跑的时间点。 */
    rewardsAt: '00:06',
    /** 启动时先补跑一次（错过当天定时也不会漏）。 */
    runOnStart: true,
  },
}

function deepMerge(base, extra) {
  if (extra === undefined || extra === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return extra
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return extra
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in base ? deepMerge(base[k], v) : v
  }
  return out
}

/** 读配置，缺失字段用默认值补齐。 */
export function loadConfig() {
  ensureHome()
  let raw = {}
  if (existsSync(PATHS.config)) {
    try {
      raw = JSON.parse(readFileSync(PATHS.config, 'utf8'))
    } catch {
      raw = {}
    }
  }
  return deepMerge(DEFAULTS, raw)
}

/** 原子写配置（避免半截文件）。 */
export function saveConfig(config) {
  ensureHome()
  const tmp = `${PATHS.config}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
  renameSync(tmp, PATHS.config)
  return config
}

/** 读 JSON 文件，坏了就当空。 */
export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON。 */
export function writeJson(path, value) {
  ensureHome()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
  return value
}

/** 简单日志：同时写文件与 stderr。 */
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
  try {
    ensureHome()
    writeFileSync(PATHS.log, line + '\n', { flag: 'a' })
  } catch {
    // 日志失败不影响主流程
  }
  process.stderr.write(line + '\n')
}
