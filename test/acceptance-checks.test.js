import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createProjectState } from '../lib/project-state.js'
import { memoryStore } from './memory-store.js'

const AT = '2026-11-23T06:00:00.000Z'

const REPORT = {
  ok: true,
  report: { status: 'done', summary: '做完了', evidence: ['test：node --test 全绿'] },
}

function machine(store = memoryStore()) {
  return createProjectState({ runCommand: () => ({ code: 0, output: 'ok' }),
    store,
    now: () => Date.parse(AT),
    runChild: async () => REPORT,
  })
}

const COMMAND = {
  text: '测试全绿',
  check: { kind: 'command', command: 'node --test', expectExit: 0, allowEmptyOutput: true },
}
const ARTIFACT = { text: '产物在', check: { kind: 'artifact', path: 'dist/app.js' } }
const JUDGED = { text: '界面好看', check: { kind: 'judgement' } }

function start(state, acceptance) {
  return state.startProject({ name: 'demo', goal: '把登录做出来', acceptance })
}

test('启动项目时每条标准带一个检查：命令、产物、判断型都落盘且读得回来', () => {
  const store = memoryStore()
  const state = machine(store)

  assert.equal(start(state, [COMMAND, ARTIFACT, JUDGED]).ok, true)

  const { project } = state.status('demo')
  assert.deepEqual(
    project.acceptance.map((item) => [item.id, item.text, item.check.kind]),
    [
      ['AC-1', '测试全绿', 'command'],
      ['AC-2', '产物在', 'artifact'],
      ['AC-3', '界面好看', 'judgement'],
    ],
  )
  assert.equal(project.acceptance[0].check.command, 'node --test')
  assert.equal(project.acceptance[0].check.expectExit, 0)
  assert.equal(project.acceptance[1].check.path, 'dist/app.js')
})

test('标准既没有检查、也没标判断型时，启动被拒绝并点名是哪一条', () => {
  const state = machine()

  const result = start(state, [{ text: '测试全绿' }])
  assert.equal(result.ok, false)
  assert.match(result.problem, /测试全绿/)
  assert.match(result.problem, /检查|判断型/)
})

test('检查类型不认识、命令为空时启动被拒绝', () => {
  const state = machine()

  const wrongKind = start(state, [{ text: '一条', check: { kind: '浮云' } }])
  assert.equal(wrongKind.ok, false)
  assert.match(wrongKind.problem, /检查/)

  const emptyCommand = start(state, [
    { text: '一条', check: { kind: 'command', command: '   ' } },
  ])
  assert.equal(emptyCommand.ok, false)
  assert.match(emptyCommand.problem, /命令/)
})

test('判断型标准没有可执行的命令，不会被当成命令检查', () => {
  const state = machine()
  assert.equal(start(state, [JUDGED]).ok, true)

  const { project } = state.status('demo')
  assert.equal(project.acceptance[0].check.kind, 'judgement')
  assert.equal(project.acceptance[0].check.command, undefined)
})

test('改掉某条标准的检查：这一条待批准，派分被挡，单独批准就能继续', () => {
  const store = memoryStore()
  const state = machine(store)
  start(state, [COMMAND])

  state.submitPlan({ parts: [{ title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] }] })
  state.approvePlan({ by: 'user' })

  // 只把检查命令换掉，标准的文字没动。
  store.write('demo', {
    acceptance: [
      '# 验收标准',
      '',
      '## [AC-1] 测试全绿',
      '',
      '- 检查：命令 npm run lint',
      '- 期望退出码：0',
      '- 允许空输出：是',
      '',
    ].join('\n'),
  })

  const next = state.nextPart()
  assert.equal(next.ok, false)
  assert.match(next.problem, /还没批准/)
  assert.match(next.problem, /approve-criteria/)

  // 单独批这一条，不退回待批准，也不用重批整份计划。
  const approved = state.approveCriteria({ by: 'user' })
  assert.equal(approved.ok, true)
  assert.deepEqual(approved.ids, ['AC-1'])
  assert.equal(state.nextPart().ok, true)
})

