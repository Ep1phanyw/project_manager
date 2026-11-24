import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { createFsStore } from '../lib/store.js'
import { memoryStore } from './memory-store.js'
import { judged } from './fixtures.js'

function withProject(store = memoryStore()) {
  const state = createProjectState({ store })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: judged(['能登录']) })
  return { store, state }
}

const TWO_PARTS = [
  { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
  { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'build', covers: ['AC-1'] },
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
    origin: '',
    dependsOn: [],
    files: ['src/login.js'],
    evidence: 'test',
    covers: ['AC-1'],
  })
  assert.deepEqual(project.parts[1].dependsOn, ['P1'])
  assert.equal(project.parts[1].evidence, 'build')
})

test('计划写入文件后，换一个全新实例仍能读回 —— 依赖与文件集不丢', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'project_manager-'))
  try {
    const root = join(workspace, '.scratch')
    const writer = createProjectState({ store: createFsStore(root) })
    writer.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: judged(['能登录']) })
    writer.submitPlan({ parts: TWO_PARTS })

    const reader = createProjectState({ store: createFsStore(root) })
    const { project } = reader.status()

    assert.deepEqual(project.parts, [
      {
        id: 'P1',
        title: '做登录页',
        origin: '',
        dependsOn: [],
        files: ['src/login.js'],
        evidence: 'test',
        covers: ['AC-1'],
      },
      {
        id: 'P2',
        title: '接后端',
        origin: '',
        dependsOn: ['P1'],
        files: ['src/api.js'],
        evidence: 'build',
        covers: ['AC-1'],
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
      { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '接后端', dependsOn: ['P9'], files: ['src/api.js'], evidence: 'build', covers: ['AC-1'] },
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
      { title: '甲', dependsOn: ['P2'], files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', dependsOn: ['P1'], files: ['b.js'], evidence: 'test', covers: ['AC-1'] },
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
      { title: '甲', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
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
      { title: '甲', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', dependsOn: ['P1'], files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(result.ok, true)
})

test('间接的先后关系也算数：P1 → P2 → P3 时 P1 与 P3 不算冲突', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '一', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '二', dependsOn: ['P1'], files: ['src/middle.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '三', dependsOn: ['P2'], files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(result.ok, true)
})

test('文件路径写成 ./src/x.js 与 src/x.js 视为同一个文件', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['./src/login.js'], evidence: 'test', covers: ['AC-1'] },
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
    parts: [{ title: '甲', files: [], evidence: 'test', covers: ['AC-1'] }],
  })
  assert.equal(noFiles.ok, false)
  assert.match(noFiles.problem, /文件/)

  const noTitle = state.submitPlan({
    parts: [{ title: '  ', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }],
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

test('部分可以声明自己的来源，来源文件不存在时被拒', () => {
  const store = memoryStore()
  const state = createProjectState({ store, hasOrigin: (id) => id === '03' })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['一条']) })

  const ok = state.submitPlan({
    parts: [{ title: '甲', origin: '03', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }],
  })
  assert.equal(ok.ok, true)
  assert.equal(state.status().project.parts[0].origin, '03')

  const bad = state.submitPlan({
    parts: [{ title: '乙', origin: '99', files: ['b.js'], evidence: 'test', covers: ['AC-1'] }],
  })
  assert.equal(bad.ok, false)
  assert.match(bad.problem, /99/)
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

test('部分标题带换行时拒绝 —— 否则计划文件会被写坏且再也读不回来', () => {
  const { store, state } = withProject()

  const result = state.submitPlan({
    parts: [{ title: '做登录\n页', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /换行/)
  assert.equal(store.read('demo').plan, null)
})

test('文件路径里带逗号也能原样读回 —— 不靠分隔符拆分', () => {
  const { state } = withProject()
  const files = ['src/a,b.js', 'src/ c.js ']

  state.submitPlan({ parts: [{ title: '甲', files, evidence: 'test', covers: ['AC-1'] }] })

  const { project } = state.status()
  assert.deepEqual(project.parts[0].files, ['src/a,b.js', 'src/ c.js'])
})

test('部分编号可以自己指定，依赖按编号对得上', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { id: 'P7', title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
      { id: 'P8', title: '乙', dependsOn: ['P7'], files: ['b.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(result.ok, true)
  const { project } = state.status()
  assert.deepEqual(
    project.parts.map((part) => part.id),
    ['P7', 'P8'],
  )
  assert.deepEqual(project.parts[1].dependsOn, ['P7'])
})

test('自己依赖自己被判成环', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [{ id: 'P1', title: '甲', dependsOn: ['P1'], files: ['a.js'], evidence: 'test', covers: ['AC-1'] }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /环/)
})

test('计划文件被手工改坏时只降级计划，目标与验收标准仍然看得见', () => {
  const store = memoryStore()
  const state = createProjectState({ store })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['一条']) })
  store.write('demo', {
    plan: '# 计划\n\n## [P1] 甲\n\n这不是字段行\n',
  })

  const result = state.status()

  assert.equal(result.ok, true)
  assert.equal(result.project.goal, '做点事')
  assert.deepEqual(
    result.project.acceptance.map((item) => item.text),
    ['一条'],
  )
  assert.deepEqual(result.project.parts, [])
  assert.match(result.project.planProblem, /认不出来/)

  const text = formatStatus(result.project)
  assert.match(text, /做点事/)
  assert.match(text, /计划读不出来/)
})

test('目录与它下面的文件算同一片地方，没有先后关系就拒', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/auth/'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['src/auth/login.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /先后/)
})

test('目录重叠加了依赖就放行', () => {
  const { state } = withProject()

  const result = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/auth'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', dependsOn: ['P1'], files: ['src/auth/login.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(result.ok, true)
})
