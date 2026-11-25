import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：ok'] },
}

const commandCheck = (text, extra = {}) => ({
  text,
  check: { kind: 'command', command: 'check', expectExit: 0, allowEmptyOutput: true, ...extra },
})

function machine(store, options = {}) {
  return createProjectState({
    store,
    now: () => Date.parse(AT),
    runChild: async () => DONE,
    ...options,
  })
}

test('旧文件里没写输出断言的命令检查仍然读得出来（按允许空输出处理）', () => {
  const store = memoryStore()
  store.write('demo', {
    project:
      '# demo\n\n阶段：executing\n\n格式：2\n\n## 目标\n\n做点事\n\n## 审批\n\n- 2026-11-23T05:00:00.000Z 批准\n',
    acceptance: '# 验收标准\n\n## [AC-1] 一条\n\n- 检查：命令 true\n- 期望退出码：0\n',
    plan: '# 计划\n\n## [P1] 甲\n\n- 依赖：无\n- 证据：test\n- 覆盖：AC-1\n- 文件：a.js\n',
    parts: '# 部分记录\n',
  })

  const state = machine(store, { runCommand: () => ({ code: 0, output: '' }) })
  const result = state.status('demo')

  assert.equal(result.ok, true)
  assert.equal(result.project.acceptance[0].check.allowEmptyOutput, true)
})

test('命令检查既没有输出断言、也没声明允许空输出 → 启动被拒', () => {
  const store = memoryStore()
  const state = machine(store, { runCommand: () => ({ code: 0, output: 'ok' }) })

  const result = state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: [{ text: '一条', check: { kind: 'command', command: 'true', expectExit: 0 } }],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /输出/)
  assert.match(result.problem, /允许空输出/)
})

test('声明允许空输出之后：启动通过，声明也落进文件、读得回来', () => {
  const store = memoryStore()
  const state = machine(store, { runCommand: () => ({ code: 0, output: '' }) })
  state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: [commandCheck('一条')],
  })

  const { project } = state.status('demo')
  assert.equal(project.acceptance[0].check.allowEmptyOutput, true)
  assert.match(store.read('demo').acceptance, /- 允许空输出：是/)
})

test('输出说自己零个用例通过 → 退出码 0 也算不过', async () => {
  const store = memoryStore()
  const state = machine(store, { runCommand: () => ({ code: 0, output: '# pass 0\n# fail 0' }) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'returned')
  assert.match(result.checks[0].detail, /零个用例通过/)
})

test('批准时预跑：开工前就已经绿的检查会被点名', () => {
  const store = memoryStore()
  const state = machine(store, { runCommand: () => ({ code: 0, output: 'ok' }) })

  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('已经做完的活')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  const approved = state.approvePlan({ by: 'user' })

  assert.equal(approved.ok, true)
  assert.deepEqual(approved.preRunGreen, ['AC-1「已经做完的活」'])
})

test('预跑可以关掉', () => {
  const store = memoryStore()
  const state = machine(store, {
    runCommand: () => ({ code: 0, output: 'ok' }),
    preRun: false,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })

  const approved = state.approvePlan({ by: 'user' })

  assert.equal(approved.ok, true)
  assert.equal(approved.preRunGreen, undefined)
})

test('有别的部分在跑的时候不许验收：工作区不干净，检查结果不可信', async () => {
  const store = memoryStore()
  const state = machine(store, { runCommand: () => ({ code: 0, output: 'ok' }) })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({
    parts: [
      { title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '乙', files: ['b.js'], evidence: 'test', covers: ['AC-1'] },
    ],
  })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  // 手工给 P2 留一条在飞记录，模拟「另一个部分还在跑」。
  store.write('demo', {
    parts: [
      '# 部分记录',
      '',
      '## [P1] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：done',
      '',
      '## [P2] 第 1 次 · 2026-11-23T06:00:00.000Z',
      '',
      '- 状态：running',
      '- 实例：pid-1',
      '',
    ].join('\n'),
  })

  const result = state.verifyPart({ part: 'P1' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /还有部分在跑/)
  assert.match(result.problem, /P2/)
})

test('长输出另存日志，记录里留指针', async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`)
  const store = memoryStore()
  const state = machine(store, {
    runCommand: () => ({ code: 1, output: lines.join('\n') }),
    writeLog: (slug, name, text) => store.writeLog(slug, name, text),
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()

  state.verifyPart({ part: 'P1' })

  const logs = store.logsFor('demo')
  assert.equal(logs.length, 1, '应另存一份完整输出')
  assert.match(store.readLog('demo', logs[0]), /第 30 行/)
  assert.match(store.read('demo').parts, /完整输出：\.scratch\/demo\/logs\//)
})

test('同一条标准换个错法（输出不同）不算「同样的失败」，不会误报阻塞', async () => {
  const control = { output: '第一次：端口占用' }
  const store = memoryStore()
  const state = machine(store, {
    runCommand: () => ({ code: 1, output: control.output }),
    preRun: false,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })

  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  control.output = '第二次：断言失败'
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1' })

  assert.equal(second.ok, true)
  assert.equal(second.blocked, undefined)
  assert.equal(state.status('demo').project.partStatus.P1, 'returned')
})

test('同样的失败（集合和输出都一样）仍然会自动阻塞', async () => {
  const store = memoryStore()
  const state = machine(store, {
    runCommand: () => ({ code: 1, output: '同样的错' }),
    preRun: false,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [commandCheck('一条')] })
  state.submitPlan({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })

  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })
  await state.dispatchNext()
  const second = state.verifyPart({ part: 'P1' })

  assert.equal(second.blocked, true)
  assert.equal(state.status('demo').project.partStatus.P1, 'blocked')
})
