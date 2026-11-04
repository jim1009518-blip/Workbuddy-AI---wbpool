/**
 * WB Pool 本地版 —— 双击 exe 后的真正入口（由 local-entry.cjs 解包后加载）。
 *
 * 全程本地运行，不需要任何服务器：
 *   1. 读/建 ~/.wbpool 配置（首启自动生成默认配置）
 *   2. 扫描本机 WorkBuddy 桌面端凭据，收进账号池
 *   3. 起网关（127.0.0.1，默认 8788，被占用会自动往后找）
 *   4. 把池模型注册进 WorkBuddy 的 models.json（只动 wbpool 条目）
 *   5. 打开浏览器进控制台；后台每 5 分钟重扫一次（桌面端刷新 token 能自动跟上）
 *
 * 没装 WorkBuddy 也能用：控制台「渠道」页填第三方免费渠道的 Key 即可。
 */

import { execFile, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, PATHS, log } from './src/core/config.mjs'
import { AccountPool, authDirs } from './src/core/accounts.mjs'
import { WorkBuddyClient } from './src/core/upstream.mjs'
import { Stats } from './src/core/stats.mjs'
import { createGateway } from './src/core/gateway.mjs'
import { startAutomation } from './src/automation.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_DIR = join(HERE, 'ui')

try {
  if (process.platform === 'win32') execSync('chcp 65001 > nul', { stdio: 'ignore', shell: 'cmd.exe', windowsHide: true })
} catch { /* 同上 */ }

const line = (s = '') => { try { process.stdout.write(s + '\n') } catch { /* 无窗口模式下没有控制台，静默 */ } }
const info = (s) => line('    ' + s)

function openBrowser(url) {
  try {
    if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true })
    else if (process.platform === 'darwin') execFile('open', [url])
    else execFile('xdg-open', [url])
  } catch { /* 打不开就把地址印在屏幕上 */ }
}

/**
 * 开机自启：把当前 exe 复制一份到 %LOCALAPPDATA%\wbpool\WB Pool.exe（稳定路径，
 * 不受桌面文件挪动/删除影响），并写 HKCU Run 注册表键（只影响当前用户，
 * 不需要管理员权限）。每次启动都会确保副本与注册表最新。
 */
function ensureAutostart() {
  if (process.platform !== 'win32') return
  try {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const target = join(base, 'wbpool', 'WB Pool.exe')
    mkdirSync(dirname(target), { recursive: true })
    try { copyFileSync(process.execPath, target) } catch { /* 目标正在运行（开机自启那份），无需更新 */ }
    execFile('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'WBPool', '/t', 'REG_SZ', '/d', `"${target}"`, '/f',
    ], { windowsHide: true }, () => { /* 写完即可，不等结果 */ })
  } catch { /* 注册失败不影响主流程 */ }
}

/** 探测是否已有实例在跑（从配置端口起往后试 5 个），返回其端口，没有则 0。 */
async function findRunningInstance(config) {
  const host = config.host || '127.0.0.1'
  const start = Number(config.port) || 8788
  for (let port = start; port < start + 5; port++) {
    try {
      const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return port
    } catch { /* 没起来，试下一个端口 */ }
  }
  return 0
}

