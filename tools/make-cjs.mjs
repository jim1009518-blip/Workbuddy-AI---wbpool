/** 把 launcher.mjs 转成 CommonJS（Node SEA 的入口必须是 CJS）。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const src = readFileSync('launcher.mjs', 'utf8')
let out = src

// 通用替换：所有 import { ... } from 'node:xxx' → const { ... } = require('node:xxx')
// 不写死具体字段名，避免以后多引入一个模块就崩
const before = (out.match(/^import\s/gm) || []).length
out = out.replace(
  /^import \{([^}]+)\} from '(node:[^']+)'$/gm,
  (_m, names, mod) => `const {${names}} = require('${mod}')`,
)

out = out.replace("import.meta.dirname ?? '.'", '__dirname')

const oldSea = `  try {
    // eslint-disable-next-line no-undef
    if (typeof sea !== 'undefined' && sea.getAsset) {
      const raw = sea.getAsset('remote.json', 'utf8')
      if (raw) return JSON.parse(raw)
    }
  } catch { /* 不是 SEA 环境 */ }`
const newSea = `  try {
    const sea = require('node:sea')
    if (sea.isSea && sea.isSea()) {
      const raw = sea.getAsset('remote.json', 'utf8')
      if (raw) return JSON.parse(raw)
    }
  } catch { /* 不是 SEA 环境，走下面读文件 */ }`
if (out.includes(oldSea)) out = out.replace(oldSea, newSea)

const remaining = out.match(/^import\s/gm)
if (remaining) throw new Error(`仍有 ${remaining.length} 处 import 语句未转换`)

writeFileSync('launcher.cjs', out, 'utf8')
execFileSync(process.execPath, ['--check', 'launcher.cjs'], { stdio: 'inherit' })
console.log(`launcher.cjs 生成完成（转换 ${before} 处 import，${out.length} 字符，语法通过）`)
