import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { formatStatus } from '../lib/format.js'
import { memoryStore } from './memory-store.js'
import { checked } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：ok'] },
}

function scenario({ processId = 'pid-1', runChild } = {}) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    processId,
    runChild: runChild ?? (async () => DONE),
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: checked(['一条']) })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })
  return { store, state }
}

test('派分时写入在飞台账，回报之后台账清除', async () => {
  const { store, state } = scenario()

  let seen = ''
  const state2 = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    processId: 'pid-1',
    runChild: async (task) => {
      // 子对话跑的时候，盘上应该有一条「在飞」。
      seen = store.read('demo').parts
      return { ok: true, report: DONE.report }
    },
  })

  await state2.dispatchNext()

  assert.match(seen, /- 状态：running/)
  assert.match(seen, /- 实例：pid-1/)
  assert.doesNotMatch(store.read('demo').parts, /- 状态：running/, '回报之后在飞记录要消失')
})

test('有部分在飞时不许再派分', async () => {
  const { store, state } = scenario()
  // 手工造一条在飞记录：模拟「另一个派分还没回来」。
  store.write('demo', {
    parts: [
      '# 部分记录',
      '',
      '## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：running',
      '- 实例：pid-1',
      '',
    ].join('\n'),
  })

  const next = state.nextPart()

  assert.equal(next.ok, false)
  assert.match(next.problem, /正在派分中|在飞/)
})

test('别的进程留下的在飞记录算中断：状态可见、派分被挡、要用户解除', async () => {
  const { store, state } = scenario({ processId: 'pid-2' })
  store.write('demo', {
    parts: [
      '# 部分记录',
      '',
      '## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：running',
      '- 实例：pid-1（上一个进程）',
      '',
    ].join('\n'),
  })

  const { project } = state.status('demo')
  assert.equal(project.partStatus.P1, 'interrupted')
  assert.match(formatStatus(project), /中断/)

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /断在半路/)

  // 插件不会自己重派。
  assert.equal((await state.dispatchNext()).ok, false)

  // 用户解除之后才能继续。
  const resolved = state.resolvePart({ by: 'user', part: 'P1', reason: '上一次是机器重启' })
  assert.equal(resolved.ok, true)
  assert.equal(state.nextPart().ok, true)
})

test('解除中断只认用户', () => {
  const { store, state } = scenario({ processId: 'pid-2' })
  store.write('demo', {
    parts: [
      '# 部分记录',
      '',
      '## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：running',
      '- 实例：pid-1',
      '',
    ].join('\n'),
  })

  const result = state.resolvePart({ by: 'model', part: 'P1', reason: '我来处理' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
})

test('同进程的第二次派分不会把在飞记录落成两条', async () => {
  const { store } = scenario()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    processId: 'pid-1',
    runChild: async () => DONE,
  })

  await state.dispatchNext()
  const text = store.read('demo').parts
  assert.equal((text.match(/- 状态：running/g) ?? []).length, 0)
  assert.equal((text.match(/- 状态：done/g) ?? []).length, 1)
})
