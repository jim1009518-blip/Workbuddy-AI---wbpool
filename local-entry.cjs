/**
 * WB Pool 本地版 —— SEA 主脚本（打成单文件 exe 的入口）。
 *
 * 双击后发生的事：
 *   1. 把内嵌的运行时文件（src/*.mjs、ui/*.html、渠道注册表）解包到
 *      %LOCALAPPDATA%\wbpool\runtime（内容变了才重解包，平时启动零开销）
 *   2. 动态加载解包出来的 local.mjs，由它起网关、扫号、开浏览器
 *
 * 为什么不能直接在 SEA 里跑业务代码：Node SEA 只认一个 CJS 主脚本，
 * import 外部模块受限；把整个 src 解包成普通文件再 import 是最稳的路径。
 */
'use strict'

const { createHash } = require('node:crypto')
const { execSync } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')

// Windows 控制台默认 GBK，先切 UTF-8，避免中文乱码
try {
  if (process.platform === 'win32') execSync('chcp 65001 > nul', { stdio: 'ignore', shell: 'cmd.exe' })
} catch { /* 切不了就按原样输出 */ }

function seaAsset(key) {
  const sea = require('node:sea')
  return Buffer.from(sea.getAsset(key))
}

function runtimeRoot() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'wbpool', 'runtime')
}

/** 双击运行时窗口别一闪而过：出错要停住让人看清原因。 */
function pause(seconds = 30) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { setTimeout(resolve, seconds * 1000); return }
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.once('data', resolve)
    setTimeout(() => { resolve() }, seconds * 1000)
  })
}

async function main() {
  let manifest
  try {
    manifest = JSON.parse(seaAsset('manifest.json').toString('utf8'))
  } catch (error) {
    console.error('初始化失败：内嵌资源读不出来（' + String(error && error.message || error) + '）')
    await pause()
    return 1
  }

  const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12)
  const dir = runtimeRoot()
  const versionFile = join(dir, '.version')

  let needExtract = true
  try { needExtract = readFileSync(versionFile, 'utf8') !== hash } catch { /* 首次运行 */ }

  if (needExtract) {
    try {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      for (const key of Object.keys(manifest.files)) {
        const target = join(dir, ...String(key).split('/'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, seaAsset(key))
      }
      writeFileSync(versionFile, hash, 'utf8')
    } catch (error) {
      console.error('运行时解包失败（' + String(error && error.message || error) + '）')
      console.error('目录：' + dir)
      await pause()
      return 1
    }
  }

  try {
    await import(pathToFileURL(join(dir, 'local.mjs')).href)
  } catch (error) {
    console.error('')
    console.error('启动失败：' + String(error && error.stack || error && error.message || error))
    console.error('')
    await pause()
    return 1
  }
  // local.mjs 起完网关后自己保持进程存活；走到这里说明它提前退出了
  return 0
}

main()
  .then((code) => { if (code) process.exit(code) })
  .catch(async (error) => {
    console.error('未预期的错误：' + String(error && error.stack || error))
    await pause()
    process.exit(1)
  })
