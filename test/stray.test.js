/**
 * 越界改动检查 —— 用真实的临时 git 仓库验，不用桩。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { changedSinceHead, strayChanges } from '../lib/git.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-'))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' })

  git('init')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
  writeFileSync(join(dir, 'b.test.js'), 'test("b", () => {})\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'x.js'), 'export const x = 1\n')
  git('add', '-A')
  git('commit', '-m', 'init')

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('不是 git 仓库时返回 null，不报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-nogit-'))
  try {
    assert.equal(changedSinceHead(dir), null)
    assert.equal(strayChanges(dir, ['a.js']), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只改了声明的文件时，没有越界', () => {
  const { dir, cleanup } = gitRepo()
  try {
    writeFileSync(join(dir, 'a.js'), 'const a = 2\n')

    assert.deepEqual(strayChanges(dir, ['a.js']), [])
  } finally {
    cleanup()
  }
})

test('改了声明之外的文件时能抓出来，并说清是改动还是删除', () => {
  const { dir, cleanup } = gitRepo()
  try {
    writeFileSync(join(dir, 'b.test.js'), 'test("b", () => {})\n// 少了一条断言\n')

    const stray = strayChanges(dir, ['a.js'])

    assert.equal(stray.length, 1)
    assert.match(stray[0], /b\.test\.js/)
    assert.match(stray[0], /改动/)
  } finally {
    cleanup()
  }
})

test('声明一个目录时，它下面的文件算覆盖到', () => {
  const { dir, cleanup } = gitRepo()
  try {
    writeFileSync(join(dir, 'src', 'x.js'), 'export const x = 2\n')

    assert.deepEqual(strayChanges(dir, ['src']), [])
  } finally {
    cleanup()
  }
})

test('写 ./a.js 与 a.js 视为同一个文件', () => {
  const { dir, cleanup } = gitRepo()
  try {
    writeFileSync(join(dir, 'a.js'), 'const a = 3\n')

    assert.deepEqual(strayChanges(dir, ['./a.js']), [])
  } finally {
    cleanup()
  }
})

test('未改动的仓库没有越界', () => {
  const { dir, cleanup } = gitRepo()
  try {
    assert.deepEqual(strayChanges(dir, ['a.js']), [])
  } finally {
    cleanup()
  }
})

test('派分时把越界改动记进记录', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    runChild: async () => ({
      ok: true,
      report: { status: 'done', summary: '做完了', evidence: ['test：绿'] },
    }),
    strayCheck: () => ['b.test.js（改动）'],
  })

  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })

  const result = await state.dispatchNext()

  assert.equal(result.ok, true, result.problem)
  assert.deepEqual(result.stray, ['b.test.js（改动）'])

  const latest = state.status().project.records.at(-1)
  assert.deepEqual(latest.stray, ['b.test.js（改动）'], '换个实例读回来也在')
})

test('越界检查自己抛错时不影响派分', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    runChild: async () => ({
      ok: true,
      report: { status: 'done', summary: '做完了', evidence: ['test：绿'] },
    }),
    strayCheck: () => {
      throw new Error('git 炸了')
    },
  })

  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })

  const result = await state.dispatchNext()

  assert.equal(result.ok, true)
  assert.deepEqual(result.stray, [])
})
