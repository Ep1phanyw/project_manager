import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { checked, judged } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE_REPORT = {
  ok: true,
  report: { status: 'done', summary: '登录页做完了', evidence: ['test：node --test 全绿（12 条）'] },
}

function scenario(responses = [DONE_REPORT], { failing = false } = {}) {
  const store = memoryStore()
  const state = createProjectState({
    runCommand: () => ({ code: failing ? 1 : 0, output: failing ? '断言失败：期望 2 得到 1' : 'ok' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => responses.shift() ?? DONE_REPORT,
  })
  state.startProject({ name: 'demo', goal: '把登录流程做出来', acceptance: checked(['能登录']) })
  state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test', covers: ['AC-1'] },
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

  const verified = state.verifyPart({ part: 'P1', reason: 'AC-1 由测试覆盖' })
  assert.equal(verified.ok, true)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'accepted')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P2')
})

test('验收结论由插件算出，理由只是备注', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'accepted')
  assert.equal(state.status().project.partStatus.P1, 'accepted')
})

test('还没有候选回报时不能验收', () => {
  const { state } = scenario()

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /回报/)
})

test('检查没过就自动打回，记录里写明哪条标准没过', async () => {
  const { state } = scenario([DONE_REPORT], { failing: true })
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'returned')
  assert.deepEqual(result.failures, ['AC-1'])
  assert.equal(state.status().project.partStatus.P1, 'returned')

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('模型传 verdict 不起作用：结论只看检查结果', async () => {
  const { state } = scenario()
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1', reason: '我觉得不行' })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'accepted', '检查全过就是过，模型说什么不算')
})

test('打回后重派，轮次递增，失败明细留在历史里', async () => {
  const { state } = scenario([DONE_REPORT, DONE_REPORT], { failing: true })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  const second = await state.dispatchNext()

  assert.equal(second.part.id, 'P1')
  assert.equal(second.attempt, 2)

  const { project } = state.status()
  const returned = project.records.find((record) => record.status === 'returned')
  assert.match(returned.summary, /AC-1/)
  assert.equal(returned.checks[0].ok, false)
})

test('失败记录带着检查的原始输出，事后能逐条复核', async () => {
  const { store, state } = scenario([DONE_REPORT], { failing: true })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  const { project } = state.status()
  const returned = project.records.find((record) => record.status === 'returned')

  assert.equal(returned.checks.length, 1)
  assert.equal(returned.checks[0].id, 'AC-1')
  assert.match(returned.checks[0].detail, /退出码 1/)
  assert.match(returned.checks[0].detail, /断言失败/)
  assert.match(store.read('demo').parts, /### 检查/)
})

test('覆盖判断型标准的部分：检查全过后进待确认，不是直接算通过', async () => {
  const store = memoryStore()
  const state = createProjectState({
    runCommand: () => ({ code: 0, output: 'ok' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => DONE_REPORT,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: judged(['界面好看']) })
  state.submitPlan({
    parts: [{ title: '做界面', files: ['src/ui.js'], evidence: 'test', covers: ['AC-1'] }],
  })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'needs-user-verification')
  assert.deepEqual(result.judgements, ['AC-1'])
  assert.equal(state.status().project.partStatus.P1, 'needs-user-verification')

  // 用户点头之后才算完成 —— 判断型标准只归用户。
  assert.equal(state.confirmPart({ by: 'user', note: '看过了' }).ok, true)
  assert.equal(state.status().project.partStatus.P1, 'confirmed')
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

  state.verifyPart({ part: 'P1', reason: 'AC-1 对上' })

  const accepted = state.status().project.records.find((record) => record.status === 'accepted')
  assert.deepEqual(accepted.evidence, ['test：node --test 全绿（12 条）'])
})

test('未批准时不能验收', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  const result = state.verifyPart({ part: 'P1', reason: '看过了' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /批准/)
})

test('改了计划之后旧的验收不再作数', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', reason: 'AC-1 对上' })
  assert.equal(state.nextPart().part.id, 'P2')

  const revised = state.submitPlan({
    parts: [
      { title: '重做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '接后端', dependsOn: ['P1'], files: ['src/api.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })

  assert.equal(revised.ok, true)
  assert.equal(state.status().project.records.length, 0)
  assert.match(state.nextPart().problem, /批准/)
})

test('计划里没有这个部分时验收被拒', async () => {
  const { state } = scenario()

  const result = state.verifyPart({ part: 'P9', reason: '随便' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /P9/)
})
