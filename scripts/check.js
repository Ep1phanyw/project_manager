/**
 * 语法与导入检查：把每个源码模块真的加载一遍。
 *
 * 比 `node --check` 强一点 —— 语法错和写错的 import 都会在这里炸，
 * 而不必等到某条测试恰好覆盖到它。
 */

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const libDir = new URL('./lib/', root)

const files = [
  new URL('./index.js', root),
  ...readdirSync(libDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => new URL(name, libDir)),
]

const failures = []

for (const file of files) {
  try {
    await import(file.href)
    console.log(`ok   ${fileURLToPath(file).replace(fileURLToPath(root), '')}`)
  } catch (error) {
    failures.push({ file: fileURLToPath(file), error })
    console.log(`FAIL ${fileURLToPath(file).replace(fileURLToPath(root), '')}`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 个模块加载失败：`)
  for (const { file, error } of failures) {
    console.error(`\n${file}\n  ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 1
} else {
  console.log(`\n${files.length} 个模块都能加载。`)
}
