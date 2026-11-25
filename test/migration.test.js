import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const LEGACY = {
  project:
    '# demo\n\n阶段：executing\n\n## 目标\n\n把登录做出来\n\n## 审批\n\n- 2026-11-23T05:00:00.000Z 批准\n',
  acceptance: '# 验收标准\n\n- [AC-1] 能登录\n- [AC-2] 提示清楚\n',
  plan: '# 计划\n\n## [P1] 做登录页\n\n- 依赖：无\n- 证据：test\n- 文件：src/login.js\n',
  parts: '# 部分记录\n',
}
function legacyProject() {
  const store = memoryStore()
  store.write('demo', LEGACY)
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => ({ ok: true, report: { status: 'done', summary: '做完了', evidence: ['test：ok'] } }),
  })
  return { store, state }
}

test('旧格式项目能看：标准读得出来，但标着是旧格式', () => {
  const { state } = legacyProject()

  const result = state.status('demo')

  assert.equal(result.ok, true)
  assert.equal(result.project.legacy, true)
  assert.deepEqual(
    result.project.acceptance.map((item) => [item.id, item.text, item.check.kind]),
    [
      ['AC-1', '能登录', 'judgement'],
      ['AC-2', '提示清楚', 'judgement'],
    ],
  )
})

test('旧格式项目不许动：派分与验收都提示先迁移', async () => {
  const { state } = legacyProject()

  const plan = state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  assert.equal(plan.ok, false)
  assert.match(plan.problem, /旧格式/)
  assert.match(plan.problem, /migrate/)

  const dispatch = await state.dispatchNext()
  assert.equal(dispatch.ok, false)
  assert.match(dispatch.problem, /旧格式/)
})

test('迁移保留原有批准：补上覆盖之后直接可派，不让人重走一遍', () => {
  const { store, state } = legacyProject()

  const result = state.migrateProject({ by: 'user' })

  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.equal(result.parts, 1)
  assert.equal(store.backupsFor('demo').length, 1, '迁移前必须留一份备份')
  assert.match(store.backupsFor('demo')[0].acceptance, /- \[AC-1\] 能登录/, '备份里是旧内容')

  const after = store.read('demo')
  assert.match(after.project, /格式：2/)
  assert.match(after.project, /阶段：executing/, '原来批过的，迁移后还是批过的')
  assert.match(after.project, /迁移：覆盖已自动分配/, '自动分配的覆盖要留痕')
  assert.match(after.project, /## 验收/)
  assert.match(after.acceptance, /## \[AC-1\] 能登录/)
  assert.match(after.acceptance, /- 检查：判断型/)
  assert.match(after.plan, /- 覆盖：AC-1/)
  assert.match(after.plan, /- 覆盖：AC-2/)

  const status = state.status('demo')
  assert.equal(status.ok, true)
  assert.equal(status.project.legacy, false)
  assert.equal(status.project.approved, true, '批准状态没被撤销')
  assert.equal(status.project.acceptance[0].check.kind, 'judgement')
  assert.equal(status.project.planProblem, '', '迁移后的计划要读得出来')

  // 不用再批准一次，直接就能派分。
  assert.equal(state.nextPart().ok, true)
})

test('没批准过的旧项目，迁移之后仍然要批准', () => {
  const store = memoryStore()
  store.write('demo', {
    project: '# demo\n\n阶段：planning\n\n## 目标\n\n把登录做出来\n',
    acceptance: '# 验收标准\n\n- [AC-1] 能登录\n',
    plan: '# 计划\n\n## [P1] 做登录页\n\n- 依赖：无\n- 证据：test\n- 文件：src/login.js\n',
    parts: '# 部分记录\n',
  })

  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => ({ ok: true, report: { status: 'done', summary: '做完了', evidence: ['test：ok'] } }),
  })

  assert.equal(state.migrateProject({ by: 'user' }).ok, true)

  const after = store.read('demo')
  assert.match(after.project, /阶段：awaiting-approval/, '没批过的仍然要先批准')

  const status = state.status('demo')
  assert.equal(status.project.approved, false)
  assert.equal(state.nextPart().ok, false)
})

test('迁移不丢历史记录，也不丢退役的编号', () => {
  const store = memoryStore()
  store.write('demo', {
    project:
      '# demo\n\n阶段：executing\n\n## 目标\n\n把登录做出来\n\n## 验收\n\n- AC-1 在\n- AC-2 退役\n\n## 审批\n\n- 2026-11-23T05:00:00.000Z 批准\n',
    acceptance: '# 验收标准\n\n- [AC-1] 能登录\n',
    plan: '# 计划\n\n## [P1] 做登录页\n\n- 依赖：无\n- 证据：test\n- 文件：src/login.js\n',
    parts: [
      '# 部分记录',
      '',
      '## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：done',
      '',
      '### 摘要',
      '',
      '  做完了',
      '',
    ].join('\n'),
  })

  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => ({ ok: true, report: { status: 'done', summary: '做完了', evidence: ['test：ok'] } }),
  })

  assert.equal(state.migrateProject({ by: 'user' }).ok, true)

  const after = store.read('demo')
  assert.match(after.project, /- AC-2 退役/, '退役登记不能因为迁移丢掉')
  assert.match(after.parts, /第 1 次/, '历史记录不能因为迁移丢掉')

  const status = state.status('demo')
  assert.equal(status.project.records.length, 1)
  assert.equal(status.project.partStatus.P1, 'done')
})

test('迁移过的项目不能再迁一次', () => {
  const { state } = legacyProject()
  state.migrateProject({ by: 'user' })

  const again = state.migrateProject({ by: 'user' })

  assert.equal(again.ok, false)
  assert.match(again.problem, /已经是当前格式/)
})

test('迁移只认用户', () => {
  const { state } = legacyProject()

  const result = state.migrateProject({ by: 'model' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
})
