/** 验证六页所需接口。 */
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('data/remote.json', 'utf8'))
const base = c.baseUrl

let pass = 0, fail = 0
const check = (n, ok, extra = '') => { if (ok) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n} ${extra}`) } }

// 登录拿 cookie
const login = await fetch(base + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: c.password }),
})
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
const H = { Cookie: cookie, 'Content-Type': 'application/json' }
check('登录成功', login.status === 200 && cookie.startsWith('wbpool_session='))

// 聚合渠道
const pv = await fetch(base + '/api/providers', { headers: H })
const pvd = await pv.json()
check('聚合渠道读取', pv.status === 200 && Array.isArray(pvd.providers))
check(`渠道数量 ${pvd.total}（应为 76 家）`, pvd.total === 76, `实际 ${pvd.total}`)
const first = pvd.providers?.[0]
check('渠道结构完整', first && 'id' in first && 'baseUrl' in first && 'models' in first && 'enabled' in first, JSON.stringify(first ?? {}).slice(0, 120))

// 启用一个不需要真 key 的渠道做配置读写（用 temp 自定义 key）
const setRes = await fetch(base + '/api/providers', {
  method: 'POST', headers: H,
  body: JSON.stringify({ id: first.id, apiKey: 'test-key-not-real', enabled: true }),
})
check('渠道配置写入', setRes.status === 200)
const pv2 = await (await fetch(base + '/api/providers', { headers: H })).json()
const saved = pv2.providers.find((x) => x.id === first.id)
check('渠道配置持久化', saved?.hasKey === true && saved?.enabled === true)
// 还原，避免脏数据
await fetch(base + '/api/providers', { method: 'POST', headers: H, body: JSON.stringify({ id: first.id, enabled: false }) })

// 路由
const rtGet = await fetch(base + '/api/routes', { headers: H })
const rt0 = await rtGet.json()
check('路由读取', rtGet.status === 200 && Array.isArray(rt0.routes))

const rtSet = await fetch(base + '/api/routes', {
  method: 'POST', headers: H,
  body: JSON.stringify({ routes: [{ id: 'fast', name: '快速链', strategy: 'sequential', models: ['wbpool/hy3', 'wbpool/auto'] }] }),
})
const rt1 = await rtSet.json()
check('路由写入', rtSet.status === 200 && rt1.routes?.[0]?.id === 'fast')
check('路由模型链正确', rt1.routes?.[0]?.models?.length === 2, JSON.stringify(rt1.routes?.[0] ?? {}))

// 网关信息
const gw = await fetch(base + '/api/gateway', { headers: H })
const gwd = await gw.json()
check('网关信息', gw.status === 200 && typeof gwd.gatewayKey === 'string' && gwd.modelCount > 0)
check('网关含路由', Array.isArray(gwd.routes) && gwd.routes.some((r) => r.id === 'fast'))

// 模型列表里应能看到路由与上游模型
const models = await (await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + c.gatewayKey } })).json()
check('模型列表非空', Array.isArray(models.data) && models.data.length > 0, `实际 ${models.data?.length}`)
check('含 wbpool 模型', models.data.some((m) => m.id.startsWith('wbpool/')))

// 导入接口的错误处理
const badImp = await fetch(base + '/api/accounts/import', { method: 'POST', headers: H, body: JSON.stringify({ raw: 'not json' }) })
check('导入非法内容 -> 400', badImp.status === 400, `实际 ${badImp.status}`)
const badImp2 = await fetch(base + '/api/accounts/import', { method: 'POST', headers: H, body: JSON.stringify({ raw: '{}' }) })
check('导入缺 token -> 400', badImp2.status === 400, `实际 ${badImp2.status}`)

// 清理测试路由
await fetch(base + '/api/routes', { method: 'POST', headers: H, body: JSON.stringify({ routes: [] }) })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
