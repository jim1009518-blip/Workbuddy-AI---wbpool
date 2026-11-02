/**
 * 本地 OpenAI 兼容网关。
 *
 * 这是「把额度接进 WorkBuddy」的唯一入口：WorkBuddy 的自定义模型（models.json）
 * 指向 http://127.0.0.1:<port>/v1/chat/completions，网关在内部完成
 *
 *   1. 优先用 WorkBuddy 账号池（按 distribution 选号）
 *   2. 429 / 积分耗尽 / 凭据失效 → 冷却该号，换下一个号重试
 *   3. 全部账号不可用 → 落到第三方免费渠道
 *   4. 全都不行 → 回一个 OpenAI 形状的错误
 *
 * 流式请求逐块转发（不缓冲，否则会毁掉打字机效果）；非流式请求把上游的 SSE
 * 聚合成一个 JSON。
 */

import { createServer } from 'node:http'
import { isAuthorized, checkPassword, sessionCookie } from './auth.mjs'
import * as codeartsApi from './codearts.mjs'
import {
  getCodearts, codeartsStatus, startCodeartsLogin, codeartsLoginStatus,
  logoutCodearts, CHANNEL_CAPABILITY,
} from './channels-login.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { prepareChatBody, stripUsageFrame } from './upstream.mjs'
import { activeProviders, providerForModel, relayToProvider, providerModels, loadRegistry } from './providers.mjs'
import { log, readJson, PATHS } from './config.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const MAX_BODY = 64 * 1024 * 1024
const MAX_ATTEMPTS = 6

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function oaiError(res, status, message, type = 'upstream_error', code = undefined) {
  json(res, status, { error: { message, type, ...(code ? { code } : {}) } })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 解析调用方要求的模型。
 *
 *   wbpool            → 用配置的默认上游模型
 *   wbpool/<model>    → 直指某个上游模型
 *   <provider>/<model>→ 直连某家第三方渠道
 *   <model>           → 当作上游模型名透传
 */
export function resolveTarget(rawModel, config) {
  const model = typeof rawModel === 'string' ? rawModel.trim() : ''
  const fallback = config.defaultModel || 'auto'
  if (model === '' || model === 'wbpool' || model === 'wb-pool') {
    return { lane: 'workbuddy', model: fallback }
  }
  if (model.startsWith('wbpool/')) {
    return { lane: 'workbuddy', model: model.slice('wbpool/'.length) || fallback }
  }
  return { lane: 'workbuddy', model }
}

/** 从请求里推一个对话键，用于 sticky 黏号与上游缓存命中。 */
function conversationKeyOf(req, body) {
  const header = req.headers['x-conversation-id'] || req.headers['x-session-id']
  if (typeof header === 'string' && header) return header
  if (typeof body?.user === 'string' && body.user) return body.user
  // 用首条消息 + system 做指纹：同一段对话的后续轮次首条消息通常不变
  const first = Array.isArray(body?.messages) ? body.messages[0] : undefined
  const seed = JSON.stringify(first ?? '').slice(0, 200)
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return `conv-${(h >>> 0).toString(16)}`
}

/**
 * 把上游 SSE 聚合成一条非流式响应。
 *
 * 上游恒为流式，所以 stream:false 的调用方必须由这里合成。顺手收集 usage
 * （上游把积分消耗写在 usage.credit 里）。
 */
export async function collectStream(webStream) {
  const reader = webStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  const toolCalls = []
  let usage = null
  let finishReason = null
  let id = ''
  let model = ''

  const handleFrame = (payload) => {
    if (payload === '[DONE]') return
    let frame
    try { frame = JSON.parse(payload) } catch { return }
    if (typeof frame.id === 'string' && frame.id) id = frame.id
    if (typeof frame.model === 'string' && frame.model) model = frame.model
    if (frame.usage) usage = frame.usage
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : toolCalls.length
        if (!toolCalls[index]) {
          toolCalls[index] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } }
        }
        if (tc.id) toolCalls[index].id = tc.id
        if (tc.function?.name) toolCalls[index].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[index].function.arguments += tc.function.arguments
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.startsWith('data:')) handleFrame(line.slice(5).trim())
    }
  }
  if (buffer.trim().startsWith('data:')) handleFrame(buffer.trim().slice(5).trim())

  const message = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  const cleanTools = toolCalls.filter(Boolean)
  if (cleanTools.length > 0) message.tool_calls = cleanTools

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'wbpool',
    choices: [{ index: 0, message, finish_reason: finishReason ?? (cleanTools.length ? 'tool_calls' : 'stop') }],
    usage: usage ?? undefined,
  }
}

