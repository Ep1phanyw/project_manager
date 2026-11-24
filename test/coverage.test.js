import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { formatStatus } from '../lib/format.js'
import { memoryStore } from './memory-store.js'
import { checked } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

function machine(store = memoryStore()) {
  return createProjectState({ runCommand: () => ({ code: 0, output: 'ok' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => ({
      ok: true,
      report: { status: 'done', summary: '做完了', evidence: ['test：node --test 全绿'] },
    }),
  })
}

function startTwo(state) {
  return state.startProject({ name: 'demo', goal: '把登录做出来', acceptance: checked(['能登录', '提示清楚']) })
}

function part(title, files, covers, extra = {}) {
  return { title, files, evidence: 'test', covers, ...extra }
}

test('提交计划时每个部分能声明它覆盖哪几条标准，落盘后读得回来', () => {
  const store = memoryStore()
  const state = machine(store)
  startTwo(state)

  const submitted = state.submitPlan({ parts: [part('做登录', ['src/login.js'], ['AC-1', 'AC-2'])] })
  assert.equal(submitted.ok, true)

  const { project } = state.status('demo')
  assert.deepEqual(project.parts[0].covers, ['AC-1', 'AC-2'])

  // 文件版格式：一块一行覆盖，写在计划里。
  assert.match(store.read('demo').plan, /- 覆盖：AC-1/)
  assert.match(store.read('demo').plan, /- 覆盖：AC-2/)
})

test('有标准没被任何部分覆盖时，计划被拒，并点名是哪一条', () => {
  const state = machine()
  startTwo(state)

  const result = state.submitPlan({ parts: [part('做登录', ['src/login.js'], ['AC-1'])] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /AC-2/)
  assert.match(result.problem, /没有.*覆盖|覆盖/)
})

test('覆盖了不存在的标准编号时，计划被拒', () => {
  const state = machine()
  startTwo(state)

  const result = state.submitPlan({
    parts: [part('做登录', ['src/login.js'], ['AC-1', 'AC-2', 'AC-9'])],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /AC-9/)
  assert.match(result.problem, /不存在|没有这条/)
})

test('一条标准被多个部分覆盖是合法的', () => {
  const state = machine()
  startTwo(state)

  const result = state.submitPlan({
    parts: [
      part('做登录', ['src/login.js'], ['AC-1']),
      part('补提示', ['src/message.js'], ['AC-1', 'AC-2']),
    ],
  })

  assert.equal(result.ok, true)

  const { project } = state.status('demo')
  assert.deepEqual(project.parts[1].covers, ['AC-1', 'AC-2'])
})

test('状态文本能看出每条标准被哪些部分覆盖', () => {
  const state = machine()
  startTwo(state)
  state.submitPlan({
    parts: [
      part('做登录', ['src/login.js'], ['AC-1']),
      part('补提示', ['src/message.js'], ['AC-2']),
    ],
  })

  const text = formatStatus(state.status('demo').project)

  assert.match(text, /AC-1[\s\S]*P1/)
  assert.match(text, /AC-2[\s\S]*P2/)
})

test('改覆盖关系等于改了这部分定义，旧验收记录不能冒充新定义', async () => {
  const state = machine()
  startTwo(state)
  state.submitPlan({
    parts: [
      part('做登录', ['src/login.js'], ['AC-1']),
      part('补提示', ['src/message.js'], ['AC-2']),
    ],
  })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  assert.equal(state.verifyPart({ part: 'P1', reason: 'AC-1 对上' }).ok, true)

  // P1 改成覆盖 AC-2：它不再是原来那件事，旧记录必须丢掉。
  const revised = state.submitPlan({
    parts: [
      part('做登录', ['src/login.js'], ['AC-2']),
      part('补提示', ['src/message.js'], ['AC-1']),
    ],
  })
  assert.equal(revised.ok, true)

  const { project } = state.status('demo')
  assert.equal(project.records.length, 0, '两个部分的定义都变了，旧记录都该被丢掉')
})
