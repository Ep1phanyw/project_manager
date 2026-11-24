/**
 * 证据不再只看格式：配了核对命令就由插件自己跑，不信文本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { checked } from './fixtures.js'

const AT = '2026-11-23T00:00:00.000Z'

const DONE = {
  status: 'done',
  summary: '做完了',
  evidence: ['test：157/157 通过'],
}

/** 一路跑到所有部分验收通过，停在收尾验收前。 */
async function verifiedProject(store, extra = {}) {
  const state = createProjectState({ runCommand: () => ({ code: 0, output: 'ok' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({ ok: true, report: DONE }),
    ...extra,
  })
  state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: checked(['一条']),
    verify: extra.verifyCommand,
  })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1', reason: '对上' })
  return state
}

test('核对命令会存进项目状态，换个实例读回来还在', async () => {
  const store = memoryStore()
  await verifiedProject(store, { verifyCommand: 'node test/run.js' })

  const reopened = createProjectState({ runCommand: () => ({ code: 0, output: 'ok' }), store })
  const { project } = reopened.status()

  assert.equal(project.verify, 'node test/run.js')
})

test('核对命令通过时，收尾验收才收下，并把真实输出写进证据', async () => {
  const store = memoryStore()
  const state = await verifiedProject(store, {
    verifyCommand: 'node test/run.js',
    runVerify: () => ({ ok: true, code: 0, output: '157 passed' }),
  })

  const result = state.acceptRun({ summary: '逐条跑过', evidence: ['test：我跑了'] })

  assert.equal(result.ok, true, result.problem)

  const record = state.status().project.acceptanceRun.at(-1)
  assert.ok(record.evidence.some((item) => item.includes('插件自己跑的')))
  assert.ok(record.evidence.some((item) => item.includes('157 passed')))
})

test('核对命令没通过时，收尾验收直接不算数，并给出真实输出', async () => {
  const store = memoryStore()
  const state = await verifiedProject(store, {
    verifyCommand: 'node test/run.js',
    runVerify: () => ({ ok: false, code: 1, output: '3 tests failed' }),
  })

  const result = state.acceptRun({ summary: '我觉得没问题', evidence: ['test：全绿'] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /核对命令没通过/)
  assert.match(result.problem, /3 tests failed/)
  assert.equal(state.status().project.acceptanceRun.length, 0, '没通过就不该留下记录')
})

test('核对命令抛错也按没通过处理，不会把验收放过去', async () => {
  const store = memoryStore()
  const state = await verifiedProject(store, {
    verifyCommand: 'node test/run.js',
    runVerify: () => {
      throw new Error('起不来')
    },
  })

  const result = state.acceptRun({ summary: '跑过了', evidence: ['test：全绿'] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /核对命令没通过/)
})

test('没配核对命令时照旧，只收文字证据', async () => {
  const store = memoryStore()
  const state = await verifiedProject(store, {})

  const result = state.acceptRun({ summary: '跑过了', evidence: ['test：全绿'] })

  assert.equal(result.ok, true, result.problem)
  const record = state.status().project.acceptanceRun.at(-1)
  assert.equal(
    record.evidence.some((item) => item.includes('插件自己跑的')),
    false,
  )
})

test('核对命令带换行会被拒 —— 否则状态文件会被写坏', () => {
  const state = createProjectState({ runCommand: () => ({ code: 0, output: 'ok' }), store: memoryStore(), now: () => Date.parse(AT) })

  const result = state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: checked(['一条']),
    verify: 'node a.js\nnode b.js',
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /换行/)
})
