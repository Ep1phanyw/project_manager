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
    check: { kind: 'command', command: 'check', expectExit: 0, allowEmptyOutput: true },
  }))
}

test('并行期间越界改动标成不可靠，串行时不标', async () => {
  const parts = [
    { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
    { title: '乙', files: ['b.js'], evidence: 'test', covers: ['AC-2'] },
  ]

  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    strayCheck: () => ['someone-else.js'],
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(2) })
  state.submitPlan({ parts })
  state.approvePlan({ by: 'user' })

  await state.dispatchAll()

  const text = store.read('demo').parts
  assert.match(text, /越界：someone-else\.js（并行期间不可靠）/)

  // 串行派分不带这个标记。
  const serialStore = memoryStore()
  const serial = createProjectState({
    store: serialStore,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    strayCheck: () => ['someone-else.js'],
  })
  serial.startProject({ name: 'demo', goal: '做点事', acceptance: acceptance(1) })
  serial.submitPlan({ parts: [parts[0]] })
  serial.approvePlan({ by: 'user' })
  await serial.dispatchNext()

  assert.doesNotMatch(serialStore.read('demo').parts, /不可靠/)
})

test('验收是串行的：两次验收的快照依次发生，不会交错', async () => {
  const order = []
  let active = 0

  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    snapshot: ({ part }) => {
      active += 1
      assert.equal(active, 1, '快照不该同时发生')
      order.push(part.id)
      active -= 1
      return { ok: true }
    },
  })
  state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: acceptance(2),
  })
  state.submitPlan({
    parts: [
      { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['b.js'], evidence: 'test', covers: ['AC-2'] },
    ],
  })
  state.approvePlan({ by: 'user' })

  await state.dispatchAll()
  state.verifyPart({ part: 'P1' })
  state.verifyPart({ part: 'P2' })

  assert.deepEqual(order, ['P1', 'P2'])
})
