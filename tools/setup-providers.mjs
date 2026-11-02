/**
 * 用 key.txt 里现成的 Key 配聚合渠道，并逐个实测。
 * 只写云端配置，不打印完整 Key。
 */
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('data/remote.json', 'utf8'))
const keyText = readFileSync('C:/Users/Administrator/Desktop/key/key.txt', 'utf8')

function pick(label) {
  const re = new RegExp(label + '\\s*\\n\\s*(sk-[^\\s]+)', 'im')
  const m = re.exec(keyText)
  return m ? m[1].trim() : ''
}

const deepseekKey = pick('^deepseek')
const bailianKey = pick('阿里百炼')
console.log('DeepSeek key:', deepseekKey ? deepseekKey.slice(0, 10) + '…' : '(未找到)')
console.log('百炼 key    :', bailianKey ? bailianKey.slice(0, 12) + '…' : '(未找到)')

const login = await fetch(c.baseUrl + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: c.password }),
})
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
const H = { Cookie: cookie, 'Content-Type': 'application/json' }

// 待配列表：id 用注册表里的 id
const targets = []
if (deepseekKey) {
  targets.push({ id: 'deepseek', apiKey: deepseekKey, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' })
}
if (bailianKey) {
  // 百炼国内端点；国际账号要把 baseUrl 换成 dashscope-intl
  targets.push({ id: 'alibaba_cloud', apiKey: bailianKey, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' })
}

for (const t of targets) {
  console.log(`\n=== 配置 ${t.id} ===`)
  const save = await fetch(c.baseUrl + '/api/providers', {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: t.id, apiKey: t.apiKey, enabled: true, baseUrl: t.baseUrl }),
  })
  const sd = await save.json()
  console.log('  保存:', save.status, sd.ok ? 'ok' : JSON.stringify(sd).slice(0, 150))

  const test = await fetch(c.baseUrl + '/api/providers/test', {
    method: 'POST', headers: H,
    body: JSON.stringify({ id: t.id, model: t.model }),
  })
  const td = await test.json()
  console.log('  测试:', td.ok ? `通了 ${td.ms}ms` : `失败 ${String(td.error).slice(0, 160)}`)
}

// 回读最终状态
const list = await (await fetch(c.baseUrl + '/api/providers', { headers: H })).json()
console.log('\n=== 已启用渠道 ===')
for (const p of list.providers.filter((x) => x.enabled)) {
  console.log(`  ${p.id}  ${p.name}  key=${p.hasKey ? '✓' : '✗'}  ${p.baseUrl}`)
}
