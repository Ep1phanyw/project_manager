import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommandCapture, tail } from '../lib/exec.js'

test('命令成功时拿到退出码 0 与它的输出', () => {
  const result = runCommandCapture('node -e "console.log(42)"', { cwd: tmpdir() })

  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.match(result.output, /42/)
})

test('命令失败时拿到非零退出码，输出也留得住', () => {
  const result = runCommandCapture('node -e "console.error(\'炸了\'); process.exit(3)"', {
    cwd: tmpdir(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.match(result.output, /炸了/)
})

test('在指定的工作目录里跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-exec-'))
  try {
    const result = runCommandCapture('node -e "console.log(process.cwd())"', { cwd: dir })
    assert.equal(result.ok, true)
    assert.ok(result.output.includes(dir) || result.output.toLowerCase().includes(dir.toLowerCase()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('命令不存在时返回失败，而不是抛异常', () => {
  const result = runCommandCapture('这个命令不存在-xyz', { cwd: tmpdir() })

  assert.equal(result.ok, false)
  assert.ok(result.output.length > 0)
})

test('输出太长时只留尾巴', () => {
  const result = runCommandCapture('node -e "for(let i=0;i<5000;i++)console.log(i)"', {
    cwd: tmpdir(),
  })

  assert.equal(result.ok, true)
  assert.ok(result.output.length <= 4000, `实际 ${result.output.length}`)
})

test('tail 只留最后几行，并丢掉空行', () => {
  assert.deepEqual(tail('a\nb\n\nc\n', 2), ['b', 'c'])
  assert.deepEqual(tail('', 5), [])
})
