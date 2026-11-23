/**
 * 打包自检：把「发布时会漏东西」这类问题挡在本地。
 *
 * 零依赖，不跑 npm —— 只核对 package.json 的 files 与几个必须项。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const problems = []

let pkg
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`读不了 package.json：${error.message}`)
  process.exit(1)
}

const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) problems.push('package.json 里没有 files —— 会把整个仓库打进去')

// 声明了就得真的存在。
for (const entry of files) {
  if (!existsSync(join(root, entry))) problems.push(`files 里写了「${entry}」，但目录里没有`)
}

// 这些是运行时必需的，漏一个别人装上就跑不起来。
for (const required of ['index.js', 'cordis.patch.yml', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  if (!files.includes(required)) problems.push(`files 里缺「${required}」`)
}

// main 必须被打进包里，否则 exports 指向一个不存在的文件。
if (pkg.main && !files.includes(pkg.main)) {
  problems.push(`main 指向「${pkg.main}」，但它不在 files 里`)
}

// engines.dsh 钉死成精确版本会让别人装不上 —— 回归守卫。
const dsh = pkg.engines?.dsh ?? ''
if (dsh && !/[<>=^*]/.test(dsh)) {
  problems.push(`engines.dsh「${dsh}」是精确版本，别人换个小版本就装不上；用范围`)
}

if (!pkg.repository) problems.push('package.json 缺 repository')
if (!pkg.license) problems.push('package.json 缺 license')

if (problems.length > 0) {
  console.error(`打包自检没通过（${problems.length} 条）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`打包自检通过：files 共 ${files.length} 项，全部存在。`)
