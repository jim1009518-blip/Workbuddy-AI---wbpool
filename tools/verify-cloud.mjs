/** 公网侧验收：鉴权、状态、对话。 */
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('data/remote.json', 'utf8'))
const base = c.baseUrl
const auth = 'Basic ' + Buffer.from(`:${c.password}`).toString('base64')  // 用户名不校验，留空即可

async function probe(path, opts = {}) {
  try {
    const res = await fetch(base + path, { ...opts, signal: AbortSignal.timeout(45000) })
    const text = await res.text()
    return { status: res.status, text }
  } catch (error) {
    return { status: 0, text: `ERR ${error.message} ${error.cause?.message ?? ''}` }
  }
}

const health = await probe('/healthz')
console.log(`无密码 /healthz      -> ${health.status} ${health.text.slice(0, 120)}`)

const anon = await probe('/api/status')
console.log(`无密码 /api/status   -> ${anon.status} ${anon.text.slice(0, 80)}`)

const st = await probe('/api/status', { headers: { Authorization: auth } })
console.log(`带密码 /api/status   -> ${st.status}`)
if (st.status === 200) {
  const d = JSON.parse(st.text)
  console.log(`  池：${d.pool.total} 个账号 / ${d.pool.usable} 可用 | 今日 ${d.stats.today.calls} 次调用`)
}

const home = await probe('/', { headers: { Authorization: auth } })
console.log(`带密码 /             -> ${home.status}  ${home.text.length} 字节`)

// 对话（此时池里还没账号，预期报错；主要验证端点可达且鉴权通过）
const chat = await probe('/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'wbpool', stream: false, messages: [{ role: 'user', content: 'hi' }] }),
})
console.log(`/v1/chat/completions -> ${chat.status} ${chat.text.slice(0, 200)}`)
