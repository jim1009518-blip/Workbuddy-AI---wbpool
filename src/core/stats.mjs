/**
 * 用量账本。
 *
 * 按自然日聚合：轮次、调用、失败、换号救回、token、积分消耗。写盘节流到 5 秒
 * 一次，避免每个 SSE 帧都摸一次磁盘；进程退出时强制落盘，不丢当天数据。
 */

import { PATHS, readJson, writeJson } from './config.mjs'

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyDay(date) {
  return {
    date,
    requests: 0,
    calls: 0,
    failures: 0,
    failovers: 0,
    thirdPartyCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    credit: 0,
    byAccount: {},
    byModel: {},
  }
}

export class Stats {
  constructor() {
    const stored = readJson(PATHS.stats, { days: {} })
    this.days = stored.days ?? {}
    this.dirty = false
    this.timer = undefined
  }

  /** 取（或建）某天的桶。 */
  day(date = today()) {
    if (!this.days[date]) this.days[date] = emptyDay(date)
    return this.days[date]
  }

  record(kind, { account, model, inputTokens = 0, outputTokens = 0, credit = 0 } = {}) {
    const day = this.day()
    if (kind === 'request') day.requests++
    else if (kind === 'call') day.calls++
    else if (kind === 'failure') day.failures++
    else if (kind === 'failover') day.failovers++
    else if (kind === 'third-party') day.thirdPartyCalls++
    day.inputTokens += inputTokens
    day.outputTokens += outputTokens
    day.credit += credit
    // usage 是「补记数字」而非一次新调用，不该重复计调用数
    const countsAsCall = kind === 'call' || kind === 'request' || kind === 'third-party'
    if (account) {
      const bucket = day.byAccount[account] ?? { calls: 0, inputTokens: 0, outputTokens: 0, credit: 0 }
      if (countsAsCall) bucket.calls++
      bucket.inputTokens += inputTokens
      bucket.outputTokens += outputTokens
      bucket.credit += credit
      day.byAccount[account] = bucket
    }
    if (model) {
      const bucket = day.byModel[model] ?? { calls: 0, inputTokens: 0, outputTokens: 0, credit: 0 }
      if (countsAsCall) bucket.calls++
      bucket.inputTokens += inputTokens
      bucket.outputTokens += outputTokens
      bucket.credit += credit
      day.byModel[model] = bucket
    }
    this.dirty = true
    this.scheduleFlash()
  }

  scheduleFlash() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 5000)
    // 不阻塞进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  flush() {
    if (!this.dirty) return
    // 只保留最近 60 天
    const dates = Object.keys(this.days).sort()
    while (dates.length > 60) {
      delete this.days[dates.shift()]
    }
    writeJson(PATHS.stats, { version: 1, updatedAt: Date.now(), days: this.days })
    this.dirty = false
  }

  /** 最近 n 天的数组（按日期升序）。 */
  recent(days = 14) {
    const dates = Object.keys(this.days).sort().slice(-days)
    return dates.map((d) => this.days[d])
  }

  totals() {
    const out = emptyDay('total')
    for (const day of Object.values(this.days)) {
      out.requests += day.requests
      out.calls += day.calls
      out.failures += day.failures
      out.failovers += day.failovers
      out.thirdPartyCalls += day.thirdPartyCalls
      out.inputTokens += day.inputTokens
      out.outputTokens += day.outputTokens
      out.credit += day.credit
    }
    return out
  }
}
