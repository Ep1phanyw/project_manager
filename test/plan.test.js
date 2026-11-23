import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { createFsStore } from '../lib/store.js'

function memoryStore() {
  const projects = new Map()

  return {
    listProjects: () => [...projects.keys()].sort(),
    read: (slug) => projects.get(slug) ?? null,
    write: (slug, documents) => {
      const current = projects.get(slug) ?? { project: null, acceptance: null, plan: null }
      projects.set(slug, { ...current, ...documents })
    },
  }
}

function withProject(store = memoryStore()) {
  const state = createProjectState({ store })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: ['能登录'] })
  return { store, state }
}

const TWO_PARTS = [
  { title: '做登录页', files: ['src/login.js'], evidence: 'test' },
  { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'build' },
]

test('合法计划落盘，并在 status 里看得到每个部分', () => {
  const { state } = withProject()

  const result = state.submitPlan({ parts: TWO_PARTS })

  assert.equal(result.ok, true)

  const { project } = state.status()
  assert.equal(project.parts.length, 2)
  assert.deepEqual(project.parts[0], {
    id: 'P1',
    title: '做登录页',
    dependsOn: [],
    files: ['src/login.js'],
    evidence: 'test',
  })
  assert.deepEqual(project.parts[1].dependsOn, ['P1'])
  assert.equal(project.parts[1].evidence, 'build')
})

test('计划写入文件后，换一个全新实例仍能读回 —— 依赖与文件集不丢', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-manager-'))
  try {
    const root = join(workspace, '.scratch')
    const writer = createProjectState({ store: createFsStore(root) })
    writer.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: ['能登录'] })
    writer.submitPlan({ parts: TWO_PARTS })

    const reader = createProjectState({ store: createFsStore(root) })
    const { project } = reader.status()

    assert.deepEqual(project.parts, [
      {
        id: 'P1',
        title: '做登录页',
        dependsOn: [],
        files: ['src/login.js'],
        evidence: 'test',
      },
      {
        id: 'P2',
        title: '接后端',
        dependsOn: ['P1'],
        files: ['src/api.js'],
        evidence: 'build',
      },
    ])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('依赖指向不存在的部分时被拒，并指出是哪一条', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test' },
      { title: '接后端', dependsOn: ['P9'], files: ['src/api.js'], evidence: 'build' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /P9/)
  assert.match(result.problem, /P2/)
})

test('依赖成环时被拒，并指出环上的部分', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', dependsOn: ['P2'], files: ['a.js'], evidence: 'test' },
      { title: '乙', dependsOn: ['P1'], files: ['b.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /环/)
  assert.match(result.problem, /P1/)
  assert.match(result.problem, /P2/)
})

test('文件集重叠却没有先后关系时被拒，并指出是哪两个部分', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/login.js'], evidence: 'test' },
      { title: '乙', files: ['src/login.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /P1/)
  assert.match(result.problem, /P2/)
  assert.match(result.problem, /src\/login\.js/)
})

test('文件集重叠但有先后关系时放行', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/login.js'], evidence: 'test' },
      { title: '乙', dependsOn: ['P1'], files: ['src/login.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, true)
})

test('间接的先后关系也算数：P1 → P2 → P3 时 P1 与 P3 不算冲突', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '一', files: ['src/login.js'], evidence: 'test' },
      { title: '二', dependsOn: ['P1'], files: ['src/middle.js'], evidence: 'test' },
      { title: '三', dependsOn: ['P2'], files: ['src/login.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, true)
})

test('文件路径写成 ./src/x.js 与 src/x.js 视为同一个文件', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/login.js'], evidence: 'test' },
      { title: '乙', files: ['./src/login.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /先后/)
})

test('证据类型不在允许集合内时被拒，并列出允许值', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [{ title: '甲', files: ['a.js'], evidence: 'screenshot' }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /screenshot/)
  for (const allowed of ['test', 'build', 'command', 'artifact']) {
    assert.match(result.problem, new RegExp(allowed))
  }
})

test('部分缺文件集或标题时被拒', () => {
  const { state } = withProject()

  const noFiles = state.submitPlan({
    parts: [{ title: '甲', files: [], evidence: 'test' }],
  })
  assert.equal(noFiles.ok, false)
  assert.match(noFiles.problem, /文件/)

  const noTitle = state.submitPlan({
    parts: [{ title: '  ', files: ['a.js'], evidence: 'test' }],
  })
  assert.equal(noTitle.ok, false)
  assert.match(noTitle.problem, /标题|名字/)
})

test('空计划被拒', () => {
  const { state } = withProject()

  const result = state.submitPlan({ parts: [] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /计划|至少/)
})

test('还没有项目时不能提交计划', () => {
  const state = createProjectState({ store: memoryStore() })

  const result = state.submitPlan({ parts: TWO_PARTS })

  assert.equal(result.ok, false)
  assert.match(result.problem, /项目/)
})

test('计划被拒时不落盘，原有状态不动', () => {
  const { store, state } = withProject()
  const before = store.read('demo')

  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'nope' }] })

  assert.deepEqual(store.read('demo'), before)
})

test('status 文本里能看见每个部分、依赖与证据', () => {
  const { state } = withProject()
  state.submitPlan({ parts: TWO_PARTS })
  const { project } = state.status()

  const text = formatStatus(project)

  assert.match(text, /P1/)
  assert.match(text, /做登录页/)
  assert.match(text, /P2/)
  assert.match(text, /接后端/)
  assert.match(text, /test/)
  assert.match(text, /build/)
  assert.match(text, /P1/)
})
