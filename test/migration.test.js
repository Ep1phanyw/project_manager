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

test('迁移先备份，再把标准迁成新格式并退回规划阶段', () => {
  const { store, state } = legacyProject()

  const result = state.migrateProject({ by: 'user' })

  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.equal(store.backupsFor('demo').length, 1, '迁移前必须留一份备份')
  assert.match(store.backupsFor('demo')[0].acceptance, /- \[AC-1\] 能登录/, '备份里是旧内容')

  const after = store.read('demo')
  assert.match(after.project, /格式：2/)
  assert.match(after.project, /阶段：planning/)
  assert.match(after.project, /## 验收/)
  assert.match(after.acceptance, /## \[AC-1\] 能登录/)
  assert.match(after.acceptance, /- 检查：判断型/)

  const status = state.status('demo')
  assert.equal(status.ok, true)
  assert.equal(status.project.legacy, false)
  assert.equal(status.project.acceptance[0].check.kind, 'judgement')
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
