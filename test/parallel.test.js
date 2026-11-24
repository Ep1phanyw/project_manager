import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：ok'] },
}

function acceptance(count) {
  return Array.from({ length: count }, (_, index) => ({
    text: `第 ${index + 1} 条`,
    check: { kind: 'command', command: 'check', expectExit: 0 },
  }))
}

function machine(store, { parts = [], maxParallel = 3, capacity = null, runChild } = {}) {
  return createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: runChild ?? (async () => DONE),
    maxParallel,
    capacity,
  })
}

function projectWith(parts, count = parts.length) {
  const store = memoryStore()
  const state = machine(store, { parts })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(count) })
  state.submitPlan({ parts })
  state.approvePlan({ by: 'user' })
  return { store, state }
}

const INDEPENDENT = [
  { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
  { title: '乙', files: ['b.js'], evidence: 'test', covers: ['AC-2'] },
]

test('互不依赖、文件集不相交的部分一次派出去，真的同时在跑', async () => {
  const seen = { now: 0, peak: 0 }
  const store = memoryStore()
  const state = machine(store, {
    runChild: async () => {
      seen.now += 1
      seen.peak = Math.max(seen.peak, seen.now)
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.now -= 1
      return DONE
    },
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(2) })
  state.submitPlan({ parts: INDEPENDENT })
  state.approvePlan({ by: 'user' })

  const result = await state.dispatchAll()

  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.deepEqual(result.parts, ['P1', 'P2'])
  assert.equal(seen.peak, 2, '两个子对话应该重叠')
  assert.equal(result.failed, 0)
})

test('一个部分在飞的时候，另一条在飞记录不会被覆盖掉', async () => {
  let atLaunch = ''
  const store = memoryStore()
  const state = machine(store, {
    runChild: async () => {
      // 等两个都真的起来了，再抓台账：这时两个都该在飞。
      await new Promise((resolve) => setTimeout(resolve, 1))
      if (!atLaunch) atLaunch = store.read('demo').parts
      await new Promise((resolve) => setTimeout(resolve, 5))
      return DONE
    },
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(2) })
  state.submitPlan({ parts: INDEPENDENT })
  state.approvePlan({ by: 'user' })

  await state.dispatchAll()

  assert.equal((atLaunch.match(/- 状态：running/g) ?? []).length, 2, '两条在飞都要留在台账上')
  const after = store.read('demo').parts
  assert.equal((after.match(/- 状态：running/g) ?? []).length, 0)
  assert.equal((after.match(/- 状态：done/g) ?? []).length, 2)
})

test('有依赖的部分不会和它的前置一起派', async () => {
  const { state } = projectWith([
    { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
    {
      title: '乙',
      files: ['b.js'],
      evidence: 'test',
      covers: ['AC-2'],
      dependsOn: ['P1'],
    },
  ])

  const result = await state.dispatchAll()

  assert.equal(result.count, 1)
  assert.deepEqual(result.parts, ['P1'])
})

test('改同一批文件的两个部分，计划层就不允许它们同时开工', async () => {
  const store = memoryStore()
  const state = machine(store)
  state.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(2) })

  // 没有先后关系就改同一批文件：计划直接被拒，用不到并行调度这一层。
  const submitted = state.submitPlan({
    parts: [
      { title: '甲', files: ['src/shared.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['src/shared.js'], evidence: 'test', covers: ['AC-2'] },
    ],
  })

  assert.equal(submitted.ok, false)
  assert.match(submitted.problem, /先后关系/)
})

test('一次最多派 min(配置, 平台剩余名额) 个', async () => {
  const parts = [
    { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
    { title: '乙', files: ['b.js'], evidence: 'test', covers: ['AC-2'] },
    { title: '丙', files: ['c.js'], evidence: 'test', covers: ['AC-3'] },
  ]

  const configured = projectWith(parts, 3)
  const one = await configure(configured.store, parts, { maxParallel: 1 })
  assert.equal(one.count, 1)

  const capped = projectWith(parts, 3)
  // 平台还剩 1 个名额：配置 8 也只能派 1 个。
  const byPlatform = await configure(capped.store, parts, {
    maxParallel: 8,
    capacity: () => ({ running: 2, limit: 3 }),
  })
  assert.equal(byPlatform.count, 1)

  const zero = projectWith(parts, 3)
  const none = await configure(zero.store, parts, {
    maxParallel: 3,
    capacity: () => ({ running: 3, limit: 3 }),
  })
  assert.equal(none.ok, false)
  assert.match(none.problem, /名额/)
})

test('平台没有报名额时按配置来，硬顶 8', async () => {
  const parts = Array.from({ length: 9 }, (_, index) => ({
    title: `部分${index + 1}`,
    files: [`f${index + 1}.js`],
    evidence: 'test',
    covers: [`AC-${index + 1}`],
  }))

  const { store } = projectWith(parts, 9)
  const result = await configure(store, parts, { maxParallel: 99 })

  assert.equal(result.ok, true)
  assert.equal(result.count, 8, '硬顶 8')
})

async function configure(store, parts, options) {
  const state = machine(store, options)
  return state.dispatchAll()
}
