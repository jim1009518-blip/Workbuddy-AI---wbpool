/**
 * 第三方免费渠道。
 *
 * 注册表移植自 dsh-xdpool 的 providers-registry.json（76 家，MIT），每家声明
 * baseUrl 与鉴权方式。默认一家都不开：配置里填了 apiKey 才亮，避免池子被一堆
 * 用不了的渠道撑满。
 *
 * 绝大多数是 OpenAI 兼容端点，直接透传即可；非 openai-chat 格式的（Anthropic
 * 原生等）本版先跳过，等有 key 再按需补转换器。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATHS } from './config.mjs'

let cachedRegistry = undefined

/** 注册表路径：项目自带一份，用户目录可覆盖。 */
function registryPaths() {
  return [
    join(PATHS.home, 'providers-registry.json'),
    fileURLToPath(new URL('../../data/providers-registry.json', import.meta.url)),
  ]
}

export function loadRegistry() {
  if (cachedRegistry) return cachedRegistry
  for (const path of registryPaths()) {
    try {
      if (!existsSync(path)) continue
      const list = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(list)) {
        cachedRegistry = list
        return list
      }
    } catch {
      // 换下一个候选
    }
  }
  cachedRegistry = []
  return cachedRegistry
}

/**
 * 池子里真正可用的第三方渠道。
 *
 * 只认三种情况：配置里 enabled 为 true 且填了 key；注册表声明无需鉴权的；
 * 配置里手写了 baseUrl 的自定义渠道（方便接自建中转）。
 */
export function activeProviders(config) {
  const registry = loadRegistry()
  const configured = config.providers ?? {}
  const out = []

  for (const [id, setting] of Object.entries(configured)) {
    if (!setting || setting.enabled === false) continue
    const spec = registry.find((p) => p.id === id)
    const baseUrl = setting.baseUrl || spec?.baseUrl
    const apiKey = setting.apiKey || ''
    if (!baseUrl) continue
    if (!apiKey && !setting.allowNoKey) continue
    out.push({
      id,
      name: spec?.name || setting.name || id,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      format: spec?.format || 'openai-chat',
      category: spec?.category || 'apikey',
      models: setting.models || spec?.models?.map((m) => m.id) || [],
      priority: typeof setting.priority === 'number' ? setting.priority : 100,
    })
  }

  return out.sort((a, b) => a.priority - b.priority)
}

/** 这个模型名是否属于某个第三方渠道（用于显式路由）。 */
export function providerForModel(config, model) {
  if (typeof model !== 'string') return undefined
  // 形如 `vendor/model`：前缀命中渠道 id 就直连
  const slash = model.indexOf('/')
  if (slash > 0) {
    const id = model.slice(0, slash)
    const found = activeProviders(config).find((p) => p.id === id)
    if (found) return { provider: found, model: model.slice(slash + 1) }
  }
  return undefined
}

/** 渠道声明的模型列表（给选择器用）。 */
export function providerModels(config) {
  const out = []
  for (const provider of activeProviders(config)) {
    for (const id of provider.models) {
      out.push({
        id: `${provider.id}/${id}`,
        name: `${provider.name} · ${id}`,
        provider: provider.id,
        upstreamModel: id,
        source: 'third-party',
      })
    }
  }
  return out
}

/** 把请求转发到一家第三方渠道。 */
export async function relayToProvider(provider, body, { model, signal, fetchImpl = fetch } = {}) {
  const payload = { ...body }
  if (model) payload.model = model
  else if (provider.models.length > 0 && !payload.model) payload.model = provider.models[0]

  const headers = {
    'Content-Type': 'application/json',
    'Accept': payload.stream ? 'text/event-stream' : 'application/json',
  }
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`

  let response
  try {
    response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, kind: 'aborted', message: '调用方取消' }
    return { ok: false, kind: 'server', message: `渠道传输错误：${String(error)}` }
  }
  if (response.ok) return { ok: true, response }
  const text = (await response.text().catch(() => '')).slice(0, 2000)
  const kind = response.status === 429 ? 'rate-limit' : response.status === 401 || response.status === 403 ? 'dead' : response.status >= 500 ? 'server' : 'client'
  return { ok: false, kind, status: response.status, message: text }
}
