/** 验证「只填密码」的登录流程。 */
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('data/remote.json', 'utf8'))
const base = c.baseUrl

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// 1) 未登录访问状态接口
const anon = await fetch(base + '/api/status')
check('未登录 /api/status -> 401', anon.status === 401, `实际 ${anon.status}`)

// 2) 未登录访问首页 -> 应跳到登录页
const home = await fetch(base + '/', { redirect: 'manual' })
check('未登录 / -> 302 跳登录', home.status === 302, `实际 ${home.status}`)
const loc = home.headers.get('location') ?? ''
check('跳转目标是 login', loc.includes('login'), loc)

// 3) 登录页可访问
const loginPage = await fetch(base + '/login')
const loginHtml = await loginPage.text()
check('登录页 200', loginPage.status === 200, `实际 ${loginPage.status}`)
check('登录页只有密码框', loginHtml.includes('type="password"') && !loginHtml.includes('用户名'))
check('登录页没有用户名输入', !/name=["']user/i.test(loginHtml))

// 4) 错误密码
const wrong = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: '000000' }),
})
check('错误密码 -> 401', wrong.status === 401, `实际 ${wrong.status}`)

// 5) 正确密码
const right = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: c.password }),
})
const setCookie = right.headers.get('set-cookie') ?? ''
check('正确密码 -> 200', right.status === 200, `实际 ${right.status}`)
check('下发了会话 cookie', setCookie.includes('wbpool_session='), setCookie.slice(0, 60))
check('cookie 是 HttpOnly', setCookie.toLowerCase().includes('httponly'))

// 6) 带 cookie 访问
const cookie = setCookie.split(';')[0]
const withCookie = await fetch(base + '/api/status', { headers: { Cookie: cookie } })
check('带 cookie /api/status -> 200', withCookie.status === 200, `实际 ${withCookie.status}`)

// 7) 伪造 cookie 应当被拒
const forged = await fetch(base + '/api/status', { headers: { Cookie: 'wbpool_session=9999999999999.deadbeef' } })
check('伪造 cookie -> 401', forged.status === 401, `实际 ${forged.status}`)

// 8) Bearer 方式（WorkBuddy 用）
const bearer = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + c.gatewayKey } })
check('Bearer gatewayKey -> 200', bearer.status === 200, `实际 ${bearer.status}`)

// 9) 密码即 Bearer 也应可用
const bearer2 = await fetch(base + '/api/status', { headers: { Authorization: 'Bearer ' + c.password } })
check('Bearer 密码 -> 200', bearer2.status === 200, `实际 ${bearer2.status}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
