#!/usr/bin/env node
/**
 * wbpool 命令行。
 *
 *   node src/cli.mjs serve              起网关（默认 127.0.0.1:8788）
 *   node src/cli.mjs status             池健康 + 账号 + 积分
 *   node src/cli.mjs accounts           已发现的账号
 *   node src/cli.mjs checkin [all|id]   查/领签到
 *   node src/cli.mjs credits            刷新每个号的积分包
 *   node src/cli.mjs doctor             诊断发现 / 解密 / 上游连通性
 *   node src/cli.mjs install            把池注册进 WorkBuddy 的 models.json
 *   node src/cli.mjs uninstall          从 models.json 摘掉池条目
 *   node src/cli.mjs test [提示词]      用池跑一次真实对话
 */

import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveConfig, PATHS, log, readJson } from './core/config.mjs'
import { AccountPool, authDirs } from './core/accounts.mjs'
import { WorkBuddyClient } from './core/upstream.mjs'
import { Stats } from './core/stats.mjs'
import { createGateway } from './core/gateway.mjs'
import { activeProviders, loadRegistry } from './core/providers.mjs'
import { appExecutableCandidates } from './core/at-rest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UI_DIR = join(__dirname, '..', 'ui')

const args = process.argv.slice(2)
const command = args[0] ?? 'serve'
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return fallback
}

const ts = (ms) => {
  if (!ms || ms <= 0) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}
const when = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-')

/** 造一套运行时对象。 */
async function bootstrap({ scan = true, quiet = false } = {}) {
  const config = loadConfig()
  const pool = new AccountPool(config)
  const client = new WorkBuddyClient()
  const stats = new Stats()
  if (scan) {
    const result = await pool.scan()
    if (!quiet) {
      console.log(`扫描完成：发现 ${result.found} 个凭据，池里共 ${result.total} 个账号${result.errors.length ? `，${result.errors.length} 条报错` : ''}`)
      for (const err of result.errors) console.log(`  ! ${err}`)
    }
  }
  return { config, pool, client, stats }
}

async function cmdStatus() {
  const { config, pool, client } = await bootstrap()
  const accounts = pool.accounts()
  if (accounts.length === 0) {
    console.log('\n池里还没有账号。')
    console.log('请先打开 WorkBuddy 桌面端登录；换号登录几次，每个号都会被自动收进池里。')
    for (const dir of authDirs()) console.log(`  扫描目录：${dir}${existsSync(dir) ? ' ✓' : ' (不存在)'}`)
    return
  }

  const now = Date.now()
  const usable = accounts.filter((a) => pool.isUsable(a, now))
  console.log(`\n池健康：${accounts.length} 个账号，${usable.length} 个可用，${accounts.length - usable.length} 个冷却中`)
  console.log(`分配策略：${config.distribution}    下一个轮到：${usable[0]?.label ?? '无'}\n`)

  for (const account of accounts) {
    const cool = Math.max(0, (account.cooldownUntil || 0) - now)
    const state = cool > 0 ? `冷却 ${ts(cool)} (${account.cooldownReason})` : '可用'
    console.log(`● ${account.label}  [${account.region}]  ${state}`)
    console.log(`  uid ${account.uid || '-'}  令牌到期 ${when(account.expiresAt)}`)
    if (account.credits) {
      const { total, packages } = account.credits
      console.log(`  积分合计 ${total}   积分包 ${packages.length} 个   刷新于 ${when(account.credits.at)}`)
    }
    if (account.checkin) {
      const c = account.checkin
      console.log(`  签到：连续 ${c.streakDays} 天，今日${c.todayCheckedIn ? '已签' : '未签'}（每日 ${c.dailyCredit} 分）`)
    }
    console.log(`  本轮请求 ${account.requestCount || 0}，失败 ${account.failureCount || 0}，累计积分消耗 ${(account.creditSpent || 0).toFixed(2)}`)
  }

  // 顺手刷一下积分与签到（只读，不领）
  try {
    const first = accounts.find((a) => pool.isUsable(a, now))
    if (first) {
      const credits = await client.fetchCredits(first)
      const checkin = await client.fetchCheckin(first)
      first.checkin = checkin
      pool.persist()
      console.log(`\n实时积分（${first.label}）：${credits.total}    签到连续 ${checkin.streakDays} 天，今日${checkin.todayCheckedIn ? '已签' : '未签'}`)
    }
  } catch (error) {
    console.log(`\n实时积分读取失败：${String(error.message || error)}`)
  }

  const third = activeProviders(config)
  console.log(`\n第三方渠道：${third.length === 0 ? '未启用（在配置里填 apiKey 即点亮）' : third.map((p) => p.name).join('、')}`)
  console.log(`注册表可选渠道：${loadRegistry().length} 家`)
}

