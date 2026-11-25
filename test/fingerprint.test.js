import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createFingerprinter } from '../lib/fingerprint.js'

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project_manager-fp-'))
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'test', 'login.test.js'), 'assert(true)', 'utf8')
  return dir
}

test('文件指纹：内容不变就一样，改一个字就变', () => {
  const dir = workspace()
  try {
    const hash = createFingerprinter(dir)
    const first = hash('test/login.test.js')

    assert.match(first, /^[0-9a-f]{16}$/)
    assert.equal(hash('test/login.test.js'), first)

    writeFileSync(join(dir, 'test', 'login.test.js'), 'assert(false)', 'utf8')
    assert.notEqual(hash('test/login.test.js'), first)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录指纹：下面任何文件改了、加了、删了都会变', () => {
  const dir = workspace()
  try {
    const hash = createFingerprinter(dir)
    const first = hash('test')

    assert.match(first, /^[0-9a-f]{16}$/)

    writeFileSync(join(dir, 'test', 'other.test.js'), 'assert(true)', 'utf8')
    const added = hash('test')
    assert.notEqual(added, first, '加文件要变')

    writeFileSync(join(dir, 'test', 'other.test.js'), 'assert(false)', 'utf8')
    assert.notEqual(hash('test'), added, '改文件要变')

    rmSync(join(dir, 'test', 'other.test.js'))
    assert.equal(hash('test'), first, '删掉加的那个文件，回到原样')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不到的路径、越界的路径都返回 null', () => {
  const dir = workspace()
  try {
    const hash = createFingerprinter(dir)

    assert.equal(hash('nope/none.js'), null)
    assert.equal(hash('../outside.js'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
