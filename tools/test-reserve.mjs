/**
 * 自测：每号留底积分（minCredits）的轮换行为。
 *
 * 用临时 storePath，绝不碰 ~/.wbpool/accounts.json。
 * 跑法：node tools/test-reserve.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool, summarize } from '../src/core/accounts.mjs'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'wbpool-reserve-'))
const storePath = join(dir, 'accounts.json')

/** 造一个能过 isUsable 的账号（token 未过期、无冷却）。 */
const mk = (id, total, firstSeenAt) => ({
  id,
  label: id,
  region: 'cn',
  domain: 'www.workbuddy.cn',
  expiresAt: Date.now() + 86400_000,
  refreshExpiresAt: Date.now() + 86400_000,
  cooldownUntil: 0,
  cooldownReason: '',
  firstSeenAt,
  credits: total === null ? null : { total, packages: [], at: Date.now() },
  checkin: null,
})

/** 全部账号按给定余额铺进池子。 */
function setup(list, config) {
  const pool = new AccountPool({ distribution: 'priority', ...config }, { storePath })
  pool.byId.clear()
  for (const a of list) pool.byId.set(a.id, a)
  return pool
}

try {
  console.log('\n[1] 留底 100：500 分的 A 先用，跌到 100 就换 B')
  {
    const pool = setup([mk('A', 500, 1), mk('B', 500, 2)], { minCredits: 100 })
    ok(pool.pick()?.id === 'A', '第一个请求落在 A（最早入池）')
    pool.get('A').credits.total = 150
    ok(pool.pick()?.id === 'A', 'A 剩 150 > 100，继续用 A')
    pool.get('A').credits.total = 100
    ok(pool.pick()?.id === 'B', 'A 剩 100（= 阈值）→ 自动换到 B')
    ok(pool.get('A').credits.total === 100, 'A 的余额没被烧掉，仍是 100')
  }

  console.log('\n[2] 全部触底：池子视为空，且能报出留底账号数')
  {
    const pool = setup([mk('A', 100, 1), mk('B', 80, 2)], { minCredits: 100 })
    ok(pool.pick() === undefined, '没有可用账号（返回 undefined）')
    ok(pool.heldByReserve() === 2, 'heldByReserve() = 2', String(pool.heldByReserve()))
    ok(pool.usable().length === 0, 'usable() 为空')
    const s = summarize(pool.get('B'), pool.config)
    ok(s.reserveHold === true && s.usable === false, 'summarize 标出 reserveHold')
  }

  console.log('\n[3] minCredits = 0：回到「烧完才换号」')
  {
    const pool = setup([mk('A', 30, 1), mk('B', 500, 2)], { minCredits: 0 })
    ok(pool.pick()?.id === 'A', '阈值 0 时 A（30 分）仍被选中')
    pool.get('A').credits.total = 0
    ok(pool.pick()?.id === 'A', '阈值 0 时 0 分账号仍可用（靠上游 402 兜）')
    ok(pool.heldByReserve() === 0, 'heldByReserve() = 0')
  }

  console.log('\n[4] 积分未知（null）：先让它试，不误杀')
  {
    const pool = setup([mk('A', null, 1), mk('B', 500, 2)], { minCredits: 100 })
    ok(pool.pick()?.id === 'A', '余额未知的 A 仍被选中')
    ok(pool.heldByReserve() === 0, '不把未知余额算作留底')
  }

  console.log('\n[5] 优先用余额多的？不——仍按入池顺序，只是跳过触底号')
  {
    const pool = setup([mk('A', 90, 1), mk('B', 800, 2), mk('C', 700, 3)], { minCredits: 100 })
    ok(pool.pick()?.id === 'B', 'A 触底被跳过，落到 B（最早的非触底号）')
  }

  console.log('\n[6] 上游报 exhaust → 余额记 0，立刻让位')
  {
    const pool = setup([mk('A', 500, 1), mk('B', 500, 2)], { minCredits: 100 })
    pool.markCooldown(pool.get('A'), 'exhaust', 60_000)
    ok(pool.get('A').credits.total === 0, 'exhaust 后 A 余额记 0')
    ok(pool.pick()?.id === 'B', '下一跳直接是 B')
  }

  console.log('\n[7] 冷却 + 留底并存时，summarize 的 usable 为 false')
  {
    const pool = setup([mk('A', 40, 1)], { minCredits: 100 })
    pool.markCooldown(pool.get('A'), 'rate-limit', 30_000)
    const s = summarize(pool.get('A'), pool.config)
    ok(s.usable === false, '冷却中的号不可用')
    ok(s.reserveHold === true, '同时也标着 reserveHold')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
