import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

function withPlan() {
  const store = memoryStore()
  const state = createProjectState({ store, now: () => Date.parse(AT) })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: ['能登录'] })
  state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test' },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test' },
    ],
  })
  return { store, state }
}

test('提交计划后阶段变成待批准', () => {
  const { state } = withPlan()

  const { project } = state.status()

  assert.equal(project.phase, 'awaiting-approval')
})

test('还没批准时取下一个部分会被挡住', () => {
  const { state } = withPlan()

  const result = state.nextPart()

  assert.equal(result.ok, false)
  assert.match(result.problem, /批准/)
})

test('还没计划时不能批准', () => {
  const state = createProjectState({ store: memoryStore(), now: () => Date.parse(AT) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })

  const result = state.approvePlan({ by: 'user' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /计划/)
})

test('模型侧发起的批准被拒，计划仍处于待批准', () => {
  const { state } = withPlan()

  const result = state.approvePlan({ by: 'model' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)

  assert.equal(state.status().project.phase, 'awaiting-approval')
})

test('用户批准后阶段变成执行，且取得到第一个部分', () => {
  const { state } = withPlan()

  const approved = state.approvePlan({ by: 'user' })
  assert.equal(approved.ok, true)

  const { project } = state.status()
  assert.equal(project.phase, 'executing')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('批准会在状态里留痕：记下是谁、什么时候', () => {
  const { state } = withPlan()

  state.approvePlan({ by: 'user' })

  const { project } = state.status()
  assert.equal(project.approvals.length, 1)
  assert.equal(project.approvals[0].kind, 'approved')
  assert.equal(project.approvals[0].at, AT)

  assert.match(formatStatus(project), /批准/)
})

test('批准记录会写进项目状态，换个实例仍能看到', () => {
  const workspace = memoryStore()
  const first = createProjectState({ store: workspace, now: () => Date.parse(AT) })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  first.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  first.approvePlan({ by: 'user' })

  const reopened = createProjectState({ store: workspace })
  const { project } = reopened.status()

  assert.equal(project.phase, 'executing')
  assert.equal(project.approvals.length, 1)
})

test('重复批准被拒，不会写出两条批准记录', () => {
  const { state } = withPlan()
  state.approvePlan({ by: 'user' })

  const again = state.approvePlan({ by: 'user' })

  assert.equal(again.ok, false)
  assert.equal(state.status().project.approvals.length, 1)
})

test('用户驳回后回到规划阶段，并能重新提交计划', () => {
  const { state } = withPlan()

  state.rejectPlan({ by: 'user', reason: '第二部分拆得太粗' })

  assert.equal(state.status().project.phase, 'planning')

  const resubmitted = state.submitPlan({
    parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }],
  })
  assert.equal(resubmitted.ok, true)
  assert.equal(state.status().project.phase, 'awaiting-approval')
})

test('驳回会留痕并记下理由', () => {
  const { state } = withPlan()

  state.rejectPlan({ by: 'user', reason: '第二部分拆得太粗' })

  const { project } = state.status()
  assert.equal(project.approvals.length, 1)
  assert.equal(project.approvals[0].kind, 'rejected')
  assert.equal(project.approvals[0].note, '第二部分拆得太粗')
  assert.match(formatStatus(project), /驳回/)
})

test('模型侧发起的驳回同样被拒', () => {
  const { state } = withPlan()

  const result = state.rejectPlan({ by: 'model', reason: '我觉得不行' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
  assert.equal(state.status().project.phase, 'awaiting-approval')
})

test('已批准的计划不能被直接覆盖，必须先驳回', () => {
  const { state } = withPlan()
  state.approvePlan({ by: 'user' })

  const overwrite = state.submitPlan({
    parts: [{ title: '偷偷换一份', files: ['a.js'], evidence: 'test' }],
  })

  assert.equal(overwrite.ok, false)
  assert.match(overwrite.problem, /驳回/)
})

test('有依赖时挑的是依赖已经满足的那个部分', () => {
  const store = memoryStore()
  const state = createProjectState({ store, now: () => Date.parse(AT) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({
    parts: [{ title: '甲', dependsOn: ['P2'], files: ['a.js'], evidence: 'test' },
            { title: '乙', files: ['b.js'], evidence: 'test' }],
  })
  state.approvePlan({ by: 'user' })

  const result = state.nextPart()

  assert.equal(result.ok, true)
  assert.equal(result.part.id, 'P2')
})
