import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

function approvedProject(runChild) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild,
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

const GOOD_REPORT = {
  status: 'done',
  summary: '登录页做完了',
  evidence: ['test：node --test 全绿（12 条）'],
}

test('合规的回报会被记进这个部分', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: { ...GOOD_REPORT, sessionId: 'sess-1' },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, true)
  assert.equal(result.part.id, 'P1')
  assert.equal(result.attempt, 1)
  assert.equal(result.report.status, 'done')

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'done')
})

test('派分时把这一部分的任务描述交给子对话', async () => {
  let seen = null
  const { state } = approvedProject(async (task) => {
    seen = task
    return { ok: true, report: GOOD_REPORT }
  })

  await state.dispatchNext()

  assert.equal(seen.part.id, 'P1')
  assert.equal(seen.part.title, '做登录页')
  assert.deepEqual(seen.part.files, ['src/login.js'])
  assert.equal(seen.part.evidence, 'test')
  assert.equal(seen.attempt, 1)
  assert.match(seen.prompt, /做登录页/)
  assert.match(seen.prompt, /src\/login\.js/)
  assert.match(seen.prompt, /能登录/)
})

test('子对话自己失败时记为可重试，项目不崩', async () => {
  const { state } = approvedProject(async () => ({
    ok: false,
    problem: '子对话报错：模型超时',
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
  assert.match(result.problem, /超时/)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'failed')
})

test('子对话抛异常也被兜住，不会把状态机打挂', async () => {
  const { state } = approvedProject(async () => {
    throw new Error('炸了')
  })

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test('回报缺证据时被拒，并记下不合规', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: { status: 'done', summary: '做完了', evidence: [] },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /证据/)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'invalid')
})

test('回报状态值非法时被拒', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: { status: '差不多完成了', summary: '好了', evidence: ['x'] },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /状态/)
})

test('回报缺摘要时被拒', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: { status: 'done', summary: '  ', evidence: ['x'] },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /摘要/)
})

test('判为阻塞却没有理由时被拒', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: { status: 'blocked', summary: '卡住了', evidence: ['command：试过一次'] },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /阻塞/)
})

test('待用户确认是合法回报，不算完成', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: {
      status: 'needs-user-verification',
      summary: '界面改好了，请看一眼',
      evidence: ['artifact：/tmp/login.png'],
    },
  }))

  const result = await state.dispatchNext()

  assert.equal(result.ok, true)
  assert.equal(result.report.status, 'needs-user-verification')

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'needs-user-verification')
})

test('记录会落盘，换个实例仍能读回状态与轮次', async () => {
  const store = memoryStore()
  const first = createProjectState({ store, now: () => Date.parse(AT), runChild: async () => ({ ok: true, report: GOOD_REPORT }) })
  first.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  first.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  first.approvePlan({ by: 'user' })
  await first.dispatchNext()

  const reopened = createProjectState({ store })
  const { project } = reopened.status()

  assert.equal(project.partStatus.P1, 'done')
  assert.equal(project.records.length, 1)
  assert.equal(project.records[0].attempt, 1)
  assert.equal(project.records[0].sessionId, '')
})

test('子对话失败后可以重试，轮次递增且历史不丢', async () => {
  const replies = [{ ok: false, problem: '模型超时' }, { ok: true, report: GOOD_REPORT }]
  const { state } = approvedProject(async () => replies.shift())

  await state.dispatchNext()
  const second = await state.dispatchNext()

  assert.equal(second.attempt, 2)

  const { project } = state.status()
  assert.equal(project.records.length, 2)
  assert.equal(project.records[0].status, 'failed')
  assert.equal(project.records[1].status, 'done')
})

test('未批准时派分被挡住，子对话根本不会被起', async () => {
  let called = false
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => {
      called = true
      return { ok: true, report: GOOD_REPORT }
    },
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /尚未批准/)
  assert.equal(called, false)
})

test('没配子对话执行器时明确报错，而不是假装派了', async () => {
  const store = memoryStore()
  const state = createProjectState({ store, now: () => Date.parse(AT) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /子对话/)
})

test('第一个部分完成后，下一次派分轮到它后面的部分', async () => {
  const { state } = approvedProject(async () => ({ ok: true, report: GOOD_REPORT }))

  const first = await state.dispatchNext()
  const second = await state.dispatchNext()

  assert.equal(first.part.id, 'P1')
  assert.equal(second.part.id, 'P2')
})

test('部分报了阻塞时停下，不会反复重跑同一个部分', async () => {
  const { state } = approvedProject(async () => ({
    ok: true,
    report: {
      status: 'blocked',
      summary: '缺接口文档',
      evidence: ['command：ls docs（空）'],
      blockedReason: '需要用户提供接口文档',
    },
  }))

  assert.equal((await state.dispatchNext()).ok, true)

  const again = await state.dispatchNext()

  assert.equal(again.ok, false)
  assert.match(again.problem, /阻塞/)
})

test('状态文本里能看到每个部分最近一次的结果', async () => {
  const { state } = approvedProject(async () => ({ ok: true, report: GOOD_REPORT }))
  await state.dispatchNext()

  const text = formatStatus(state.status().project)

  assert.match(text, /P1/)
  assert.match(text, /做完了|完成/)
  assert.match(text, /P2/)
})