test('文件里重排标准不改变身份，也不改变指纹', () => {
  const store = memoryStore()
  const state = machine(store)
  start(state, [COMMAND, JUDGED])

  state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1', 'AC-2'] },
    ],
  })
  state.approvePlan({ by: 'user' })

  // 用户把两条标准换了个位置：编号跟着走，标准本身没变。
  store.write('demo', {
    acceptance: [
      '# 验收标准',
      '',
      '## [AC-2] 界面好看',
      '',
      '- 检查：判断型',
      '',
      '## [AC-1] 测试全绿',
      '',
      '- 检查：命令 node --test',
      '- 期望退出码：0',
'- 允许空输出：是',
      '',
    ].join('\n'),
  })

  const { project } = state.status('demo')
  assert.deepEqual(
    project.acceptance.map((item) => [item.id, item.text]),
    [
      ['AC-2', '界面好看'],
      ['AC-1', '测试全绿'],
    ],
  )
  assert.equal(project.acceptanceProblem, '')
  assert.equal(state.nextPart().ok, true)
})

test('删掉的编号不复用：重新出现的同号标准被拒绝，要用更大的号', () => {
  const store = memoryStore()
  const state = machine(store)
  start(state, [COMMAND, JUDGED])

  // 用户删掉 AC-2，重新读入。
  store.write('demo', {
    acceptance: '# 验收标准\n\n## [AC-1] 测试全绿\n\n- 检查：命令 node --test\n- 期望退出码：0\n- 允许空输出：是\n',
  })
  assert.equal(state.reopenCriteria({ by: 'user' }).ok, true)

  // 再把 AC-2 加回来 —— 那是个已经退役的编号。
  store.write('demo', {
    acceptance: [
      '# 验收标准',
      '',
      '## [AC-1] 测试全绿',
      '',
      '- 检查：命令 node --test',
      '- 期望退出码：0',
'- 允许空输出：是',
      '',
      '## [AC-2] 另一条完全不同的标准',
      '',
      '- 检查：判断型',
      '',
    ].join('\n'),
  })

  const reopened = state.reopenCriteria({ by: 'user' })
  assert.equal(reopened.ok, false)
  assert.match(reopened.problem, /AC-2/)
  assert.match(reopened.problem, /不复用|退役/)
})

test('用更大的新编号加标准是被允许的', () => {
  const store = memoryStore()
  const state = machine(store)
  start(state, [COMMAND, JUDGED])

  store.write('demo', {
    acceptance: [
      '# 验收标准',
      '',
      '## [AC-1] 测试全绿',
      '',
      '- 检查：命令 node --test',
      '- 期望退出码：0',
'- 允许空输出：是',
      '',
      '## [AC-4] 新加的一条',
      '',
      '- 检查：判断型',
      '',
    ].join('\n'),
  })

  const reopened = state.reopenCriteria({ by: 'user' })
  assert.equal(reopened.ok, true)
  assert.equal(reopened.count, 2)
})

test('期望退出码写错时被拒，而不是被悄悄当成 0', () => {
  const state = machine()

  const result = start(state, [
    { text: '测试全绿', check: { kind: 'command', command: 'node --test', expectExit: '1' } },
  ])

  assert.equal(result.ok, false)
  assert.match(result.problem, /退出码/)
})

test('批准路径同样会给删掉的编号登记退役，之后不能拿它复用', () => {
  const store = memoryStore()
  const state = machine(store)
  start(state, [COMMAND, JUDGED])

  const submitted = state.submitPlan({
    parts: [
      { title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1', 'AC-2'] },
    ],
  })
  assert.equal(submitted.ok, true)
  assert.equal(state.approvePlan({ by: 'user' }).ok, true)

  // 批准之后用户删掉 AC-2，改完计划再重新批准 —— 这条路径也要登记退役。
  store.write('demo', {
    acceptance: '# 验收标准\n\n## [AC-1] 测试全绿\n\n- 检查：命令 node --test\n- 期望退出码：0\n- 允许空输出：是\n',
  })
  state.submitPlan({ parts: [{ title: '做登录页', files: ['src/login.js'], evidence: 'test', covers: ['AC-1'] }] })
  assert.equal(state.approvePlan({ by: 'user' }).ok, true)

  // 现在把一条全新标准塞进 AC-2：它已经退役，必须被拒。
  store.write('demo', {
    acceptance: [
      '# 验收标准',
      '',
      '## [AC-1] 测试全绿',
      '',
      '- 检查：命令 node --test',
      '- 期望退出码：0',
'- 允许空输出：是',
      '',
      '## [AC-2] 全新的标准',
      '',
      '- 检查：判断型',
      '',
    ].join('\n'),
  })

  const reopened = state.reopenCriteria({ by: 'user' })
  assert.equal(reopened.ok, false)
  assert.match(reopened.problem, /AC-2/)
})