const ts = (ms) => {
  if (!ms || ms <= 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

/**
 * 在 WorkBuddy 的 models.json 里注册池模型。
 *
 * 只动 wbpool 开头的条目，用户自己加的模型一条不碰。
 * 写两种：wbpool（自动路由）+ wbpool.<上游>（控制台勾选的具体模型）。
 */
async function registerWorkbuddyModels(base, config) {
  const auth = 'Bearer ' + (config.gatewayKey || 'wbpool-local')
  const getJson = async (path) => {
    const res = await fetch(base + path, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`)
    return res.json()
  }

  const [catalog, selection] = await Promise.all([
    getJson('/api/models'),
    getJson('/api/models/selection'),
  ])
  const ids = new Set(selection.selection || [])
  const all = [...(catalog.workbuddy || []), ...(catalog.thirdParty || [])]
  const picked = all.filter((m) => ids.has(m.id))

  const path = join(process.env.WORKBUDDY_HOME || join(homedir(), '.workbuddy'), 'models.json')
  let existing = []
  if (existsSync(path)) {
    copyFileSync(path, `${path}.wbpool-backup-${Date.now()}`)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(parsed)) existing = parsed
    } catch { existing = [] }
  }

  const kept = existing.filter((m) => m && typeof m.id === 'string' && !m.id.startsWith('wbpool'))
  const entries = [{
    id: 'wbpool',
    name: 'WB Pool · 自动（多账号池）',
    vendor: 'WB Pool',
    url: `${base}/v1/chat/completions`,
    apiKey: config.gatewayKey || 'wbpool-local',
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    reasoning: { defaultEffort: 'high', supportedEfforts: ['high', 'max'] },
  }]
  for (const m of picked) {
    entries.push({
      id: m.id.replace('wbpool/', 'wbpool.'),
      name: `${m.name}${m.vendor && m.vendor !== 'WorkBuddy' ? ' · ' + m.vendor : ''}`,
      vendor: m.vendor || 'WB Pool',
      url: `${base}/v1/chat/completions`,
      apiKey: config.gatewayKey || 'wbpool-local',
      supportsToolCall: m.supportsToolCall !== false,
      supportsImages: m.supportsImages === true,
      supportsReasoning: m.supportsReasoning !== false,
      maxInputTokens: 256000,
      maxOutputTokens: 64000,
      reasoning: { defaultEffort: 'high', supportedEfforts: ['high', 'max'] },
    })
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify([...kept, ...entries], null, 2), 'utf8')
  return { written: entries.length, kept: kept.length, path }
}

async function main() {
  const firstRun = !existsSync(PATHS.config)
  const config = loadConfig()
  if (firstRun) saveConfig(config)   // 落一份默认配置，方便用户改端口 / 填渠道 Key

  // 开机自启（老版本升级上来的也会补注册）
  ensureAutostart()

  // 已有实例在跑（多半是开机自启那份）：直接打开控制台就走，不重复起网关
  const runningPort = await findRunningInstance(config)
  if (runningPort) {
    openBrowser(`http://${config.host || '127.0.0.1'}:${runningPort}/`)
    return 0
  }

  line('')
  line('  WB Pool 本地版  ·  AI 聚合池（多账号轮换 + 免费渠道兜底）')
  line('  ' + '─'.repeat(56))
  info(`数据目录：${PATHS.home}`)

  const pool = new AccountPool(config)
  const client = new WorkBuddyClient()
  const stats = new Stats()

  // 扫本机 WorkBuddy 凭据；没装 WorkBuddy 会优雅降级（池为空，不报错）
  process.stdout.write('  [1/4] 扫描本机 WorkBuddy 账号 ... ')
  try {
    const result = await pool.scan()
    line(`发现 ${result.found} 个，池内共 ${result.total} 个`)
    for (const err of result.errors.slice(0, 3)) info(`! ${err}`)
  } catch (error) {
    line(`跳过（${String(error && error.message || error).slice(0, 60)}）`)
  }

  // 端口被占（多半是上次没关）就自动往后找
  process.stdout.write('  [2/4] 启动网关 ... ')
  const automation = startAutomation({ config, pool, client, stats })
  const { server } = createGateway({
    config, pool, client, stats, uiDir: UI_DIR,
    runAutomation: (kind) => automation.runNow(kind),
  })
  server.on('error', () => { /* listen 重试时自己处理，避免崩进程 */ })
  let port = Number(config.port) || 8788
  let bound = false
  for (let attempt = 0; attempt < 20; attempt++) {
    bound = await new Promise((resolve) => {
      const onError = () => { cleanup(); resolve(false) }
      const onListen = () => { cleanup(); resolve(true) }
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListen)
      }
      server.once('error', onError)
      server.once('listening', onListen)
      server.listen(port, config.host)
    })
    if (bound) break
    try { server.close() } catch { /* 忽略 */ }
    port++
  }
  if (!bound) {
    line('失败（8788~8807 都被占用）')
    await new Promise((r) => setTimeout(r, 15000))
    return 1
  }

  const base = `http://${config.host}:${port}`
  line(`完成（${base}）`)

  // 注册进 WorkBuddy 模型列表（没装 WorkBuddy 时这里会静默跳过）
  process.stdout.write('  [3/4] 注册 WorkBuddy 模型 ... ')
  try {
    const r = await registerWorkbuddyModels(base, config)
    line(`完成（${r.path}）`)
  } catch (error) {
    line(`跳过（${String(error && error.message || error).slice(0, 70)}）`)
  }

  process.stdout.write('  [4/4] 打开控制台 ... ')
  openBrowser(base + '/')
  line('已打开')
  line('')

  const now = Date.now()
  const usable = pool.usable(now)
  line(`  控制台    ${base}/`)
  line(`  接口      ${base}/v1/chat/completions`)
  line(`  池        ${pool.accounts().length} 个账号（${usable.length} 个可用）`)
  line('  停止      任务管理器结束「WB Pool」进程（删除开机自启：注册表 Run 键 WBPool）')
  line('')
  if (pool.accounts().length === 0) {
    line('  还没有账号，两个办法任选：')
    for (const dir of authDirs().slice(0, 1)) info(`装有 WorkBuddy 桌面端 → 登录一次后重启本程序（扫描目录：${dir}）`)
    info('没装 WorkBuddy → 控制台「渠道」页填第三方免费渠道 Key（Groq / OpenRouter 等）')
    line('')
  }

  // 预热：控制台一进来就有积分与签到数据
  setTimeout(() => {
    ;(async () => {
      for (const account of pool.accounts()) {
        try { await client.fetchCredits(account) } catch { /* 单个失败不影响其它 */ }
        try { account.checkin = await client.fetchCheckin(account) } catch { /* 同上 */ }
      }
      pool.persist()
    })().catch(() => {})
  }, 1500).unref()

  // 每 5 分钟重扫：桌面端换号 / 刷新 token 后池子自动跟上
  const rescan = setInterval(() => {
    pool.scan().catch(() => {})
  }, 5 * 60_000)
  rescan.unref?.()

  const shutdown = () => {
    try { automation?.stop?.() } catch { /* 忽略 */ }
    try { stats.flush() } catch { /* 忽略 */ }
    pool.persist()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log('本地版网关已启动', base)
  return 0
}

main()
  .then((code) => { if (code) process.exit(code) })
  .catch((error) => {
    line('')
    line('  启动失败：' + String(error && error.stack || error))
    log('本地版启动失败', String(error && error.stack || error))
    setTimeout(() => process.exit(1), 15000)
  })