async function cmdAccounts() {
  const { pool } = await bootstrap()
  for (const a of pool.accounts()) {
    console.log(JSON.stringify({
      label: a.label, uid: a.uid, uin: a.uin, region: a.region, domain: a.domain,
      usable: pool.isUsable(a), cooldownMs: Math.max(0, (a.cooldownUntil || 0) - Date.now()),
      sourceFile: a.sourceFile, firstSeenAt: when(a.firstSeenAt),
    }, null, 1))
  }
}

async function cmdCheckin() {
  const target = args[1]
  const { pool, client } = await bootstrap()
  const accounts = pool.accounts().filter((a) => !target || target === 'all' || a.id === target || a.label === target || a.uid === target)
  if (accounts.length === 0) {
    console.log('没有匹配的账号')
    return
  }
  for (const account of accounts) {
    try {
      const status = await client.fetchCheckin(account)
      account.checkin = status
      if (status.todayCheckedIn) {
        console.log(`● ${account.label}：今日已签到（连续 ${status.streakDays} 天，+${status.todayCredit}）`)
        continue
      }
      const claim = await client.claimCheckin(account)
      account.checkin = await client.fetchCheckin(account).catch(() => status)
      if (claim.ok) {
        console.log(`● ${account.label}：签到成功 +${claim.credit ?? 0} 分（连续 ${claim.streakDays ?? '-'} 天）`)
      } else {
        console.log(`● ${account.label}：签到失败 —— ${claim.message}`)
      }
    } catch (error) {
      console.log(`● ${account.label}：签到出错 —— ${String(error.message || error)}`)
    }
  }
  pool.persist()
}

async function cmdCredits() {
  const { pool, client } = await bootstrap()
  for (const account of pool.accounts()) {
    try {
      const credits = await client.fetchCredits(account)
      console.log(`● ${account.label}：合计 ${credits.total} 分，${credits.packages.length} 个积分包`)
      for (const p of credits.packages.slice(0, 8)) {
        console.log(`    ${p.name}  ${p.remain}/${p.size}${p.expiresAt ? `  到期 ${when(p.expiresAt)}` : ''}`)
      }
      if (credits.packages.length > 8) console.log(`    ...另有 ${credits.packages.length - 8} 个`)
    } catch (error) {
      console.log(`● ${account.label}：读取失败 —— ${String(error.message || error)}`)
    }
  }
  pool.persist()
}

