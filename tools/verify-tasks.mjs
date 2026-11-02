import { loadConfig } from '../src/core/config.mjs'
import { AccountPool } from '../src/core/accounts.mjs'
import { WorkBuddyClient } from '../src/core/upstream.mjs'

const config = loadConfig()
const pool = new AccountPool(config)
await pool.scan()
const client = new WorkBuddyClient()
const account = pool.pick({})
if (!account) { console.log('无可用账号'); process.exit(0) }

console.log('账号:', account.label)

try {
  const tasks = await client.listTasks(account)
  console.log(`\n任务数：${tasks.length}`)
  for (const t of tasks) {
    const mark = t.claimable ? '★可领' : t.claimed ? '已领' : `${t.current}/${t.target}`
    console.log(`  [${mark}] ${t.taskCode.padEnd(28)} ${t.title.slice(0, 34).padEnd(36)} ${t.credit}分`)
  }
  const claimable = tasks.filter((t) => t.claimable)
  console.log(`\n可领取：${claimable.length} 个，合计 ${claimable.reduce((s, t) => s + t.credit, 0)} 分`)

  // 只试领第一个，确认领取路径通
  if (claimable.length > 0) {
    const first = claimable[0]
    console.log(`\n试领「${first.title}」(${first.taskCode}) ...`)
    const r = await client.claimTaskReward(account, first.taskCode)
    console.log('结果:', JSON.stringify(r))
  } else {
    console.log('\n当前没有可领取的任务（进度未达成或无奖励）')
  }
} catch (error) {
  console.log('任务接口失败:', String(error.message || error))
}
