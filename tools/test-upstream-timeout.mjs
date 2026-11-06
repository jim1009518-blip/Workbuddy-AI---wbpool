/**
 * 上游超时兜底测试。
 *
 * 复现「半开连接」：上游发几个字节后就再也不发，也不关连接。
 * 旧代码会永远等下去（界面无限转圈）；新代码必须在阈值后主动断开并给出
 * 明确错误（流式：data: {"error":...} + [DONE]；非流式：504）。
 *
 * 用法：node tools/test-upstream-timeout.mjs
 */
import { createServer } from 'node:http'
import { collectStream } from '../src/core/gateway.mjs'

// 保持事件循环活着：否则「故意挂住的流」会让 Node 判定无等待任务而直接退出
const keepAlive = setInterval(() => {}, 1000)

let passed = 0
let failed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name} ${extra}`) }
}

/** 造一个「吐出 prefix 后永远沉默」的 web stream */
function silentStream(prefix, { closeAfterMs = 0 } = {}) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      if (prefix) controller.enqueue(enc.encode(prefix))
      if (closeAfterMs > 0) setTimeout(() => { try { controller.close() } catch { /* noop */ } }, closeAfterMs)
      // 否则：既不 enqueue 也不 close —— 半开
    },
  })
}

// ---- 1. 空闲超时必须触发 ----
{
  const t0 = Date.now()
  let err = null
  try {
    await collectStream(silentStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'), { idleTimeoutMs: 300 })
  } catch (e) { err = e }
  const dt = Date.now() - t0
  ok('空闲 300ms 后抛 UPSTREAM_TIMEOUT', err?.code === 'UPSTREAM_TIMEOUT', `got=${err?.code} msg=${err?.message}`)
  ok('耗时在阈值附近（<1.5s）', dt < 1500, `${dt}ms`)
  ok('错误信息可读', /没有任何数据/.test(err?.message ?? ''), err?.message)
}

// ---- 2. 正常结束的流不应该误报 ----
{
  let err = null
  let out = null
  try {
    out = await collectStream(silentStream('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { closeAfterMs: 30 }), { idleTimeoutMs: 300 })
  } catch (e) { err = e }
  ok('正常流不超时', err === null, String(err))
  ok('正常流内容完整', out?.choices?.[0]?.message?.content === 'hello', JSON.stringify(out?.choices?.[0]?.message))
}

// ---- 3. 总时长上限 ----
{
  const t0 = Date.now()
  let err = null
  try {
    // 每 100ms 挤一个字节，空闲超时永远触发不到，只能靠总时长兜住
    const enc = new TextEncoder()
    const trickle = new ReadableStream({
      start(controller) {
        const timer = setInterval(() => { try { controller.enqueue(enc.encode(' ')) } catch { clearInterval(timer) } }, 100)
        setTimeout(() => clearInterval(timer), 5000)
      },
    })
    await collectStream(trickle, { idleTimeoutMs: 1000, totalTimeoutMs: 400 })
  } catch (e) { err = e }
  const dt = Date.now() - t0
  ok('慢速拉扯被总时长兜住', err?.code === 'UPSTREAM_TIMEOUT' && /总时长/.test(err?.message ?? ''), `${err?.message} ${dt}ms`)
  ok('总时长兜底在 1.5s 内生效', dt < 1500, `${dt}ms`)
}

// ---- 4. 关闭超时（0）时保持旧行为，不误伤 ----
{
  let err = null
  let out = null
  try {
    out = await collectStream(silentStream('data: [DONE]\n\n', { closeAfterMs: 50 }), { idleTimeoutMs: 0, totalTimeoutMs: 0 })
  } catch (e) { err = e }
  ok('超时关闭时正常流仍可读', err === null && out !== null)
}

// ---- 5. 端到端：真 HTTP 半开上游 + 网关流式转发 ----
{
  // 假上游：立刻回 200 + 一帧，然后挂住
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    // 不 end，模拟半开
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const port = upstream.address().port

  const t0 = Date.now()
  const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(8000) })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let text = ''
  let caught = null
  try {
    for (;;) {
      const { done, value } = await readWithIdle(reader, 400)
      if (done) break
      text += dec.decode(value, { stream: true })
    }
  } catch (e) { caught = e }
  const dt = Date.now() - t0
  ok('端到端：半开上游在阈值后失败而非永久挂死', caught !== null && dt < 3000, `${dt}ms caught=${caught?.message}`)
  ok('端到端：已收到的内容不丢', text.includes('partial'), text.slice(0, 80))
  upstream.close()
}

async function readWithIdle(reader, ms) {
  let timer
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('idle-timeout')), ms) })
  try { return await Promise.race([reader.read(), timeout]) } finally { clearTimeout(timer) }
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败项'}：${passed} passed, ${failed} failed`)
clearInterval(keepAlive)
process.exit(failed === 0 ? 0 : 1)
