/**
 * 池路由自测：用两个仿真账号验证「换号容错」的核心逻辑。
 *
 * 不需要真 token —— at-rest 解析器接受明文字符串字段，所以这里造两份明文
 * 凭据放进临时目录，把 WB_AUTH_DIR 指过去，就能验证：
 *   扫描并入池 / 持久化 / priority 先用完一个 / 冷却后换号 /
 *   round-robin 轮换 / exclude 排除 / sticky 黏号
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../src/core/accounts.mjs'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

function makeAuth(uid, uin, token) {
  return JSON.stringify({
    auth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt: Date.now() + 86400_000,
      refreshExpiresAt: Date.now() + 86400_000 * 10,
      domain: 'www.workbuddy.cn',
    },
    account: { uid, uin, type: 'personal' },
    accounts: [{ uid, uin }],
  })
}

const root = mkdtempSync(join(tmpdir(), 'wbpool-test-'))
// 独立存储：绝不写用户真实的 accounts.json
const storeFile = join(root, 'accounts.json')
const dirA = join(root, 'a')
const dirB = join(root, 'b')
mkdirSync(dirA, { recursive: true })
mkdirSync(dirB, { recursive: true })

// 一次只让一个目录有当前登录（模拟「桌面端同一时间只有一个号」）
writeFileSync(join(dirA, 'workbuddy-desktop.info'), makeAuth('uid-aaa', '111', 'tok-a'), 'utf8')

const baseConfig = {
  distribution: 'priority',
  cooldownMs: 60_000,
  exhaustCooldownMs: 1_800_000,
  credentialDeadCooldownMs: 1_800_000,
  refreshMarginMs: 300_000,
}

console.log('\n=== 1. 单个账号 ===')
process.env.WB_AUTH_DIR = dirA
const pool1 = new AccountPool(baseConfig, { storePath: storeFile })
let scan = await pool1.scan()
check('扫到 1 个账号', scan.total === 1, `实际 ${scan.total}`)
check('账号 id 用了 uid', pool1.accounts()[0]?.id === 'uid-aaa', pool1.accounts()[0]?.id)
check('凭据可用', pool1.pick({})?.id === 'uid-aaa')

console.log('\n=== 2. 换号后两个号都在池里（持久化）===')
writeFileSync(join(dirB, 'workbuddy-desktop.info'), makeAuth('uid-bbb', '222', 'tok-b'), 'utf8')
// 模拟换号：A 目录被清掉，B 目录是新登录的号
rmSync(join(dirA, 'workbuddy-desktop.info'))
process.env.WB_AUTH_DIR = dirB
const pool2 = new AccountPool(baseConfig, { storePath: storeFile })
scan = await pool2.scan()
check('换号后池里仍有 2 个（历史号没丢）', pool2.accounts().length === 2, `实际 ${pool2.accounts().length}`)
check('新号已入池', pool2.accounts().some((a) => a.id === 'uid-bbb'))

console.log('\n=== 3. priority：先用完一个 ===')
const config = { ...baseConfig, distribution: 'priority' }
const pool = new AccountPool(config, { storePath: storeFile })
await pool.scan()
const first = pool.pick({})
const second = pool.pick({})
check('连续两次选到同一个号', first?.id === second?.id, `${first?.id} vs ${second?.id}`)

console.log('\n=== 4. 429 冷却后自动换号 ===')
pool.markCooldown(first, 'rate-limit', 60_000)
const afterCool = pool.pick({})
check('冷却的号被跳过', afterCool?.id !== first?.id, `仍是 ${afterCool?.id}`)
check('可用数变成 1', pool.usable().length === 1, `实际 ${pool.usable().length}`)

console.log('\n=== 5. exclude 排除（网关换号重试用）===')
pool.clearCooldowns()
const tried = new Set()
const p1 = pool.pick({ exclude: tried })
tried.add(p1.id)
const p2 = pool.pick({ exclude: tried })
check('排除后选到另一个号', p2 && p2.id !== p1.id, `${p1?.id} / ${p2?.id}`)
tried.add(p2.id)
const p3 = pool.pick({ exclude: tried })
check('全部排除后返回空', p3 === undefined)

console.log('\n=== 6. round-robin 轮换 ===')
const rrPool = new AccountPool({ ...baseConfig, distribution: 'round-robin' }, { storePath: storeFile })
await rrPool.scan()
rrPool.clearCooldowns()
const seq = [rrPool.pick({})?.id, rrPool.pick({})?.id, rrPool.pick({})?.id]
check('轮换到不同账号', new Set(seq.slice(0, 2)).size === 2, seq.join(' → '))
check('第三轮回到起点', seq[2] === seq[0], seq.join(' → '))

console.log('\n=== 7. sticky 黏号 ===')
const stPool = new AccountPool({ ...baseConfig, distribution: 'sticky' }, { storePath: storeFile })
await stPool.scan()
stPool.clearCooldowns()
const s1 = stPool.pick({ conversationKey: 'conv-x' })
const s2 = stPool.pick({ conversationKey: 'conv-x' })
const s3 = stPool.pick({ conversationKey: 'conv-y' })
check('同一对话固定同一账号', s1?.id === s2?.id, `${s1?.id} vs ${s2?.id}`)
check('新对话换下一个账号', s3?.id !== s1?.id, `${s1?.id} vs ${s3?.id}`)

console.log('\n=== 8. 凭据死号 ===')
const deadPool = new AccountPool({ ...baseConfig, distribution: 'priority' }, { storePath: storeFile })
await deadPool.scan()
deadPool.clearCooldowns()
const victim = deadPool.pick({})
deadPool.markCooldown(victim, 'dead', 1_800_000)
check('死号长期冷却', deadPool.cooldownOf(victim) > 1_700_000)
check('自动落到健康号', deadPool.pick({})?.id !== victim.id)

rmSync(root, { recursive: true, force: true })
delete process.env.WB_AUTH_DIR

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
