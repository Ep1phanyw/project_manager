import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'
import { checked } from './fixtures.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：ok'] },
}

const CONTRACT_FILE = 'test/login.test.js'

/** 一个会变的文件表：改掉它的值，就模拟「契约文件被人动了」。 */
function scenario(files = { [CONTRACT_FILE]: 'a1b2c3d4e5f60718' }) {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    fileHash: (path) => files[path] ?? null,
  })

  state.startProject({
    name: 'demo',
    goal: '把登录做出来',
    acceptance: checked(['能登录']),
    protectedFiles: [CONTRACT_FILE],
  })
  state.submitPlan({
    parts: [{ title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] }],
  })

  return { store, state, files }
}

test('批准时给契约文件钉指纹，落在项目状态里', () => {
  const { store, state } = scenario()

  const approved = state.approvePlan({ by: 'user' })

  assert.equal(approved.ok, true)
  const text = store.read('demo').project
  assert.match(text, /## 契约/)
  assert.match(text, new RegExp(`- ${CONTRACT_FILE.replace(/\./g, '\\.')} a1b2c3d4e5f60718`))
})

test('批准时契约文件读不到，就不许批准', () => {
  const { state } = scenario({})

  const approved = state.approvePlan({ by: 'user' })

  assert.equal(approved.ok, false)
  assert.match(approved.problem, /契约文件/)
  assert.match(approved.problem, /读不到/)
})

test('计划想改契约文件，直接被拒', () => {
  const { state } = scenario()

  const result = state.submitPlan({
    parts: [
      {
        title: '顺手改测试',
        files: [CONTRACT_FILE],
        evidence: 'test',
        covers: ['AC-1'],
      },
    ],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /契约文件/)
  assert.match(result.problem, /不许动/)
})

test('契约文件被改之后：不能派新活，也不能验收', async () => {
  const { state, files } = scenario()
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  files[CONTRACT_FILE] = '0f1e2d3c4b5a6978'

  const dispatch = await state.dispatchAll()
  assert.equal(dispatch.ok, false)
  assert.match(dispatch.problem, /验收依据被改过/)

  const verify = state.verifyPart({ part: 'P1' })
  assert.equal(verify.ok, false)
  assert.match(verify.problem, /contract/)
})

test('用户重新钉指纹后，退回待批准，重新批准才能继续', async () => {
  const { store, state, files } = scenario()
  state.approvePlan({ by: 'user' })
  files[CONTRACT_FILE] = '0f1e2d3c4b5a6978'

  const reopened = state.reopenContract({ by: 'user' })

  assert.equal(reopened.ok, true)
  assert.equal(reopened.count, 1)
  assert.match(store.read('demo').project, /- test\/login\.test\.js 0f1e2d3c4b5a6978/)
  assert.match(store.read('demo').project, /契约指纹更新/)

  // 退回待批准：批准之前不能派分。
  const blocked = await state.dispatchAll()
  assert.equal(blocked.ok, false)
  assert.match(blocked.problem, /待批准|尚未批准/)

  assert.equal(state.approvePlan({ by: 'user' }).ok, true)
  assert.equal((await state.dispatchAll()).ok, true)
})

test('收尾验收也会核对契约文件', async () => {
  const { state, files } = scenario()
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  files[CONTRACT_FILE] = '0f1e2d3c4b5a6978'

  const result = state.acceptRun({ summary: 'AC-1 跑过' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /验收依据被改过/)
})

test('重新钉指纹只认用户', () => {
  const { state } = scenario()

  const result = state.reopenContract({ by: 'model' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
})

test('没有契约文件的项目，契约检查不干扰任何流程', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: checked(['一条']) })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  assert.equal(state.approvePlan({ by: 'user' }).ok, true)
  await state.dispatchNext()
  assert.equal(state.verifyPart({ part: 'P1' }).ok, true)

  const reopened = state.reopenContract({ by: 'user' })
  assert.equal(reopened.ok, false)
  assert.match(reopened.problem, /没有契约文件/)
})
