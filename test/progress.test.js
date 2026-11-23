import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: {
    status: 'done',
    summary: '做完了',
    evidence: ['test：node --test 全绿'],
  },
}

function scenario(responses = [DONE, DONE]) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => responses.shift() ?? DONE,
  })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: ['能登录'] })
  state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test' },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test' },
    ],
  })
  state.approvePlan({ by: 'user' })
  return { store, state }
}

async function finishAll(state) {
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: 'AC-1 对上' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P2', verdict: 'pass', reason: 'AC-1 端到端对上' })
}

test('所有部分验收通过后显示完成，且不再派分', async () => {
  const { state } = scenario()
  await finishAll(state)

  const { project } = state.status()
  assert.equal(project.allDone, true)
  assert.match(formatStatus(project), /阶段：完成/)

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /完成/)
})

test('完成的项目重开后仍显示完成', async () => {
  const store = memoryStore()
  const first = createProjectState({ store, now: () => Date.parse(AT), runChild: async () => DONE })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  first.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  first.approvePlan({ by: 'user' })
  await first.dispatchNext()
  first.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })

  const reopened = createProjectState({ store })
  const { project } = reopened.status()

  assert.equal(project.allDone, true)
  assert.match(formatStatus(project), /完成/)
})

test('状态里能看到每个部分的重试次数', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据不足' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: '这次对上了' })

  const text = formatStatus(state.status().project)

  assert.match(text, /重试 2 次/)
})

test('阻塞的项目重开后仍显示同一个阻塞原因', async () => {
  const store = memoryStore()
  const first = createProjectState({ store, now: () => Date.parse(AT), runChild: async () => DONE })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  first.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  first.approvePlan({ by: 'user' })
  await first.dispatchNext()
  first.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })
  await first.dispatchNext()
  first.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })

  const reopened = createProjectState({ store })
  const report = reopened.blockReport()

  assert.equal(report.ok, true)
  assert.equal(report.blocked[0].id, 'P1')
  assert.match(report.blocked[0].condition, /连续两次/)
})

test('用户处理完阻塞后可以恢复，项目重新可派分', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })

  assert.equal(state.nextPart().ok, false)

  const resolved = state.resolvePart({
    by: 'user',
    part: 'P1',
    reason: '接口文档已经补进仓库了，按新文档重做',
  })
  assert.equal(resolved.ok, true)

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('恢复阻塞只认用户，且要写说明', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })

  const byModel = state.resolvePart({ by: 'model', part: 'P1', reason: '我来处理' })
  assert.equal(byModel.ok, false)
  assert.match(byModel.problem, /用户/)

  const noReason = state.resolvePart({ by: 'user', part: 'P1', reason: '' })
  assert.equal(noReason.ok, false)
  assert.match(noReason.problem, /理由/)
})

test('没有阻塞时不能恢复', () => {
  const { state } = scenario()

  const result = state.resolvePart({ by: 'user', part: 'P1', reason: '随便' })

  assert.equal(result.ok, false)
})

test('重开后能接着跑，不需要重新批准计划', async () => {
  const store = memoryStore()
  const first = createProjectState({ store, now: () => Date.parse(AT), runChild: async () => DONE })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  first.submitPlan({
    parts: [
      { title: '甲', files: ['a.js'], evidence: 'test' },
      { title: '乙', dependsOn: ['P1'], files: ['b.js'], evidence: 'test' },
    ],
  })
  first.approvePlan({ by: 'user' })
  await first.dispatchNext()
  first.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })

  const reopened = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => DONE,
  })

  const next = reopened.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P2')
})
