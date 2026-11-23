import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE_REPORT = {
  ok: true,
  report: { status: 'done', summary: '登录页做完了', evidence: ['test：node --test 全绿（12 条）'] },
}

function scenario(responses = [DONE_REPORT]) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => responses.shift() ?? DONE_REPORT,
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

test('子对话报完成后不会自动算完成，依赖它的部分仍然派不出去', async () => {
  const { state } = scenario()

  await state.dispatchNext()

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'done')

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /验收/)
})

test('验收通过后这一部分才算完成，依赖放行', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const verified = state.verifyPart({ part: 'P1', verdict: 'pass', reason: 'AC-1 由测试覆盖' })
  assert.equal(verified.ok, true)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'accepted')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P2')
})

test('验收通过必须写理由，不然等于没人看过', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1', verdict: 'pass', reason: '  ' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /理由/)
  assert.equal(state.status().project.partStatus.P1, 'done')
})

test('还没有候选回报时不能验收', () => {
  const { state } = scenario()

  const result = state.verifyPart({ part: 'P1', verdict: 'pass', reason: '看着不错' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /回报/)
})

test('验收不通过要写理由，部分回到可重派', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({
    part: 'P1',
    verdict: 'fail',
    reason: '证据只有一句「全绿」，没有测试输出',
  })

  assert.equal(result.ok, true)
  assert.equal(state.status().project.partStatus.P1, 'returned')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('验收不通过但不写理由会被拒', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1', verdict: 'fail', reason: '' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /理由/)
})

test('不通过后重派，轮次递增，失败理由留在历史里', async () => {
  const { store, state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据不足：缺测试输出' })

  const second = await state.dispatchNext()

  assert.equal(second.part.id, 'P1')
  assert.equal(second.attempt, 2)

  const { project } = state.status()
  assert.equal(project.records.length, 3)
  assert.equal(project.records[1].status, 'returned')
  assert.match(project.records[1].summary, /缺测试输出/)
})

test('连续两次同样的失败理由可以被数出来 —— 供判断原因有没有变', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据不足：缺测试输出' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据不足：缺测试输出' })

  const { project } = state.status()
  const reasons = project.records
    .filter((record) => record.partId === 'P1' && record.status === 'returned')
    .map((record) => record.summary)

  assert.equal(reasons.length, 2)
  assert.equal(reasons[0], reasons[1])
})

test('验收结论只接受 pass 或 fail', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1', verdict: '差不多', reason: '还行' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /pass|fail/)
})

test('手写一条「验收通过」绕不过验收', () => {
  const { store, state } = scenario()
  store.write('demo', {
    parts:
      '# 部分记录\n\n## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z\n\n- 状态：accepted\n\n### 理由\n\n  OK\n',
  })

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'unverified-acceptance')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('验收通过的记录保留它所验收的证据，事后能复核', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  state.verifyPart({ part: 'P1', verdict: 'pass', reason: 'AC-1 对上' })

  const accepted = state.status().project.records.find((record) => record.status === 'accepted')
  assert.deepEqual(accepted.evidence, ['test：node --test 全绿（12 条）'])
})

test('未批准时不能验收', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })

  const result = state.verifyPart({ part: 'P1', verdict: 'pass', reason: '看过了' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /批准/)
})

test('改了计划之后旧的验收不再作数', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: 'AC-1 对上' })
  assert.equal(state.nextPart().part.id, 'P2')

  const revised = state.submitPlan({
    parts: [
      { title: '重做登录页', files: ['src/login.js'], evidence: 'test' },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test' },
    ],
  })

  assert.equal(revised.ok, true)
  assert.equal(state.status().project.records.length, 0)
  assert.match(state.nextPart().problem, /批准/)
})

test('计划里没有这个部分时验收被拒', async () => {
  const { state } = scenario()

  const result = state.verifyPart({ part: 'P9', verdict: 'pass', reason: '随便' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /P9/)
})