export function createGateway({ config, pool, client, stats, uiDir, runAutomation }) {
  /** 访问鉴权（逻辑在 core/auth.mjs）。 */
  function authorized(req) {
    return isAuthorized(req, config)
  }

  /** 尝试一次 WorkBuddy 账号。 */
  async function tryAccount(account, prepared, { conversationKey, signal, stream }) {
    // 云端模式不主动续期：刷新会让 refreshToken 轮转，把用户桌面端的登录顶掉。
    // 令牌快过期时应当由本机启动器重新解密并同步，这里只提示，不动令牌。
    if (!config.remoteMode) {
      try {
        await client.ensureFreshToken(account)
      } catch (error) {
        pool.markCooldown(account, 'dead', config.credentialDeadCooldownMs)
        return { ok: false, kind: 'dead', message: String(error.message || error) }
      }
    } else if (account.expiresAt && account.expiresAt <= Date.now()) {
      pool.markCooldown(account, 'dead', config.credentialDeadCooldownMs)
      return {
        ok: false,
        kind: 'dead',
        message: '云端令牌已过期，请在本机双击「WB Pool」重新同步（会自动带上桌面端的新令牌）',
      }
    }
    const result = await client.chatStream(account, prepared, { conversationKey, signal })
    if (result.ok) return result
    if (result.kind === 'rate-limit') {
      pool.markCooldown(account, 'rate-limit', config.cooldownMs)
    } else if (result.kind === 'exhaust') {
      pool.markCooldown(account, 'exhaust', config.exhaustCooldownMs)
    } else if (result.kind === 'dead') {
      pool.markCooldown(account, 'dead', config.credentialDeadCooldownMs)
    } else if (result.kind === 'server') {
      // 上游抖动：短暂避让，别一直撞同一个号
      pool.markCooldown(account, 'server', Math.min(config.cooldownMs, 15_000))
    }
    return result
  }

  /** 处理一次 chat completions。 */
  async function handleChat(req, res, rawBody) {
    let body
    try {
      body = JSON.parse(rawBody)
    } catch {
      return oaiError(res, 400, '请求体不是合法 JSON', 'invalid_request_error')
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return oaiError(res, 400, 'messages 不能为空', 'invalid_request_error')
    }

    // 归一化：WorkBuddy 的模型 id 用点号拼（wbpool.hy3），这里转成网关内部斜杠写法
    if (typeof body.model === 'string' && body.model.startsWith('wbpool.')) {
      body.model = 'wbpool/' + body.model.slice('wbpool.'.length)
    }

    const wantStream = body.stream === true
    const conversationKey = conversationKeyOf(req, body)
    stats.record('request')

    // 显式指定第三方渠道：vendor/model
    const explicit = providerForModel(config, body.model)
    if (explicit) {
      const relay = await relayToProvider(explicit.provider, body, { model: explicit.model })
      if (!relay.ok) return oaiError(res, relay.status || 502, `渠道 ${explicit.provider.name} 失败：${relay.message}`)
      stats.record('third-party', { model: body.model })
      return pipeUpstream(res, relay.response, { stream: wantStream, ctx: { stats, model: body.model } })
    }

    // CodeArts 通道（登录用 AK/SK 签名，和账号池是两套凭据）
    if (String(body.model ?? '').startsWith('codearts/')) {
      const cred = getCodearts()
      if (!cred) return oaiError(res, 400, '还没有登录 CodeArts，请到「登录渠道」页登录', 'channel_error')
      const modelName = String(body.model).slice('codearts/'.length)
      try {
        const upstream = await codeartsApi.chat(cred, { ...body, model: modelName })
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '')
          return oaiError(res, upstream.status || 502, `CodeArts: ${text.slice(0, 300)}`, 'upstream_error')
        }
        stats.record('third-party', { model: body.model })
        return pipeUpstream(res, upstream, { stream: wantStream, ctx: { stats, model: body.model } })
      } catch (error) {
        return oaiError(res, 502, `CodeArts 调用失败：${String(error.message || error)}`, 'upstream_error')
      }
    }

    // 模型别名：wbpool/vendor:model（给 WorkBuddy 的独立模型条目用）
    const aliasMatch = /^wbpool\/([a-z0-9_]+):(.+)$/i.exec(String(body.model ?? ''))
    if (aliasMatch) {
      const vendorId = aliasMatch[1]
      const realModel = aliasMatch[2]
      const target = activeProviders(config).find((p) => p.id === vendorId)
      if (!target) {
        return oaiError(res, 400, `渠道 ${vendorId} 未启用或不存在`, 'provider_error')
      }
      const relay = await relayToProvider(target, { ...body, model: realModel }, { model: realModel })
      if (!relay.ok) {
        return oaiError(res, relay.status || 502, `${target.name} 失败：${String(relay.message).slice(0, 300)}`, 'upstream_error')
      }
      stats.record('third-party', { model: body.model })
      return pipeUpstream(res, relay.response, { stream: wantStream, ctx: { stats, model: body.model } })
    }

    // 命中模型路由就按链走：一条链上每个模型各自跑一段池路由
    const route = (config.routes ?? []).find((r) => r && r.id === body.model)
    let chain
    if (route && Array.isArray(route.models) && route.models.length > 0) {
      chain = route.strategy === 'round-robin'
        ? [...route.models.slice(1), route.models[0]]
        : route.models
    } else {
      chain = [resolveTarget(body.model, config).model]
    }

    let lastError = { kind: 'server', message: '池里没有可用账号' }

    for (const modelName of chain) {
      const prepared = prepareChatBody(JSON.stringify({ ...body, model: modelName }), { region: 'cn' })
      const tried = new Set()
      let attempt = 0

      while (attempt < MAX_ATTEMPTS) {
        const account = pool.pick({ conversationKey, exclude: tried })
        if (!account) break
        tried.add(account.id)
        attempt++
        if (attempt > 1) stats.record('failover')

        const result = await tryAccount(account, prepared, { conversationKey, signal: undefined, stream: wantStream })
        if (result.ok) {
          pool.markSuccess(account)
          stats.record('call', { account: account.id, model: modelName })
          return pipeUpstream(res, result.response, {
            stream: wantStream,
            ctx: { stats, account, model: modelName, pool, route: route?.id },
          })
        }
        lastError = result
        stats.record('failure', { account: account.id, model: modelName })
        log(`账号 ${account.label} 在 ${modelName} 上失败(${result.kind})，换下一个`)
        // 请求本身有问题，换号也没用
        if (result.kind === 'client' || result.kind === 'aborted') break
      }
    }

    // 落到第三方渠道
    const third = activeProviders(config)
    for (const provider of third) {
      const relay = await relayToProvider(provider, body, {})
      if (relay.ok) {
        stats.record('third-party', { model: body.model })
        return pipeUpstream(res, relay.response, { stream: wantStream, ctx: { stats, model: body.model } })
      }
      lastError = { kind: relay.kind, message: `渠道 ${provider.name}：${relay.message}` }
      log(`第三方渠道 ${provider.name} 失败(${relay.kind})`)
    }

    const status = lastError.kind === 'rate-limit' ? 429 : lastError.kind === 'exhaust' ? 402 : 502
    const hint = lastError.kind === 'rate-limit'
      ? '所有 WorkBuddy 账号都在限流冷却中，稍后再试或加一个号'
      : lastError.kind === 'exhaust'
        ? '所有账号积分已耗尽'
        : '上游全部不可用'
    return oaiError(res, status, `${hint}（最后一次错误：${String(lastError.message).slice(0, 300)}）`, 'pool_error')
  }

  /** 把上游响应转发给调用方：流式逐块、非流式聚合。 */
  async function pipeUpstream(res, upstream, { stream, ctx }) {
    const contentType = String(upstream.headers.get('content-type') ?? '').toLowerCase()

    if (!stream) {
      // 第三方渠道在 stream:false 时回的是普通 JSON，不能丢给 SSE 聚合器
      // （那样一行 data: 都解析不到，回复会变成空字符串）
      if (contentType.includes('application/json')) {
        let payload
        try {
          payload = await upstream.json()
        } catch (error) {
          return oaiError(res, 502, `上游返回的不是合法 JSON：${String(error)}`)
        }
        if (payload && payload.usage) {
          const u = payload.usage
          ctx.stats?.record('usage', {
            account: ctx.account?.id,
            model: ctx.model,
            inputTokens: u.prompt_tokens ?? 0,
            outputTokens: u.completion_tokens ?? 0,
            credit: typeof u.credit === 'number' ? u.credit : 0,
          })
        }
        return json(res, 200, payload)
      }

      let payload
      try {
        payload = await collectStream(upstream.body)
      } catch (error) {
        return oaiError(res, 502, `读取上游失败：${String(error)}`)
      }
      if (payload.usage) {
        ctx.stats?.record('usage', {
          account: ctx.account?.id,
          model: ctx.model,
          inputTokens: payload.usage.prompt_tokens ?? 0,
          outputTokens: payload.usage.completion_tokens ?? 0,
          credit: typeof payload.usage.credit === 'number' ? payload.usage.credit : 0,
        })
        if (ctx.account) {
          ctx.account.inputTokens = (ctx.account.inputTokens || 0) + (payload.usage.prompt_tokens ?? 0)
          ctx.account.outputTokens = (ctx.account.outputTokens || 0) + (payload.usage.completion_tokens ?? 0)
          ctx.account.creditSpent = (ctx.account.creditSpent || 0) + (typeof payload.usage.credit === 'number' ? payload.usage.credit : 0)
        }
      }
      return json(res, 200, payload)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let closed = false
    res.on('close', () => { closed = true })

    const pump = (text) => {
      if (closed) return
      // 去掉上游多塞的纯 usage 帧，保持调用方期望的形状
      const lines = text.split('\n')
      const kept = []
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { kept.push(line); continue }
          if (stripUsageFrame(payload) === null) {
            // usage 帧：记账但不转发
            try {
              const frame = JSON.parse(payload)
              if (frame.usage) {
                ctx.stats?.record('usage', {
                  account: ctx.account?.id,
                  model: ctx.model,
                  inputTokens: frame.usage.prompt_tokens ?? 0,
                  outputTokens: frame.usage.completion_tokens ?? 0,
                  credit: typeof frame.usage.credit === 'number' ? frame.usage.credit : 0,
                })
                if (ctx.account) {
                  ctx.account.inputTokens = (ctx.account.inputTokens || 0) + (frame.usage.prompt_tokens ?? 0)
                  ctx.account.outputTokens = (ctx.account.outputTokens || 0) + (frame.usage.completion_tokens ?? 0)
                  ctx.account.creditSpent = (ctx.account.creditSpent || 0) + (typeof frame.usage.credit === 'number' ? frame.usage.credit : 0)
                }
              }
            } catch { /* 忽略 */ }
            continue
          }
        }
        kept.push(line)
      }
      const out = kept.join('\n')
      if (out.trim() !== '') res.write(out.endsWith('\n') ? out : out + '\n')
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx + 2)
          buffer = buffer.slice(idx + 2)
          pump(chunk)
        }
      }
      if (buffer.trim()) pump(buffer)
    } catch (error) {
      log('流转发中断', String(error))
    } finally {
      if (!closed) res.end()
      try { reader.cancel() } catch { /* 已结束 */ }
    }
  }

  /** 静态文件（控制台）。 */
  function serveStatic(req, res, pathname) {
    if (!uiDir) return json(res, 404, { error: 'no ui' })
    const rel = pathname === '/'
      ? 'index.html'
      : pathname === '/login'
        ? 'login.html'
        : pathname.replace(/^\/+/, '')
    const path = normalize(join(uiDir, rel))
    if (!path.startsWith(normalize(uiDir))) return json(res, 403, { error: 'forbidden' })
    if (!existsSync(path)) return json(res, 404, { error: 'not found' })
    const buf = readFileSync(path)
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Content-Length': buf.length })
    res.end(buf)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
    const pathname = url.pathname

    // CORS：控制台是同源，但允许本地其它工具带凭据访问
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Conversation-Id, X-Session-Id')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    // 健康检查：给启动器/监控探活，不需要密码
    if (pathname === '/healthz') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), accounts: pool.accounts().length })
    }

    // 渠道登录的回调落点：浏览器跳过来，没有 cookie，必须免鉴权
    if (pathname === '/oauth/callback') {
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>登录完成</title><style>body{background:#080b10;color:#e6edf3;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;display:grid;place-items:center;height:100vh;margin:0}
.c{text-align:center}.t{font-size:18px;font-weight:600;margin-bottom:8px}.d{color:#8b98a5;font-size:13px}
a{color:#3ddc97;text-decoration:none}</style></head><body><div class="c">
<div class="t">✅ 登录已完成</div>
<div class="d">可以关闭这个页面，回到控制台查看结果。</div>
<div class="d" style="margin-top:14px"><a href="./">返回控制台</a></div>
</div></body></html>`
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    // 登录页：免鉴权
    if (pathname === '/login' && req.method === 'GET') {
      return serveStatic(req, res, '/login')
    }

    // 登录 / 登出（只认密码）
    if (pathname === '/api/login' && req.method === 'POST') {
      const raw = await readBody(req).catch(() => '{}')
      let payload = {}
      try { payload = JSON.parse(raw || '{}') } catch { payload = {} }
      if (!checkPassword(config, payload.password)) {
        // 故意慢一点，压一压暴力猜
        await new Promise((r) => setTimeout(r, 400))
        return json(res, 401, { ok: false, error: '密码不对' })
      }
      res.setHeader('Set-Cookie', sessionCookie(config, req))
      return json(res, 200, { ok: true })
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', sessionCookie(config, req, { clear: true }))
      return json(res, 200, { ok: true })
    }

    // 同步端点自己用 X-Sync-Secret 校验，不走登录
    if (pathname !== '/api/sync-accounts' && !authorized(req)) {
      // 页面请求直接跳登录页；接口请求回 401 让前端跳
      const wantsPage = pathname === '/' || pathname.endsWith('.html')
      if (wantsPage) {
        res.writeHead(302, { Location: 'login' })
        return res.end()
      }
      return json(res, 401, { error: { message: '需要登录', type: 'auth_error' } })
    }

    try {
      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = await buildModelList()
        return json(res, 200, { object: 'list', data: models })
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const raw = await readBody(req)
        return await handleChat(req, res, raw)
      }

      if (pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, await buildStatus())
      }

      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname)
      }

      if (req.method === 'GET') return serveStatic(req, res, pathname)
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      log('网关异常', String(error?.stack || error))
      if (!res.headersSent) oaiError(res, 500, String(error?.message || error), 'internal_error')
      else res.end()
    }
  })

  /**
   * 完整模型清单，给「模型选择」页用。
   *
   * 每条都带一个 WorkBuddy 能直接用的 id：
   *   WorkBuddy 上游 → wbpool/<model>
   *   第三方渠道   → wbpool/<vendor>:<model>
   */
  async function buildModelCatalog() {
    const workbuddy = []
    const thirdParty = []

    const account = pool.pick({}) ?? pool.accounts()[0]
    if (account) {
      try {
        const models = await client.fetchModels(account, { force: true })
        for (const m of models) {
          workbuddy.push({
            id: `wbpool/${m.id}`,
            name: m.name || m.id,
            model: m.id,
            vendor: 'WorkBuddy',
            credits: m.credits,
            free: m.freeTag !== undefined || m.credits === 0,
            supportsImages: m.supportsImages,
            supportsReasoning: m.supportsReasoning,
            supportsToolCall: m.supportsToolCall,
            source: 'workbuddy',
          })
        }
      } catch (error) {
        workbuddy.push({ id: '', name: `(目录读取失败：${String(error.message || error).slice(0, 60)})`, source: 'workbuddy', error: true })
      }
    }

    for (const provider of activeProviders(config)) {
      for (const modelId of provider.models) {
        thirdParty.push({
          id: `wbpool/${provider.id}:${modelId}`,
          name: modelId,
          model: modelId,
          vendor: provider.name,
          source: 'third-party',
          provider: provider.id,
          free: false,
        })
      }
    }

    const selected = new Set(config.selectedModels ?? [])
    return {
      workbuddy: workbuddy.filter((m) => !m.error),
      thirdParty,
      total: workbuddy.filter((m) => !m.error).length + thirdParty.length,
      selection: [...selected],
      errors: workbuddy.filter((m) => m.error).map((m) => m.name),
    }
  }

  /** 可用模型列表：WorkBuddy 目录 + 第三方渠道。 */
  async function buildModelList() {
    const out = []
    const account = pool.pick({})
    if (account) {
      try {
        const models = await client.fetchModels(account)
        for (const m of models) {
          out.push({
            id: `wbpool/${m.id}`,
            object: 'model',
            owned_by: 'workbuddy',
            created: 0,
            name: m.name,
            credits: m.credits,
            free: m.freeTag !== undefined || m.credits === 0,
          })
        }
      } catch {
        // 目录取不到不影响兜底条目
      }
    }
    if (out.length === 0) {
      out.push({ id: 'wbpool', object: 'model', owned_by: 'workbuddy', created: 0, name: 'WB Pool' })
    }
    for (const m of providerModels(config)) {
      out.push({ id: m.id, object: 'model', owned_by: m.provider, created: 0, name: m.name })
    }
    return out
  }

  /** 读自动化账本（与调度器共享同一个文件，网关只读不写）。 */
  function readAutomation(cfg) {
    const store = readJson(PATHS.automation, { days: {} })
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    const days = store.days ?? {}
    return {
      enabled: cfg.automation?.enabled !== false,
      checkinAt: cfg.automation?.checkinAt ?? '-',
      rewardsAt: cfg.automation?.rewardsAt ?? '-',
      today: days[key] ?? null,
      recent: Object.keys(days).sort().slice(-14).map((k) => days[k]),
    }
  }

  /** 状态文档。 */
  async function buildStatus() {
    const accounts = pool.accounts().map((a) => ({
      id: a.id,
      label: a.label,
      uid: a.uid,
      uin: a.uin,
      region: a.region,
      domain: a.domain,
      expiresAt: a.expiresAt,
      tokenValid: !a.expiresAt || a.expiresAt > Date.now(),
      cooldownMs: Math.max(0, (a.cooldownUntil || 0) - Date.now()),
      cooldownReason: a.cooldownReason || '',
      usable: (a.cooldownUntil || 0) <= Date.now(),
      credits: a.credits,
      checkin: a.checkin,
      requestCount: a.requestCount || 0,
      failureCount: a.failureCount || 0,
      inputTokens: a.inputTokens || 0,
      outputTokens: a.outputTokens || 0,
      creditSpent: a.creditSpent || 0,
      lastUsedAt: a.lastUsedAt || 0,
      lastSeenAt: a.lastSeenAt || 0,
    }))
    const providers = activeProviders(config).map((p) => ({
      id: p.id, name: p.name, models: p.models.length, baseUrl: p.baseUrl,
    }))
    return {
      version: 1,
      now: Date.now(),
      pool: {
        total: accounts.length,
        usable: accounts.filter((a) => a.usable).length,
        cooling: accounts.filter((a) => !a.usable).length,
        distribution: config.distribution,
        preferred: accounts.find((a) => a.usable)?.label ?? '',
      },
      accounts,
      providers,
      stats: { today: stats.day(), recent: stats.recent(14), totals: stats.totals() },
      automation: readAutomation(config),
      config: {
        authEnabled: (config.auth?.password || '') !== '',
        remoteMode: config.remoteMode === true,
        port: config.port,
        distribution: config.distribution,
        cooldownMs: config.cooldownMs,
        defaultModel: config.defaultModel || 'auto',
        automation: config.automation,
      },
    }
  }

  /** 控制台写操作。 */
  async function handleApi(req, res, pathname) {
    const body = req.method === 'POST' ? await readBody(req).catch(() => '{}') : '{}'
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }

    if (pathname === '/api/sync-accounts' && req.method === 'POST') {
      const expected = config.auth?.syncSecret ?? ''
      const got = String(req.headers['x-sync-secret'] ?? '')
      if (!expected || got !== expected) {
        return json(res, 403, { ok: false, error: 'sync secret 不匹配' })
      }
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      }
      const result = pool.syncAccounts(payload.accounts ?? [])
      log(`账号同步：新增 ${result.added}，更新 ${result.updated}，池内 ${result.total}`)
      return json(res, 200, { ok: true, ...result })
    }
    // ---------- 聚合渠道：76 家 ----------
    if (pathname === '/api/providers' && req.method === 'GET') {
      const registry = loadRegistry()
      const configured = config.providers ?? {}
      const list = registry.map((p) => {
        const setting = configured[p.id] ?? {}
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          baseUrl: p.baseUrl,
          website: p.website,
          notes: p.notes,
          authKind: p.auth?.kind ?? 'apiKey',
          authUrl: p.auth?.url ?? p.website,
          models: (p.models ?? []).map((m) => m.id),
          format: p.format,
          enabled: setting.enabled === true,
          hasKey: typeof setting.apiKey === 'string' && setting.apiKey !== '',
        }
      })
      return json(res, 200, { ok: true, total: list.length, providers: list })
    }

    if (pathname === '/api/providers' && req.method === 'POST') {
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
      const registry = loadRegistry()
      const spec = registry.find((p) => p.id === id)
      if (!spec) return json(res, 404, { ok: false, error: `注册表里没有 ${id}` })
      config.providers = config.providers ?? {}
      const prev = config.providers[id] ?? {}
      const next = { ...prev }
      if (typeof payload.apiKey === 'string') next.apiKey = payload.apiKey.trim()
      if (typeof payload.enabled === 'boolean') next.enabled = payload.enabled
      if (typeof payload.baseUrl === 'string' && payload.baseUrl.trim()) next.baseUrl = payload.baseUrl.trim()
      if (typeof payload.priority === 'number') next.priority = payload.priority
      // 填了 key 但没说启用，默认启用
      if (next.apiKey && payload.enabled === undefined) next.enabled = true
      config.providers[id] = next
      const { saveConfig } = await import('./config.mjs')
      saveConfig(config)
      return json(res, 200, { ok: true, provider: { id, ...next } })
    }

    if (pathname === '/api/providers/test' && req.method === 'POST') {
      const id = typeof payload.id === 'string' ? payload.id : ''
      const target = activeProviders(config).find((p) => p.id === id)
      if (!target) return json(res, 400, { ok: false, error: '该渠道未启用或没填 key' })
      const model = typeof payload.model === 'string' && payload.model ? payload.model : target.models[0]
      if (!model) return json(res, 400, { ok: false, error: '该渠道没有声明模型，无法测试' })
      const started = Date.now()
      try {
        const relay = await relayToProvider(target, {
          model, stream: false, max_tokens: 8,
          messages: [{ role: 'user', content: 'hi' }],
        }, { model })
        if (!relay.ok) return json(res, 200, { ok: false, error: `${relay.kind}: ${String(relay.message).slice(0, 200)}` })
        const text = await relay.response.text()
        return json(res, 200, { ok: true, model, ms: Date.now() - started, sample: text.slice(0, 200) })
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error.message || error).slice(0, 200) })
      }
    }

    // ---------- 账号池：手动导入 / 删除 ----------
    if (pathname === '/api/accounts/import' && req.method === 'POST') {
      // 支持三种形态：完整 auth 文件 JSON、{accessToken,refreshToken,...}、裸 token 字符串
      let incoming
      try {
        incoming = typeof payload.raw === 'string' ? JSON.parse(payload.raw) : payload.account ?? payload
      } catch {
        return json(res, 400, { ok: false, error: '内容不是合法 JSON' })
      }
      const auth = incoming.auth ?? incoming
      const account = incoming.account ?? {}
      const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
      if (!accessToken) return json(res, 400, { ok: false, error: '缺少 accessToken' })
      const entry = {
        id: String(account.uid || auth.uid || payload.id || `imp-${Date.now().toString(36)}`),
        uid: String(account.uid || auth.uid || ''),
        uin: String(account.uin || auth.uin || ''),
        label: String(payload.label || account.nickname || (account.uin ? `账号 ${account.uin}` : `导入 ${String(account.uid || '').slice(0, 8)}`)),
        domain: String(auth.domain || payload.domain || 'www.workbuddy.cn'),
        accessToken,
        refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
        expiresAt: Number(auth.expiresAt) || 0,
        refreshExpiresAt: Number(auth.refreshExpiresAt) || 0,
      }
      // 导入后立刻验一次，顺手带出积分
      let probe = 'ok'
      try {
        const probeAccount = { ...entry, region: String(entry.domain).includes('workbuddy.ai') ? 'global' : 'cn' }
        const credits = await client.fetchCredits(probeAccount)
        entry.credits = credits
      } catch (error) {
        probe = `令牌暂时验证不通（${String(error.message || error).slice(0, 80)}），已入库待重试`
      }
      const result = pool.syncAccounts([entry])
      return json(res, 200, { ok: true, ...result, probe, id: entry.id, label: entry.label })
    }

    if (pathname === '/api/accounts/remove' && req.method === 'POST') {
      const id = typeof payload.id === 'string' ? payload.id : ''
      if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
      if (typeof pool.removeAccount === 'function') {
        const removed = pool.removeAccount(id)
        return json(res, 200, { ok: removed, total: pool.accounts().length })
      }
      return json(res, 500, { ok: false, error: '池不支持删除' })
    }

    if (pathname === '/api/accounts/rename' && req.method === 'POST') {
      const account = pool.get(String(payload.id ?? ''))
      if (!account) return json(res, 404, { ok: false, error: '没有这个账号' })
      if (typeof payload.label === 'string' && payload.label.trim()) account.label = payload.label.trim()
      pool.persist()
      return json(res, 200, { ok: true })
    }

    // ---------- 模型路由（把几个模型串成一条链） ----------
    // ---------- 模型清单与选择 ----------
    if (pathname === '/api/models' && req.method === 'GET') {
      return json(res, 200, { ok: true, ...(await buildModelCatalog()) })
    }

    if (pathname === '/api/models/selection' && req.method === 'GET') {
      return json(res, 200, { ok: true, selection: config.selectedModels ?? [] })
    }

    if (pathname === '/api/models/selection' && req.method === 'POST') {
      if (!Array.isArray(payload.ids)) return json(res, 400, { ok: false, error: 'ids 必须是数组' })
      config.selectedModels = payload.ids.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      const { saveConfig } = await import('./config.mjs')
      saveConfig(config)
      return json(res, 200, { ok: true, selection: config.selectedModels })
    }

    if (pathname === '/api/routes' && req.method === 'GET') {
      return json(res, 200, { ok: true, routes: config.routes ?? [] })
    }

    if (pathname === '/api/routes' && req.method === 'POST') {
      if (!Array.isArray(payload.routes)) return json(res, 400, { ok: false, error: 'routes 必须是数组' })
      config.routes = payload.routes
        .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.models))
        .map((r) => ({
          id: r.id,
          name: typeof r.name === 'string' && r.name ? r.name : r.id,
          strategy: r.strategy === 'round-robin' ? 'round-robin' : 'sequential',
          models: r.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()),
        }))
        .filter((r) => r.models.length > 0)
      const { saveConfig } = await import('./config.mjs')
      saveConfig(config)
      return json(res, 200, { ok: true, routes: config.routes })
    }

    // ---------- 网关信息 ----------
    if (pathname === '/api/gateway' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        endpoints: {
          chat: '/v1/chat/completions',
          models: '/v1/models',
          console: '/',
        },
        gatewayKey: config.gatewayKey,
        defaultModel: config.defaultModel || 'auto',
        routes: (config.routes ?? []).map((r) => ({ id: r.id, name: r.name, models: r.models.length })),
        modelCount: (await buildModelList()).length,
        selected: (config.selectedModels ?? []).length,
      })
    }

    // ---------- 渠道登录 ----------
    if (pathname === '/api/channels' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        capability: CHANNEL_CAPABILITY,
        codearts: codeartsStatus(),
      })
    }

    if (pathname === '/api/channels/codearts/start' && req.method === 'POST') {
      const proto = String(req.headers['x-forwarded-proto'] ?? 'https')
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      const base = (config.publicBaseUrl || `${proto}://${host}`).replace(/\/+$/, '')
      if (!base || base.includes('127.0.0.1') || base.includes('localhost')) {
        return json(res, 400, { ok: false, error: '需要先配置公网地址（publicBaseUrl），否则登录回调回不来' })
      }
      const started = startCodeartsLogin(base)
      return json(res, 200, started)
    }

    if (pathname === '/api/channels/codearts/status' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      return json(res, 200, { ok: true, ...codeartsLoginStatus(id), current: codeartsStatus() })
    }

    if (pathname === '/api/channels/codearts/import' && req.method === 'POST') {
      // 本机登录器拿到 AK/SK 后推上来。走 X-Sync-Secret，不需要 cookie。
      const expected = config.auth?.syncSecret ?? ''
      const got = String(req.headers['x-sync-secret'] ?? '')
      if (!expected || got !== expected) {
        return json(res, 403, { ok: false, error: 'sync secret 不匹配' })
      }
      const cred = payload.credential ?? payload
      if (!cred || typeof cred.access_key_id !== 'string' || typeof cred.security_token !== 'string') {
        return json(res, 400, { ok: false, error: '缺少 access_key_id / security_token' })
      }
      try {
        const { importCodearts } = await import('./channels-login.mjs')
        const result = importCodearts(cred)
        return json(res, 200, { ok: true, ...result })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error.message || error) })
      }
    }

    if (pathname === '/api/channels/codearts/logout' && req.method === 'POST') {
      logoutCodearts()
      return json(res, 200, { ok: true })
    }

    if (pathname === '/api/channels/codearts/models' && req.method === 'POST') {
      const cred = getCodearts()
      if (!cred) return json(res, 400, { ok: false, error: '还没有登录 CodeArts' })
      try {
        const models = await codeartsApi.listModels(cred)
        return json(res, 200, { ok: true, models })
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error.message || error).slice(0, 200) })
      }
    }

    if (pathname === '/api/rescan' && req.method === 'POST') {
      const result = await pool.scan()
      return json(res, 200, { ok: true, ...result })
    }
    if (pathname === '/api/cooldown-reset' && req.method === 'POST') {
      pool.clearCooldowns()
      return json(res, 200, { ok: true })
    }
    if (pathname === '/api/credits' && req.method === 'POST') {
      const results = []
      for (const account of pool.accounts()) {
        try {
          const credits = await client.fetchCredits(account)
          results.push({ id: account.id, label: account.label, ok: true, total: credits.total })
        } catch (error) {
          results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
        }
      }
      pool.persist()
      return json(res, 200, { ok: true, results })
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const results = []
      for (const account of pool.accounts()) {
        try {
          const tasks = await client.listTasks(account)
          results.push({ id: account.id, label: account.label, ok: true, tasks })
        } catch (error) {
          results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
        }
      }
      return json(res, 200, { ok: true, results })
    }
    if (pathname === '/api/tasks-claim' && req.method === 'POST') {
      const results = []
      let gained = 0
      for (const account of pool.accounts()) {
        try {
          const tasks = await client.listTasks(account)
          for (const task of tasks.filter((t) => t.claimable)) {
            const r = await client.claimTaskReward(account, task.taskCode)
            if (!r.already) gained += r.credit ?? 0
            results.push({ id: account.id, task: task.taskCode, title: task.title, credit: r.credit ?? 0, already: r.already })
          }
        } catch (error) {
          results.push({ id: account.id, ok: false, message: String(error.message || error) })
        }
      }
      return json(res, 200, { ok: true, credit: gained, results })
    }
    if (pathname === '/api/checkin' && req.method === 'POST') {
      const results = []
      for (const account of pool.accounts()) {
        try {
          const status = await client.fetchCheckin(account)
          if (status.todayCheckedIn) {
            account.checkin = status
            results.push({ id: account.id, label: account.label, ok: true, already: true, credit: 0, streakDays: status.streakDays })
            continue
          }
          const claim = await client.claimCheckin(account)
          const fresh = await client.fetchCheckin(account).catch(() => status)
          account.checkin = fresh
          results.push({ id: account.id, label: account.label, ...claim, streakDays: claim.streakDays || fresh.streakDays })
        } catch (error) {
          results.push({ id: account.id, label: account.label, ok: false, message: String(error.message || error) })
        }
      }
      pool.persist()
      return json(res, 200, { ok: true, results })
    }
    if (pathname === '/api/automation-run' && req.method === 'POST') {
      const kind = typeof payload.kind === 'string' ? payload.kind : 'all'
      const result = await runAutomation(kind)
      return json(res, 200, { ok: true, ...result })
    }
    if (pathname === '/api/config' && req.method === 'POST') {
      const allowed = ['distribution', 'cooldownMs', 'defaultModel', 'port']
      for (const key of allowed) {
        if (key in payload) config[key] = payload[key]
      }
      if (payload.providers && typeof payload.providers === 'object') config.providers = payload.providers
      if (payload.automation && typeof payload.automation === 'object') {
        config.automation = { ...config.automation, ...payload.automation }
      }
      const { saveConfig } = await import('./config.mjs')
      saveConfig(config)
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { error: 'unknown api' })
  }

  return { server, buildStatus, buildModelList, handleChat }
}
