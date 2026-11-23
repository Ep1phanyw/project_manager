/**
 * 回归用例：这几条缺陷当初都没有用例覆盖，所以全绿的测试没能拦住它们。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T00:00:00.000Z'

const DONE = {
  status: 'done',
  summary: '做完了',
  evidence: ['test：一条通过的用例'],
}

const WAITING = {
  status: 'needs-user-verification',
  summary: '做完了，但措辞要你看一眼',
  evidence: ['artifact：README 第 3 行'],
}

function setup() {
  const store = memoryStore()
  const state = createProjectState({ store, now: () => Date.parse(AT) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  return { store, state }
}

function approved(store) {
  const state = createProjectState({ store, now: () => Date.parse(AT) })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  return state
}

test('文件集写成「无」会被拒 —— 否则写出的计划永远读不回来', () => {
  const { state } = setup()

  const result = state.submitPlan({
    parts: [{ title: '甲', files: ['无'], evidence: 'test' }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /无/)
})

test('依赖写成「无」会被拒', () => {
  const { state } = setup()

  const result = state.submitPlan({
    parts: [{ title: '甲', dependsOn: ['无'], files: ['a.js'], evidence: 'test' }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /无/)
})

test('部分记录读不懂时派分停下，不会覆盖历史', async () => {
  const { store } = setup()
  const state = approved(store)

  store.write('demo', { parts: '这一行谁也认不出来\n' })

  const result = await state.nextPart()

  assert.equal(result.ok, false)
  assert.match(result.problem, /读不懂/)
})

test('部分记录读不懂时验收也停下', () => {
  const { store } = setup()
  const state = approved(store)

  store.write('demo', { parts: '这一行谁也认不出来\n' })

  const result = state.verifyPart({ part: 'P1', verdict: 'pass', reason: '看过了' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /读不懂/)
})

test('在等用户确认的部分不能被报阻塞 —— 那是用户的裁决', async () => {
  const store = memoryStore()
  let state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: WAITING }),
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state = approved(store)
  state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: WAITING }),
  })

  await state.dispatchNext()

  const result = state.requestBlock({ part: 'P1', condition: 'missing-user-input', detail: '缺东西' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /等用户确认/)
})

test('已经用户确认的部分不能再被报阻塞', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: WAITING }),
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  state.confirmPart({ by: 'user' })

  const result = state.requestBlock({ part: 'P1', condition: 'missing-user-input', detail: '缺东西' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /确认/)
})

test('验收通过后仍然不能再报阻塞 —— 老用例不许回退', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: DONE }),
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: '看过了' })

  const result = state.requestBlock({ part: 'P1', condition: 'missing-user-input', detail: '缺东西' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /验收通过/)
})
