import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { judged } from './fixtures.js'

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
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: judged(['能登录']) })
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

test('所有部分验收通过后进入收尾验收，而不是直接算完成', async () => {
  const { state } = scenario()
  await finishAll(state)

  const { project } = state.status()
  assert.equal(project.allPartsVerified, true)
  assert.equal(project.allDone, false, '部分做完 ≠ 项目完成')
  assert.match(formatStatus(project), /待收尾验收/)

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /收尾验收|manager_accept/)
})

test('跑完项目验收标准并经用户确认后，才算完成', async () => {
  const { state } = scenario()
  await finishAll(state)

  const run = state.acceptRun({
    summary: 'AC-1 到 AC-2 逐条跑过',
    evidence: ['test：跑了一遍端到端，全绿'],
  })
  assert.equal(run.ok, true, run.problem)

  const confirmed = state.acceptProject({ by: 'user' })
  assert.equal(confirmed.ok, true, confirmed.problem)

  const { project } = state.status()
  assert.equal(project.allDone, true)
  assert.match(formatStatus(project), /阶段：完成/)
})

test('收尾验收不能被模型自己确认', async () => {
  const { state } = scenario()
  await finishAll(state)
  state.acceptRun({ summary: '跑过了', evidence: ['test：全绿'] })

  const result = state.acceptProject({ by: 'model' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /只有用户/)
})

test('收尾验收打回要写理由，并留在记录里', async () => {
  const { state } = scenario()
  await finishAll(state)
  state.acceptRun({ summary: '跑过了', evidence: ['test：全绿'] })

  const noReason = state.declineAcceptance({ by: 'user' })
  assert.equal(noReason.ok, false)

  const back = state.declineAcceptance({ by: 'user', reason: 'AC-2 没在真浏览器里看过' })
  assert.equal(back.ok, true, back.problem)

  const { project } = state.status()
  assert.equal(project.allDone, false)
  assert.equal(project.acceptancePending, false)
  assert.equal(project.acceptanceRun.at(-1).status, 'returned')
})

test('还有部分没过时，不许做收尾验收', async () => {
  const { state } = scenario()
  state.nextPart()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })

  const result = state.acceptRun({ summary: '跑了', evidence: ['test：全绿'] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /还有 1 个部分/)
})

test('完成的项目重开后仍显示完成', async () => {
  const store = memoryStore()
  const first = createProjectState({ store, now: () => Date.parse(AT), runChild: async () => DONE })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['一条']) })
  first.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  first.approvePlan({ by: 'user' })
  await first.dispatchNext()
  first.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })
  first.acceptRun({ summary: '跑了', evidence: ['test：全绿'] })
  first.acceptProject({ by: 'user' })

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
  first.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['一条']) })
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
  first.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['一条']) })
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
