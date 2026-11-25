import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：check-a 通过'] },
}

const TWO = [
  { text: '甲能跑', check: { kind: 'command', command: 'check-a', expectExit: 0, allowEmptyOutput: true } },
  { text: '乙能跑', check: { kind: 'command', command: 'check-b', expectExit: 0, allowEmptyOutput: true } },
]

/** 哪条命令该失败，由测试随时改 —— 这样两次失败的「集合」可以特意做成不同。 */
function scenario(failing = ['check-a']) {
  const control = { failing: new Set(failing) }
  const prompts = []
  const store = memoryStore()

  const state = createProjectState({
    runCommand: (command) => ({
      code: control.failing.has(command) ? 1 : 0,
      output: control.failing.has(command) ? `${command} 断言失败` : `${command} 通过`,
    }),
    store,
    now: () => Date.parse(AT),
    runChild: async (task) => {
      prompts.push(task.prompt)
      return DONE
    },
  })

  state.startProject({ name: 'demo', goal: '把甲和乙做出来', acceptance: TWO })
  state.submitPlan({
    parts: [
      { title: '一起做', files: ['src/both.js'], evidence: 'test', covers: ['AC-1', 'AC-2'] },
    ],
  })
  state.approvePlan({ by: 'user' })

  return { store, state, control, prompts }
}

test('下一次派分的任务描述里带着上一轮没过的地方与原始输出', async () => {
  const { state, prompts } = scenario()

  await state.dispatchNext()
  assert.doesNotMatch(prompts[0], /上一轮这里没过/)

  state.verifyPart({ part: 'P1' })
  await state.dispatchNext()

  assert.match(prompts[1], /上一轮这里没过/)
  assert.match(prompts[1], /AC-1：命令 check-a → 退出码 1/)
  assert.match(prompts[1], /check-a 断言失败/)
  assert.doesNotMatch(prompts[1], /AC-2：命令 check-b/)
})

test('两次打回的未通过集合相同 → 自动进入阻塞', async () => {
  const { state } = scenario(['check-a'])

  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1' })

  assert.equal(second.ok, true)
  assert.equal(second.blocked, true)
  assert.deepEqual(second.failures, ['AC-1'])
  assert.equal(state.status().project.partStatus.P1, 'blocked')
})

test('两次打回的集合不同 → 不按「重复失败」判阻塞', async () => {
  const { state, control } = scenario(['check-a'])

  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  control.failing = new Set(['check-b'])
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1' })

  assert.equal(second.ok, true)
  assert.equal(second.blocked, undefined)
  assert.deepEqual(second.failures, ['AC-2'])
  assert.equal(state.status().project.partStatus.P1, 'returned')
})

test('模型把理由写得一模一样也不算同样的失败 —— 只看集合', async () => {
  const { state, control } = scenario(['check-a'])

  await state.dispatchNext()
  state.verifyPart({ part: 'P1', reason: '同一条理由' })

  control.failing = new Set(['check-b'])
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1', reason: '同一条理由' })

  assert.equal(second.blocked, undefined, '理由相同、集合不同，不该判阻塞')
})
