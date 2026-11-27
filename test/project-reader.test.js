import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createProjectReader } from '../lib/project-reader.js'
import { createProjectState } from '../lib/project-state.js'
import { createFsStore } from '../lib/store.js'
import { judged } from './fixtures.js'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reader-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 在真实工作区里造一个项目：读路径要和真实落盘同一套存储。 */
function makeProject(dir, name, at = null) {
  const store = createFsStore(join(dir, '.scratch'))
  const state = createProjectState({ store, runCommand: () => ({ code: 0, output: 'ok' }) })

  const result = state.startProject({
    name,
    goal: '把这件事做完',
    acceptance: judged(['用户能看见结果']),
  })
  assert.equal(result.ok, true, result.problem)

  if (at !== null) {
    const file = join(dir, '.scratch', result.slug, 'project.md')
    utimesSync(file, at, at)
  }

  return result.slug
}

test('工作区里还没有 .scratch 时，列表是空的而不是报错', () => {
  const { dir, cleanup } = temp()
  try {
    const reader = createProjectReader({ workspace: dir })
    assert.deepEqual(reader.list(), { ok: true, projects: [] })
  } finally {
    cleanup()
  }
})

test('工作区不存在时，列表与读取都给明确错误并带上路径', () => {
  const { dir, cleanup } = temp()
  try {
    const missing = join(dir, 'nope')
    const reader = createProjectReader({ workspace: missing })

    const listed = reader.list()
    assert.equal(listed.ok, false)
    assert.match(listed.problem, /工作区不存在/)
    assert.ok(listed.problem.includes(missing))

    const read = reader.read('demo')
    assert.equal(read.ok, false)
    assert.match(read.problem, /工作区不存在/)
  } finally {
    cleanup()
  }
})

test('列表给出项目名与阶段，并按最后更新时间倒序', () => {
  const { dir, cleanup } = temp()
  try {
    const older = new Date('2026-01-01T00:00:00Z')
    const newer = new Date('2026-02-01T00:00:00Z')
    makeProject(dir, 'old-one', older)
    makeProject(dir, 'new-one', newer)

    const reader = createProjectReader({ workspace: dir })
    const result = reader.list()

    assert.equal(result.ok, true)
    assert.deepEqual(
      result.projects.map((item) => [item.slug, item.name, item.phase]),
      [
        ['new-one', 'new-one', 'planning'],
        ['old-one', 'old-one', 'planning'],
      ],
    )
    assert.equal(result.projects[0].updatedAt, newer.toISOString())
    assert.equal(result.projects[1].updatedAt, older.toISOString())
  } finally {
    cleanup()
  }
})

test('读取返回完整解析状态，不需要会话上下文', () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'demo')

    const result = createProjectReader({ workspace: dir }).read('demo')

    assert.equal(result.ok, true)
    assert.equal(result.project.slug, 'demo')
    assert.equal(result.project.goal, '把这件事做完')
    assert.deepEqual(
      result.project.acceptance.map((item) => [item.id, item.text]),
      [['AC-1', '用户能看见结果']],
    )
    assert.ok(result.updatedAt)
  } finally {
    cleanup()
  }
})

test('找不到项目时点名是哪个项目', () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'demo')
    const result = createProjectReader({ workspace: dir }).read('ghost')

    assert.equal(result.ok, false)
    assert.match(result.problem, /ghost/)
  } finally {
    cleanup()
  }
})

test('单个项目的状态读不懂只降级它自己，别的照常列出', () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'good')
    makeProject(dir, 'broken')
    writeFileSync(join(dir, '.scratch', 'broken', 'project.md'), '这不是一个项目文件\n', 'utf8')

    const result = createProjectReader({ workspace: dir }).list()

    assert.equal(result.ok, true)
    const bySlug = Object.fromEntries(result.projects.map((item) => [item.slug, item]))
    assert.equal(bySlug.good.ok, true)
    assert.equal(bySlug.broken.ok, false)
    assert.ok(bySlug.broken.problem)
  } finally {
    cleanup()
  }
})

test('没有项目名时不猜一个，直接说没指定', () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'demo')
    const result = createProjectReader({ workspace: dir }).read('   ')
    assert.equal(result.ok, false)
    assert.match(result.problem, /没有指定项目名/)
  } finally {
    cleanup()
  }
})

test('读取入口只有「列出」与「读取」，不暴露任何写操作', () => {
  const { dir, cleanup } = temp()
  try {
    const reader = createProjectReader({ workspace: dir })
    assert.deepEqual(Object.keys(reader).sort(), ['list', 'read'])
  } finally {
    cleanup()
  }
})

test('从 .scratch 里列项目时约过没有 project.md 的目录', () => {
  const { dir, cleanup } = temp()
  try {
    makeProject(dir, 'demo')
    mkdirSync(join(dir, '.scratch', 'not-a-project'), { recursive: true })

    const result = createProjectReader({ workspace: dir }).list()
    assert.deepEqual(
      result.projects.map((item) => item.slug),
      ['demo'],
    )
  } finally {
    cleanup()
  }
})