async function cmdDoctor() {
  console.log('=== wbpool 诊断 ===')
  console.log(`数据目录：${PATHS.home}`)

  const exes = appExecutableCandidates()
  console.log(`\n桌面端可执行文件：${exes.length === 0 ? '未找到 ✗' : '✓'}`)
  for (const e of exes) console.log(`  ${e}`)

  console.log('\nauth 目录：')
  for (const dir of authDirs()) {
    console.log(`  ${existsSync(dir) ? '✓' : '✗'} ${dir}`)
  }

  const { config, pool, client } = await bootstrap({ quiet: true })
  const scan = await pool.scan()
  console.log(`\n扫描：发现 ${scan.found} 个凭据，新增 ${scan.added}，池内 ${scan.total}`)
  for (const err of scan.errors) console.log(`  ! ${err}`)

  for (const account of pool.accounts()) {
    process.stdout.write(`\n账号 ${account.label}：`)
    try {
      const credits = await client.fetchCredits(account)
      process.stdout.write(` 积分 ${credits.total}`)
    } catch (error) {
      process.stdout.write(` 积分读取失败(${String(error.message || error).slice(0, 60)})`)
    }
    try {
      const models = await client.fetchModels(account, { force: true })
      process.stdout.write(` | 模型目录 ${models.length} 个`)
    } catch (error) {
      process.stdout.write(` | 目录失败(${String(error.message || error).slice(0, 60)})`)
    }
    try {
      const checkin = await client.fetchCheckin(account)
      process.stdout.write(` | 签到连续 ${checkin.streakDays} 天`)
    } catch (error) {
      process.stdout.write(` | 签到读取失败`)
    }
    console.log()
  }

  const third = activeProviders(config)
  console.log(`\n第三方渠道：${third.length} 家启用 / 注册表 ${loadRegistry().length} 家`)
  console.log(`网关端口：${config.port}    默认模型：${config.defaultModel || 'auto'}`)
}

/** WorkBuddy 自定义模型注册表位置。 */
function workbuddyModelsPath() {
  const home = process.env.WORKBUDDY_HOME || join(homedir(), '.workbuddy')
  return join(home, 'models.json')
}

function install() {
  const config = loadConfig()
  // --remote：把地址指向云端（读 data/remote.json）
  const remote = args.includes('--remote') ? readRemote() : null
  const path = workbuddyModelsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let existing = []
  if (existsSync(path)) {
    copyFileSync(path, `${path}.wbpool-backup-${Date.now()}`)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      existing = Array.isArray(parsed) ? parsed : []
    } catch {
      existing = []
    }
  }

  const url = remote
    ? `${remote.baseUrl}/v1/chat/completions`
    : `http://127.0.0.1:${config.port}/v1/chat/completions`
  const entry = {
    id: 'wbpool',
    name: remote ? 'WB Pool · 云端多账号池' : 'WB Pool · 多账号池',
    vendor: 'WB Pool',
    url,
    apiKey: remote ? remote.gatewayKey : config.gatewayKey,
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
    // WorkBuddy 只有拿到 contextWindow.supportedLengths（>=2 档）才会在模型详情里
    // 把「上下文窗口」渲染成可切换的子菜单；缺这个字段就只剩「思考强度」。
    //
    // 但档位不能给太大：maxInputTokens 同时是「上下文用到多少该自动压缩」的基准，
    // 设到 1M 会让超长会话永远不压缩，几 MB 历史整包推给 renderer，界面一直转圈。
    contextWindow: {
      supportedLengths: [64000, 128000, 256000],
      defaultLength: 128000,
    },
    reasoning: { defaultEffort: 'high', supportedEfforts: ['high', 'max'] },
  }

  const kept = existing.filter((m) => m && m.id !== 'wbpool')
  kept.push(entry)
  writeFileSync(path, JSON.stringify(kept, null, 2), 'utf8')

  console.log(`已注册到 ${path}`)
  console.log(`  模型名：${entry.name}`)
  console.log(`  端点：${url}`)
  if (existing.length !== kept.length - 1) {
    console.log(`  （原有 ${existing.length} 个模型保留，只替换了 wbpool 这一条）`)
  }
  if (remote) {
    console.log('\n已指向云端。WorkBuddy 模型选择器里选「WB Pool · 云端多账号池」即可。')
    console.log('云端常驻，不需要在本机开网关。')
  } else {
    console.log('\n下一步：先 `node src/cli.mjs serve` 起网关，再在 WorkBuddy 模型选择器里选「WB Pool · 多账号池」。')
  }
}

