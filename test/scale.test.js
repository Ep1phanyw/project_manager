/**
 * 大项目真正需要的三条：增量改计划、收尾验收、每个部分一个快照。
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

function stateOn(store) {
  return createProjectState({ store, now: () => Date.parse(AT), runChild: async () => ({ ok: true, report: DONE }) })
}

/** 跑完 P1，让它带着一条验收通过记录。 */
async function finishP1(store) {
  let state = stateOn(store)
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })

  state = stateOn(store)
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })
  return state
}

test('改计划加一个新部分时，没动过的部分保留验收记录', async () => {
  const store = memoryStore()
  const state = await finishP1(store)

  const result = state.submitPlan({
    parts: [
      { id: 'P1', title: '甲', files: ['a.js'], evidence: 'test' },
      { id: 'P2', title: '乙', dependsOn: ['P1'], files: ['b.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.ok, true, result.problem)
  assert.equal(result.kept, 1)
  assert.equal(result.dropped, 1)

  const { project } = stateOn(store).status()
  assert.equal(project.verified.has('P1'), true, 'P1 的验收不能因为加了个部分就作废')
  assert.equal(project.allPartsVerified, false)
})

test('改了某个部分的定义，只有它的记录被丢掉', async () => {
  const store = memoryStore()
  const state = await finishP1(store)

  state.submitPlan({
    parts: [
      { id: 'P1', title: '甲改过了', files: ['a.js'], evidence: 'test' },
      { id: 'P2', title: '乙', dependsOn: ['P1'], files: ['b.js'], evidence: 'test' },
    ],
  })

  const { project } = stateOn(store).status()
  assert.equal(project.verified.has('P1'), false, '定义变了，旧的验收不能算数')
})

test('文件和依赖的顺序不同不算改定义', async () => {
  const store = memoryStore()
  const state = stateOn(store)
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({
    parts: [
      { id: 'P1', title: '甲', files: ['a.js', 'b.js'], evidence: 'test' },
      { id: 'P2', title: '乙', dependsOn: ['P1'], files: ['c.js'], evidence: 'test' },
    ],
  })
  state.approvePlan({ by: 'user' })

  const again = stateOn(store)
  await again.dispatchNext()
  again.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })

  const result = again.submitPlan({
    parts: [
      { id: 'P1', title: '甲', files: ['b.js', 'a.js'], evidence: 'test' },
      { id: 'P2', title: '乙', dependsOn: ['P1'], files: ['c.js'], evidence: 'test' },
    ],
  })

  assert.equal(result.kept, 2, '只是文件顺序不同，两个部分都不算改定义')
})

test('把阻塞的部分从计划里删掉是被允许的', async () => {
  const store = memoryStore()
  const state = stateOn(store)
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({
    parts: [
      { id: 'P1', title: '甲', files: ['a.js'], evidence: 'test' },
      { id: 'P2', title: '乙', files: ['b.js'], evidence: 'test' },
    ],
  })
  state.approvePlan({ by: 'user' })
  state.requestBlock({ part: 'P2', condition: 'missing-user-input', detail: '缺东西' })

  const result = state.submitPlan({ parts: [{ id: 'P1', title: '甲', files: ['a.js'], evidence: 'test' }] })

  assert.equal(result.ok, true, result.problem)
})

test('还在阻塞的部分留着，就不许改计划', () => {
  const store = memoryStore()
  const state = stateOn(store)
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ id: 'P1', title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  state.requestBlock({ part: 'P1', condition: 'missing-user-input', detail: '缺东西' })

  const result = state.submitPlan({ parts: [{ id: 'P1', title: '甲', files: ['a.js'], evidence: 'test' }] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /阻塞/)
})

test('验收通过时会打快照，失败不会', async () => {
  const calls = []
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: DONE }),
    snapshot: (input) => {
      calls.push(input.part.id)
      return { ok: true }
    },
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  const failed = state.verifyPart({ part: 'P1', verdict: 'fail', reason: '不对' })
  assert.equal(failed.ok, true)
  assert.deepEqual(calls, [], '验收不通过不该打快照')

  // 打回之后要重新派分、拿到新的候选回报，才能再验收。
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })
  assert.deepEqual(calls, ['P1'])
})

test('快照自己抛错不影响验收', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: DONE }),
    snapshot: () => {
      throw new Error('git 不在')
    },
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: ['一条'] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1', verdict: 'pass', reason: '对上' })

  assert.equal(result.ok, true)
  assert.equal(result.snapshot.ok, false)
  assert.match(result.snapshot.problem, /git 不在/)
})
