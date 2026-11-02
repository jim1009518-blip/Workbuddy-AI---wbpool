/**
 * 积分自动化。
 *
 * 每天要手动点一遍的活儿（签到、领补偿），这里按本地时点在后台做掉：
 *   - checkinAt   逐个账号签到
 *   - rewardsAt   查并领取服务中断补偿
 *
 * 设计取舍：
 *   - 每天只跑一次，成功与否都记在 automation.json 里，避免重复请求上游
 *     （签到接口在重复调用时会报「已签到」，虽然幂等，但没必要天天撞）
 *   - 用一个 60 秒的心跳做时点判断，而不是给每个任务挂长定时器：这样进程
 *     休眠 / 睡眠唤醒后也能补上，跨天不会漏
 *   - 启动后先补跑一次：机器整天没开机时，开机就能把当天的补上
 */

import { PATHS, readJson, writeJson, log } from './core/config.mjs'

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 当前本地时间 HH:MM。 */
function hhmm(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}`
}

function parseHHMM(value, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''))
  if (!m) return fallback
  const h = Math.min(23, Math.max(0, Number(m[1])))
  const min = Math.min(59, Math.max(0, Number(m[2])))
  return h * 60 + min
}

export function startAutomation({ config, pool, client, stats }) {
  const settings = config.automation ?? {}
  if (settings.enabled === false) {
    log('积分自动化已关闭')
    return { stop() {}, runNow: async () => ({ ok: false, message: '已关闭' }), status: () => ({ enabled: false }) }
  }

  const store = readJson(PATHS.automation, { version: 1, days: {} })
  if (!store.days) store.days = {}
  let stopped = false

  function dayBucket(date = today()) {
    if (!store.days[date]) store.days[date] = { date, checkin: null, rewards: null }
    return store.days[date]
  }

  function persist() {
    // 只留 90 天
    const dates = Object.keys(store.days).sort()
    while (dates.length > 90) delete store.days[dates.shift()]
    writeJson(PATHS.automation, store)
  }

  /** 逐个账号签到。 */
  async function runCheckin({ trigger = 'schedule' } = {}) {
    const bucket = dayBucket()
    const results = []
    let gained = 0
    for (const account of pool.accounts()) {
      try {
        const status = await client.fetchCheckin(account)
        account.checkin = status
        if (status.todayCheckedIn) {
          results.push({ id: account.id, label: account.label, already: true, credit: 0, streakDays: status.streakDays })
          continue
        }
        const claim = await client.claimCheckin(account)
        const fresh = await client.fetchCheckin(account).catch(() => status)
        account.checkin = fresh
        if (claim.ok) {
          gained += claim.credit ?? 0
          results.push({ id: account.id, label: account.label, ok: true, credit: claim.credit ?? 0, streakDays: claim.streakDays ?? fresh.streakDays })
        } else {
          results.push({ id: account.id, label: account.label, ok: false, message: claim.message })
        }
      } catch (error) {
        results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
      }
    }
    pool.persist()
    bucket.checkin = { at: Date.now(), trigger, results, credit: gained }
    persist()
    log(`签到完成：${results.length} 个账号，共 +${gained} 分`)
    return { ok: true, credit: gained, results }
  }

  /** 领取服务中断补偿（多数时候是空操作，活动期才有）。 */
  async function runRewards({ trigger = 'schedule' } = {}) {
    const bucket = dayBucket()
    const results = []
    let gained = 0
    for (const account of pool.accounts()) {
      try {
        const status = await client.fetchCompensation(account)
        if (!status.active) {
          results.push({ id: account.id, label: account.label, active: false })
          continue
        }
        const claim = await client.claimCompensation(account)
        if (claim.ok && !claim.empty) {
          gained += claim.credit ?? 0
          results.push({ id: account.id, label: account.label, ok: true, credit: claim.credit ?? 0 })
        } else {
          results.push({ id: account.id, label: account.label, ok: true, empty: true })
        }
      } catch (error) {
        results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
      }
    }
    bucket.rewards = { at: Date.now(), trigger, results, credit: gained }
    persist()
    log(`补偿检查完成：+${gained} 分`)
    return { ok: true, credit: gained, results }
  }

  /**
   * 领取成长任务奖励。
   *
   * 只做「可领取」的那部分：进度到位且没领过。任务进度靠真实使用行为点亮
   * （用专家、开模板、对话），后台无法伪造，也不该伪造 —— 这里只是把该点的
   * 那一下「领取」替你做掉。
   */
  async function runTasks({ trigger = 'schedule' } = {}) {
    const bucket = dayBucket()
    const results = []
    let gained = 0
    let claimableCount = 0
    for (const account of pool.accounts()) {
      try {
        const tasks = await client.listTasks(account)
        const claimable = tasks.filter((t) => t.claimable)
        claimableCount += claimable.length
        for (const task of claimable) {
          try {
            const r = await client.claimTaskReward(account, task.taskCode)
            if (!r.already) gained += r.credit ?? 0
            results.push({
              id: account.id, label: account.label, task: task.taskCode,
              title: task.title, credit: r.credit ?? 0, already: r.already === true,
            })
          } catch (error) {
            results.push({ id: account.id, label: account.label, task: task.taskCode, ok: false, message: String(error.message || error) })
          }
        }
        results.push({ id: account.id, label: account.label, summary: true, total: tasks.length, claimable: claimable.length })
      } catch (error) {
        results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
      }
    }
    bucket.tasks = { at: Date.now(), trigger, results, credit: gained, claimable: claimableCount }
    persist()
    log(`任务奖励：可领 ${claimableCount} 个，共 +${gained} 分`)
    return { ok: true, credit: gained, claimable: claimableCount, results }
  }

  const checkinMinute = parseHHMM(settings.checkinAt, 9 * 60 + 10)
  const rewardsMinute = parseHHMM(settings.rewardsAt, 9 * 60 + 20)

  function minutesNow() {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  }

  async function tick({ force = false } = {}) {
    if (stopped) return
    const bucket = dayBucket()
    const now = minutesNow()
    // 到点且今天还没跑过
    if ((force || now >= checkinMinute) && !bucket.checkin) {
      await runCheckin({ trigger: force ? 'manual' : 'schedule' }).catch((e) => log('签到失败', String(e)))
    }
    if ((force || now >= rewardsMinute) && !bucket.rewards) {
      await runRewards({ trigger: force ? 'manual' : 'schedule' }).catch((e) => log('补偿失败', String(e)))
    }
    if ((force || now >= rewardsMinute) && !bucket.tasks) {
      await runTasks({ trigger: force ? 'manual' : 'schedule' }).catch((e) => log('任务奖励失败', String(e)))
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  /**
   * 启动补跑。
   *
   * 这里**不看时点**：机器整天没开机、或者凌晨才启动时，「现在还没到 09:10」
   * 正是最需要补跑的场景。只要今天还没跑过就直接做掉，跑过就跳过。
   */
  async function catchUp() {
    if (stopped) return
    const bucket = dayBucket()
    if (!bucket.checkin) {
      await runCheckin({ trigger: 'startup' }).catch((e) => log('启动补跑签到失败', String(e)))
    }
    if (!bucket.rewards) {
      await runRewards({ trigger: 'startup' }).catch((e) => log('启动补跑补偿失败', String(e)))
    }
    if (!bucket.tasks) {
      await runTasks({ trigger: 'startup' }).catch((e) => log('启动补跑任务奖励失败', String(e)))
    }
  }

  // 启动后补跑：等账号扫描与令牌续期稳定一下再动
  if (settings.runOnStart !== false) {
    const boot = setTimeout(() => { catchUp().catch(() => {}) }, 6000)
    if (typeof boot.unref === 'function') boot.unref()
  }

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
    runNow: async (kind = 'all') => {
      if (kind === 'checkin') return runCheckin({ trigger: 'manual' })
      if (kind === 'rewards') return runRewards({ trigger: 'manual' })
      if (kind === 'tasks') return runTasks({ trigger: 'manual' })
      const a = await runCheckin({ trigger: 'manual' })
      const b = await runRewards({ trigger: 'manual' })
      const c = await runTasks({ trigger: 'manual' })
      return { ok: true, credit: a.credit + b.credit + c.credit, checkin: a, rewards: b, tasks: c }
    },
    status: () => ({
      enabled: true,
      checkinAt: settings.checkinAt,
      rewardsAt: settings.rewardsAt,
      today: dayBucket(),
      recent: Object.keys(store.days).sort().slice(-14).map((d) => store.days[d]),
    }),
  }
}