function uninstall() {
  const path = workbuddyModelsPath()
  if (!existsSync(path)) {
    console.log('没有 models.json')
    return
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : []
  const kept = list.filter((m) => m && m.id !== 'wbpool')
  copyFileSync(path, `${path}.wbpool-backup-${Date.now()}`)
  writeFileSync(path, JSON.stringify(kept, null, 2), 'utf8')
  console.log(`已从 ${path} 摘掉 wbpool（${list.length - kept.length} 条）`)
}

async function cmdTest() {
  const prompt = args.slice(1).filter((a) => !a.startsWith('--')).join(' ') || '只回复两个字：你好'
  const { config, pool, client } = await bootstrap({ quiet: true })
  const account = pool.pick({})
  if (!account) {
    console.log('池里没有可用账号')
    return
  }
  const model = args.includes('--model') ? flag('model', config.defaultModel || 'auto') : (config.defaultModel || 'auto')
  console.log(`用 ${account.label} 请求模型 ${model} ...`)
  const body = JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: prompt }] })
  const { prepareChatBody } = await import('./core/upstream.mjs')
  const prepared = prepareChatBody(body)
  const result = await client.chatStream(account, prepared, { conversationKey: 'cli-test' })
  if (!result.ok) {
    console.log(`失败(${result.kind} ${result.status})：${String(result.message).slice(0, 400)}`)
    return
  }
  const reader = result.response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let credit
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const frame = JSON.parse(payload)
        const delta = frame.choices?.[0]?.delta
        if (delta?.content) text += delta.content
        if (frame.usage?.credit !== undefined) credit = frame.usage.credit
      } catch { /* 跳过 */ }
    }
  }
  console.log(`回复：${text}`)
  if (credit !== undefined) console.log(`本次消耗积分：${credit}`)
  pool.markSuccess(account)
  pool.persist()
}

/** 云端部署信息（部署时生成，含访问密码与同步密钥）。 */
function readRemote() {
  const path = join(__dirname, '..', 'data', 'remote.json')
  const remote = readJson(path, null)
  if (!remote) {
    console.log('没有找到 data/remote.json —— 还没部署过云端。先跑 node tools/deploy-cloud.mjs')
    return null
  }
  return remote
}

/**
 * 把本机解密出来的凭据推到云端。
 *
 * 云端没有 WorkBuddy 桌面端，解不开凭据，所以账号必须由本机推上去。
 * 每次跑都会覆盖同 id 账号的令牌与有效期，桌面端重新登录后再推一次即可。
 */
