/**
 * 把「WB Pool 本地版」打成单个 exe（Node SEA）。
 *
 * 双击即用：exe 内嵌全部运行时文件（src/*.mjs、ui/*.html、渠道注册表），
 * 首次启动解包到 %LOCALAPPDATA%\wbpool\runtime，然后本地起网关、扫号、开浏览器。
 *
 * 产出：dist/WB Pool 本地版.exe（并复制到桌面）
 * 依赖：node 22+、postject（node_modules 里已带）
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dirname ? join(import.meta.dirname, '..') : 'D:/AI聚合'
const OUT_DIR = join(ROOT, 'dist')
const EXE = join(OUT_DIR, 'WB Pool 本地版.exe')

/** 收集要内嵌的运行时文件（相对路径，正斜杠）。 */
function collectFiles() {
  const files = ['local.mjs']
  const walk = (rel) => {
    const abs = join(ROOT, rel)
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${name.name}`
      if (name.isDirectory()) walk(child)
      else if (name.name.endsWith('.mjs')) files.push(child)
    }
  }
  walk('src')
  for (const name of readdirSync(join(ROOT, 'ui'))) {
    if (name.endsWith('.html')) files.push(`ui/${name}`)
  }
  files.push('data/providers-registry.json')
  return files
}

mkdirSync(OUT_DIR, { recursive: true })

// 1) 清点文件，生成 manifest（exe 里靠它知道解包哪些、何时需要重新解包）
const files = collectFiles()
const manifest = { version: 1, files: {} }
for (const rel of files) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) throw new Error(`缺少运行时文件：${rel}`)
  manifest.files[rel] = statSync(abs).size
}
const manifestPath = join(OUT_DIR, 'local-manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
console.log(`[1/5] 清点运行时文件：${files.length} 个（合计 ${(Object.values(manifest.files).reduce((s, n) => s + n, 0) / 1024).toFixed(0)} KB）`)

// 2) SEA 配置：local-entry.cjs 为 CJS 主脚本，其余全是 assets
const assets = { 'manifest.json': manifestPath }
for (const rel of files) assets[rel] = join(ROOT, rel)
const seaConfig = {
  main: join(ROOT, 'local-entry.cjs'),
  output: join(OUT_DIR, 'sea-local-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}
const configPath = join(OUT_DIR, 'sea-local-config.json')
writeFileSync(configPath, JSON.stringify(seaConfig, null, 2), 'utf8')
console.log('[2/5] 生成 SEA 配置')

// 3) blob
try {
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'pipe' })
} catch (error) {
  throw new Error(String(error.stderr || error.message))
}
if (!existsSync(seaConfig.output)) throw new Error('blob 生成失败')
console.log(`[3/5] blob 生成完成 ${(statSync(seaConfig.output).size / 1024).toFixed(0)} KB`)

// 4) 复制 node.exe 作为宿主
copyFileSync(process.execPath, EXE)
console.log(`[4/5] 宿主 node 复制完成 ${(statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`)

// 5) 注入
const postject = join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js')
if (!existsSync(postject)) throw new Error('postject 未安装：npm install --no-save postject')
execFileSync(process.execPath, [
  postject, EXE, 'NODE_SEA_BLOB', seaConfig.output,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' })
console.log('[5/5] 注入完成')

// 6) 无窗口化：PE Subsystem 3(Console) → 2(GUI)，双击不再弹黑色命令框
{
  const data = readFileSync(EXE)
  const e_lfanew = data.readUInt32LE(0x3c)
  if (data.subarray(e_lfanew, e_lfanew + 4).toString('latin1') !== 'PE\u0000\u0000') throw new Error('PE 头校验失败')
  const opt = e_lfanew + 24                       // COFF 头 20 字节后是 Optional Header
  const magic = data.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('未知 Optional Header 魔数：0x' + magic.toString(16))
  const subOffset = opt + 68                      // PE32 / PE32+ 的 SubSystem 都在 0x44
  if (data.readUInt16LE(subOffset) !== 3) {
    console.log('[6/6] 注意：Subsystem 已不是 Console，跳过改写')
  } else {
    data.writeUInt16LE(2, subOffset)
    writeFileSync(EXE, data)
    console.log('[6/6] 已改为 GUI 子系统（双击无黑色窗口）')
  }
}

// 桌面放一份，方便直接发给朋友
const desktop = join(process.env.USERPROFILE || 'C:/Users/Administrator', 'Desktop')
const target = join(desktop, 'WB Pool 本地版.exe')
copyFileSync(EXE, target)

console.log(`\n已生成：${EXE}（${(statSync(EXE).size / 1024 / 1024).toFixed(1)} MB）`)
console.log(`已放到桌面：${target}`)
console.log('发给朋友后双击即可用：本地起网关 + 自动扫 WorkBuddy 账号 + 打开控制台。')
