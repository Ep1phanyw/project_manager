import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { formatBlockReport } from '../lib/format.js'
import { memoryStore } from './memory-store.js'
import { judged } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE_REPORT = {
  ok: true,
  report: {
    status: 'done',
    summary: '登录页做完了',
    evidence: ['test：node --test 全绿（12 条）'],
  },
}

function scenario(responses = [DONE_REPORT]) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => responses.shift() ?? DONE_REPORT,
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

test('同一部分连续两次同样的验收失败会自动进入阻塞', async () => {
  const { state } = scenario()

  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据里没有测试输出' })
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据里没有测试输出' })

  assert.equal(second.ok, true)
  assert.equal(second.blocked, true)

  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'blocked')
  assert.match(project.records.at(-1).summary, /连续两次/)
})

test('两次失败理由不同时不会自动阻塞', async () => {
  const { state } = scenario()

  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据里没有测试输出' })
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1', verdict: 'fail', reason: '登录页压根没写' })

  assert.equal(second.ok, true)
  assert.equal(second.blocked, undefined)
  assert.equal(state.status().project.partStatus.P1, 'returned')
})

test('阻塞后派分停下，并说明卡在哪', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })

  const next = state.nextPart()

  assert.equal(next.ok, false)
  assert.match(next.problem, /阻塞/)
})

test('子对话报阻塞时必须说明是三种情形里的哪一种', async () => {
  const { state } = scenario([
    {
      ok: true,
      report: { status: 'blocked', summary: '做不下去了', evidence: ['command：试过一次'] },
    },
  ])

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /情形/)
})

test('子对话说缺用户提供的东西时被接受，并记下缺什么', async () => {
  const { state } = scenario([
    {
      ok: true,
      report: {
        status: 'blocked',
        summary: '缺接口文档',
        evidence: ['command：ls docs（空）'],
        blockedCondition: 'missing-user-input',
        blockedReason: '需要你提供登录接口的文档或示例',
      },
    },
  ])

  const result = await state.dispatchNext()

  assert.equal(result.ok, true)
  const { project } = state.status()
  assert.equal(project.partStatus.P1, 'blocked')
  assert.match(project.records.at(-1).blockedReason, /登录接口的文档/)
})

test('子对话声称「连续失败」但不是事实时被拒', async () => {
  const { state } = scenario([
    {
      ok: true,
      report: {
        status: 'blocked',
        summary: '试过了',
        evidence: ['command：跑了一次'],
        blockedCondition: 'repeated-failure',
        blockedReason: '连续失败了',
      },
    },
  ])

  const result = await state.dispatchNext()

  assert.equal(result.ok, false)
  assert.match(result.problem, /连续/)
})

test('模型宣称阻塞时只接受三种情形，其他一律被拒', async () => {
  const { state } = scenario()

  for (const condition of ['太麻烦了', '想休息', '我觉得不行']) {
    const result = state.requestBlock({ part: 'P1', condition, detail: '随便' })
    assert.equal(result.ok, false, `${condition} 应被拒`)
  }
})

test('模型可以按「缺用户提供的东西」请求阻塞，并要说清缺什么', async () => {
  const { state } = scenario()

  const missing = state.requestBlock({ part: 'P1', condition: 'missing-user-input', detail: '' })
  assert.equal(missing.ok, false)
  assert.match(missing.problem, /缺什么/)

  const ok = state.requestBlock({
    part: 'P1',
    condition: 'missing-user-input',
    detail: '需要你确认登录页用哪个域名',
  })
  assert.equal(ok.ok, true)
  assert.equal(state.status().project.partStatus.P1, 'blocked')
})

test('模型按「要改验收标准」请求阻塞时要说明为什么现有标准做不到', async () => {
  const { state } = scenario()

  const bad = state.requestBlock({ part: 'P1', condition: 'criteria-change', detail: '' })
  assert.equal(bad.ok, false)
  assert.match(bad.problem, /缺什么|为什么/)

  const ok = state.requestBlock({
    part: 'P1',
    condition: 'criteria-change',
    detail: '现有 AC-1 要求邮箱登录，但这个项目只能用手机号',
  })
  assert.equal(ok.ok, true)
})

test('模型不能声称「连续失败」阻塞，除非记录里真的有', async () => {
  const { state } = scenario()

  const result = state.requestBlock({
    part: 'P1',
    condition: 'repeated-failure',
    detail: '我觉得它一直在失败',
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /连续/)
})

test('阻塞报告说清卡在哪、试过什么、需要你给什么', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据里没有测试输出' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '证据里没有测试输出' })

  const report = state.blockReport()

  assert.equal(report.ok, true)
  assert.equal(report.blocked.length, 1)

  const text = formatBlockReport(report.blocked)
  assert.match(text, /P1/)
  assert.match(text, /连续两次/)
  assert.match(text, /证据里没有测试输出/)
  assert.match(text, /试过/)
  assert.match(text, /第 1 次/)
  assert.match(text, /需要你/)
})

test('阻塞情形不接受原型上的名字', () => {
  const { state } = scenario()

  for (const condition of ['constructor', '__proto__', 'toString']) {
    const result = state.requestBlock({ part: 'P1', condition, detail: '随便' })
    assert.equal(result.ok, false, `${condition} 应被拒`)
  }
})

test('已经验收通过的部分不能再报阻塞', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: 'AC-1 对上' })

  const result = state.requestBlock({
    part: 'P1',
    condition: 'missing-user-input',
    detail: '想要点东西',
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /验收通过/)
})

test('有部分处于阻塞时不能改计划 —— 改计划不能替用户裁决', async () => {
  const { state } = scenario()
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'fail', reason: '同一个原因' })

  const result = state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /阻塞/)
})

test('批准之后手改验收标准会被发现，必须先重新批准', () => {
  const { store, state } = scenario()

  store.write('demo', {
    acceptance:
      '# 验收标准\n\n## [AC-1] 能登录\n\n- 检查：判断型\n\n## [AC-2] 悄悄加一条\n\n- 检查：判断型\n',
  })

  const next = state.nextPart()

  assert.equal(next.ok, false)
  assert.match(next.problem, /验收标准/)
})

test('没有阻塞时 blockReport 说没有', () => {
  const { state } = scenario()

  const report = state.blockReport()

  assert.equal(report.ok, false)
  assert.match(report.problem, /没有.*阻塞/)
})

test('状态机没有任何改验收标准的入口 —— 降低标准只能由用户改文件重新开始', () => {
  const { state } = scenario()

  for (const name of ['setAcceptance', 'updateAcceptance', 'relaxAcceptance', 'changeAcceptance']) {
    assert.equal(state[name], undefined, `${name} 不该存在`)
  }
})