async function cmdSync() {
  const remote = readRemote()
  if (!remote) return
  const { pool, client } = await bootstrap({ quiet: true })
  const accounts = pool.accounts()
  if (accounts.length === 0) {
    console.log('本机没有扫到任何 WorkBuddy 账号。请先打开 WorkBuddy 桌面端登录。')
    return
  }

  // 顺手刷一次有效期最准的积分，云端看板一进来就有数
  for (const account of accounts) {
    try { await client.fetchCredits(account) } catch { /* 单个失败不影响同步 */ }
  }

  const payload = {
    accounts: accounts.map((a) => ({
      id: a.id,
      uid: a.uid,
      uin: a.uin,
      label: a.label,
      domain: a.domain,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      refreshExpiresAt: a.refreshExpiresAt,
      credits: a.credits,
    })),
  }

  console.log(`推送 ${accounts.length} 个账号到 ${remote.baseUrl} ...`)
  try {
    const res = await fetch(`${remote.baseUrl}/api/sync-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': remote.syncSecret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    })
    const data = await res.json()
    if (!res.ok || data.ok === false) {
      console.log(`同步失败（HTTP ${res.status}）：${data.error ?? JSON.stringify(data).slice(0, 200)}`)
      return
    }
    console.log(`同步完成：新增 ${data.added}，更新 ${data.updated}，云端池内 ${data.total} 个账号`)
    if (data.expired > 0) console.log(`  注意：其中 ${data.expired} 个令牌已过期，请在桌面端重新登录后再同步`)
    for (const a of accounts) {
      console.log(`  · ${a.label}  令牌到期 ${a.expiresAt ? new Date(a.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`)
    }
  } catch (error) {
    console.log(`同步请求失败：${String(error.message || error)}`)
  }
}

/** 查云端池状态。 */
async function cmdRemote() {
  const remote = readRemote()
  if (!remote) return
  const auth = 'Basic ' + Buffer.from(`:${remote.password}`).toString('base64')  // 用户名不校验
  const url = `${remote.baseUrl}/api/status`
  try {
    const res = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30000) })
    if (res.status === 401) {
      console.log('云端拒绝了密码：data/remote.json 里的凭证可能已过期，重新部署一次即可')
      return
    }
    const d = await res.json()
    console.log(`
云端 ${remote.baseUrl}`)
    console.log(`  池：${d.pool.total} 个账号，${d.pool.usable} 可用，${d.pool.cooling} 冷却（策略 ${d.pool.distribution}）`)
    for (const a of d.accounts) {
      const cool = a.cooldownMs > 0 ? `冷却 ${Math.round(a.cooldownMs / 1000)}s(${a.cooldownReason})` : '可用'
      console.log(`  · ${a.label}  ${cool}  积分 ${a.credits?.total ?? '-'}  请求 ${a.requestCount}`)
    }
    console.log(`  今日：${d.stats.today.calls} 次调用 / ${d.stats.today.credit} 积分`)
    const auto = d.automation ?? {}
    console.log(`  自动化：每日 ${auto.checkinAt} 签到${auto.today?.checkin ? '（今日已跑）' : '（今日未跑）'}`)
    console.log(`  第三方渠道：${d.providers.length} 家`)
  } catch (error) {
    console.log(`连不上云端：${String(error.message || error)}`)
  }
}

async function cmdServe() {
  const { config, pool, client, stats } = await bootstrap()
  const port = Number(flag('port', config.port))
  const { startAutomation } = await import('./automation.mjs')
  const automation = startAutomation({ config, pool, client, stats })

  const { server } = createGateway({
    config, pool, client, stats, uiDir: UI_DIR,
    runAutomation: (kind) => automation.runNow(kind),
  })

  server.listen(port, config.host, () => {
    console.log(`\nwbpool 网关已启动： http://${config.host}:${port}`)
    console.log(`  OpenAI 端点   http://${config.host}:${port}/v1/chat/completions`)
    console.log(`  控制台        http://${config.host}:${port}/`)
    const usable = pool.usable()
    console.log(`  池：${pool.accounts().length} 个账号，${usable.length} 个可用`)
    console.log(`  自动化：${config.automation?.enabled ? `每 ${config.automation.checkinAt} 签到` : '关闭'}\n`)

    // 预热：进控制台就能看到积分与签到状态，不用先手点「刷新积分」
    setTimeout(() => {
      ;(async () => {
        for (const account of pool.accounts()) {
          try { await client.fetchCredits(account) } catch { /* 单独账号失败不影响其它 */ }
          try { account.checkin = await client.fetchCheckin(account) } catch { /* 同上 */ }
        }
        pool.persist()
        console.log(`  预热完成：${pool.accounts().length} 个账号的积分与签到状态已就绪`)
      })().catch(() => {})
    }, 1500).unref()
  })

  const shutdown = () => {
    console.log('\n正在停止...')
    automation?.stop?.()
    stats.flush()
    pool.persist()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

const handlers = {
  serve: cmdServe,
  status: cmdStatus,
  accounts: cmdAccounts,
  checkin: cmdCheckin,
  credits: cmdCredits,
  doctor: cmdDoctor,
  install,
  uninstall,
  test: cmdTest,
  sync: cmdSync,
  remote: cmdRemote,
}

const handler = handlers[command]
if (!handler) {
  console.log(`未知命令：${command}`)
  console.log('可用：serve | status | accounts | checkin | credits | doctor | install | uninstall | test | sync | remote')
  process.exit(1)
}

Promise.resolve()
  .then(() => handler())
  .catch((error) => {
    log('命令失败', String(error?.stack || error))
    console.error(String(error?.stack || error))
    process.exit(1)
  })
