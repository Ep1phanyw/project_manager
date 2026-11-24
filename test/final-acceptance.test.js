import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { checked } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：check 通过'] },
}

/** 部分验收时检查过；收尾时可以换成 fail，模拟「合起来跑就崩」。 */
function scenario() {
  const control = { code: 0 }
  const store = memoryStore()
  const state = createProjectState({
    runCommand: () => ({ code: control.code, output: control.code === 0 ? 'ok' : '断言失败' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => DONE,
  })

  state.startProject({ name: 'demo', goal: '把登录做出来', acceptance: checked(['能登录']) })
  state.submitPlan({ parts: [{ title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })

  return { store, state, control }
}

async function finishPart(state) {
  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })
}

test('收尾验收会重跑全部标准的检查，过了才进待用户验收', async () => {
  const { store, state } = scenario()
  await finishPart(state)

  const result = state.acceptRun({ summary: 'AC-1 跑过' })

  assert.equal(result.ok, true)
  const recorded = store.read('demo').acceptanceRun
  assert.match(recorded, /### 检查/)
  assert.match(recorded, /AC-1 通过/)
})

test('收尾时检查没过就不留任何待验收记录', async () => {
  const { store, state, control } = scenario()
  await finishPart(state)

  // 每个部分单独都过了，合起来再跑却崩了 —— 这正是收尾要抓的。
  control.code = 1
  const result = state.acceptRun({ summary: 'AC-1 跑过' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /收尾验收没通过/)
  assert.match(result.problem, /AC-1/)
  assert.ok(!store.read('demo').acceptanceRun, '失败不该留下待验收记录')

  const { project } = state.status('demo')
  assert.equal(project.allDone, false)
})

test('收尾通过后仍要用户点头才算完成', async () => {
  const { state } = scenario()
  await finishPart(state)
  state.acceptRun({ summary: 'AC-1 跑过' })

  assert.equal(state.status('demo').project.allDone, false)

  const accepted = state.acceptProject({ by: 'user' })
  assert.equal(accepted.ok, true)
  assert.equal(state.status('demo').project.allDone, true)
})

test('收尾检查失败时，模型不能靠一句「我做过了」把它变成通过', async () => {
  const { state, control } = scenario()
  await finishPart(state)

  control.code = 1
  const result = state.acceptRun({
    summary: '我看着都对',
    evidence: ['command：我确认过了'],
  })

  assert.equal(result.ok, false)
  assert.equal(state.status('demo').project.allDone, false)
})
