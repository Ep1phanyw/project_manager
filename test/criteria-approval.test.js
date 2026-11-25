import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const DONE = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：ok'] },
}

function criterion(text, command, extra = {}) {
  return {
    text,
    check: { kind: 'command', command, expectExit: 0, allowEmptyOutput: true, ...extra },
  }
}

function acceptanceFile(checks) {
  return [
    '# 验收标准',
    '',
    ...checks.flatMap(([id, text, command]) => [
      `## [${id}] ${text}`,
      '',
      `- 检查：命令 ${command}`,
      '- 期望退出码：0',
      '- 允许空输出：是',
      '',
    ]),
  ].join('\n')
}

function scenario() {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    preRun: false,
  })

  state.startProject({
    name: 'demo',
    goal: '把两件事做出来',
    acceptance: [criterion('甲', 'check-a'), criterion('乙', 'check-b')],
  })
  state.submitPlan({
    parts: [
      { title: '做甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] },
      { title: '做乙', files: ['b.js'], evidence: 'test', covers: ['AC-2'] },
    ],
  })
  state.approvePlan({ by: 'user' })

  return { store, state }
}

test('改一条检查：只有这一条待批准，另一条的标准照常能派', async () => {
  const { store, state } = scenario()

  store.write('demo', {
    acceptance: acceptanceFile([
      ['AC-1', '甲', 'check-a2'],
      ['AC-2', '乙', 'check-b'],
    ]),
  })

  const { project } = state.status('demo')
  assert.deepEqual(project.pendingCriteria, ['AC-1'])

  const result = await state.dispatchAll()
  assert.equal(result.ok, true)
  assert.deepEqual(result.parts, ['P2'], '只派不覆盖待批准标准的那个部分')
})

test('覆盖待批准标准的部分：不能验收', async () => {
  const { store, state } = scenario()
  await state.dispatchNext() // P1 先做完

  store.write('demo', {
    acceptance: acceptanceFile([
      ['AC-1', '甲', 'check-a2'],
      ['AC-2', '乙', 'check-b'],
    ]),
  })

  const verify = state.verifyPart({ part: 'P1' })

  assert.equal(verify.ok, false)
  assert.match(verify.problem, /还没批准/)
  assert.match(verify.problem, /AC-1/)
})

test('单独批准之后项目仍在执行阶段，不退回待批准', () => {
  const { store, state } = scenario()

  store.write('demo', {
    acceptance: acceptanceFile([
      ['AC-1', '甲', 'check-a2'],
      ['AC-2', '乙', 'check-b'],
    ]),
  })

  const approved = state.approveCriteria({ by: 'user', ids: ['AC-1'] })

  assert.equal(approved.ok, true)
  const { project } = state.status('demo')
  assert.equal(project.phase, 'executing', '不退回待批准')
  assert.deepEqual(project.pendingCriteria, [])
})

test('按旧检查验收过的部分会标成需重验，可以重新派分', async () => {
  const { store, state } = scenario()
  await state.dispatchNext()
  assert.equal(state.verifyPart({ part: 'P1' }).ok, true)

  store.write('demo', {
    acceptance: acceptanceFile([
      ['AC-1', '甲', 'check-a2'],
      ['AC-2', '乙', 'check-b'],
    ]),
  })
  state.approveCriteria({ by: 'user', ids: ['AC-1'] })

  const { project } = state.status('demo')
  assert.equal(project.partStatus.P1, 'needs-reverify')
  assert.equal(project.verified.has('P1'), false)

  const next = state.nextPart()
  assert.equal(next.ok, true)
  assert.equal(next.part.id, 'P1')
})

test('还有标准待批准时不能做收尾验收', async () => {
  const store = memoryStore()
  const state = createProjectState({
    store,
    now: () => Date.parse(AT),
    runCommand: () => ({ code: 0, output: 'ok' }),
    runChild: async () => DONE,
    preRun: false,
  })
  state.startProject({ name: 'demo', goal: '做点事', acceptance: [criterion('甲', 'check-a')] })
  state.submitPlan({ parts: [{ title: '做甲', files: ['a.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })
  await state.dispatchNext()
  state.verifyPart({ part: 'P1' })

  store.write('demo', { acceptance: acceptanceFile([['AC-1', '甲', 'check-a2']]) })

  const result = state.acceptRun({ summary: '跑过' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /还没批准/)
})

test('单条批准只认用户', () => {
  const { store, state } = scenario()
  store.write('demo', {
    acceptance: acceptanceFile([
      ['AC-1', '甲', 'check-a2'],
      ['AC-2', '乙', 'check-b'],
    ]),
  })

  const result = state.approveCriteria({ by: 'model' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /用户/)
})

test('没有待批准的检查时，单条批准会被拒', () => {
  const { state } = scenario()

  const result = state.approveCriteria({ by: 'user' })

  assert.equal(result.ok, false)
  assert.match(result.problem, /没有待批准/)
})

test('改标准的文字仍然走整份计划重批', () => {
  const { store, state } = scenario()

  store.write('demo', {
    acceptance: acceptanceFile([['AC-1', '甲改过了', 'check-a'], ['AC-2', '乙', 'check-b']]),
  })

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /验收标准/)

  const approved = state.approveCriteria({ by: 'user' })
  assert.equal(approved.ok, false)
  assert.match(approved.problem, /验收标准/)
})
