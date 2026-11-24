import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { judged } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const NEEDS_LOOK = {
  ok: true,
  report: {
    status: 'needs-user-verification',
    summary: '登录页改好了，请看一眼风格对不对',
    evidence: ['artifact：/tmp/login.png', 'command：npm run dev 起得来'],
  },
}

const DONE_REPORT = {
  ok: true,
  report: {
    status: 'done',
    summary: '登录页做完了',
    evidence: ['test：node --test 全绿（12 条）'],
  },
}

function scenario(responses = [NEEDS_LOOK]) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => responses.shift() ?? NEEDS_LOOK,
  })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: judged(['能登录']) })
  state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })
  state.approvePlan({ by: 'user' })
  return { store, state }
}

test('子对话报「待确认」时项目停下，不派下一部分', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const next = state.nextPart()

  assert.equal(next.ok, false)
  assert.match(next.problem, /等你确认|待确认/)
})

test('停下时材料摊给用户看：摘要与证据都在', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const text = formatStatus(state.status().project)

  assert.match(text, /待你确认/)
  assert.match(text, /风格对不对/)
  assert.match(text, /login\.png/)
})

test('用户确认前这一部分不算完成，依赖它的部分派不出去', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  assert.equal(state.nextPart().ok, false)
  assert.equal(state.status().project.verified.size, 0)
})

test('用户确认后这一部分算完成，循环继续', async () => {
  const { state } = scenario([NEEDS_LOOK, DONE_REPORT])
  await state.dispatchNext()

  const confirmed = state.confirmPart({ by: 'user', part: 'P1' })
  assert.equal(confirmed.ok, true)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'confirmed')
  assert.equal(project.verified.has('P1'), true)

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P2')
})

test('用户确认可以不写说明，会记一句默认的', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.confirmPart({ by: 'user', part: 'P1' })

  assert.equal(result.ok, true)
  assert.match(state.status().project.records.at(-1).summary, /用户确认/)
})

test('模型侧不能替用户确认', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.confirmPart({ by: 'model', part: 'P1', reason: '我看着行' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
  assert.equal(state.status().project.partStatus.P1, 'needs-user-verification')
})

test('用户拒绝时这一部分回到可重派，并记下理由', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const declined = state.declinePart({ by: 'user', part: 'P1', reason: '风格和设计稿不一致' })
  assert.equal(declined.ok, true)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'declined')
  assert.match(project.records.at(-1).summary, /设计稿/)

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('用户拒绝也必须写理由', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.declinePart({ by: 'user', part: 'P1', reason: '  ' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /理由/)
})

test('没有待确认的部分时确认被拒', () => {
  const { state } = scenario()

  const result = state.confirmPart({ by: 'user', part: 'P1', reason: '看了' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /待确认|回报/)
})

test('已经确认过的部分不能再确认', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.confirmPart({ by: 'user', part: 'P1', reason: '看过' })

  const again = state.confirmPart({ by: 'user', part: 'P1', reason: '再看一次' })

  assert.equal(again.ok, false)
})

test('有部分在等确认时不能改计划 —— 改计划不能跳过用户', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /等你确认/)
})

test('停下的原因也能在状态文本里看到', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const text = formatStatus(state.status().project)

  assert.match(text, /待你确认/)
  assert.match(text, /风格/)
})
