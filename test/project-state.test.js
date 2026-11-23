import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatStatus } from '../lib/format.js'
import { createProjectState } from '../lib/project-state.js'
import { createFsStore } from '../lib/store.js'
import { memoryStore } from './memory-store.js'

function startDemo(state) {
  return state.startProject({
    name: 'demo',
    goal: '把登录流程做出来',
    acceptance: ['用户能用邮箱密码登录', '密码错误时看到明确提示'],
  })
}

test('启动项目会写出项目与验收标准两份 markdown', () => {
  const store = memoryStore()
  const state = createProjectState({ store })

  const result = startDemo(state)

  assert.equal(result.ok, true)
  assert.equal(result.slug, 'demo')

  const files = store.read('demo')
  assert.match(files.project, /# demo/)
  assert.match(files.project, /阶段：planning/)
  assert.match(files.project, /## 目标/)
  assert.match(files.project, /把登录流程做出来/)
  assert.match(files.acceptance, /- \[AC-1\] 用户能用邮箱密码登录/)
  assert.match(files.acceptance, /- \[AC-2\] 密码错误时看到明确提示/)
})

test('往返一致：多行目标与自带编号的条目都能原样读回', () => {
  const state = createProjectState({ store: memoryStore() })
  const goal = '第一行\n第二行没有井号'
  const acceptance = ['能登录', '1. 这条自己就带编号']

  state.startProject({ name: 'demo', goal, acceptance })
  const result = state.status()

  assert.equal(result.ok, true)
  assert.equal(result.project.goal, goal)
  assert.deepEqual(result.project.acceptance, acceptance)
})

test('目标里有 markdown 标题行时拒绝，而不是静默截断', () => {
  const state = createProjectState({ store: memoryStore() })

  const result = state.startProject({
    name: 'demo',
    goal: '第一步\n## 细节\n第二步',
    acceptance: ['一条'],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /标题/)
})

test('目标里有「阶段：」行时拒绝，不与状态字段混淆', () => {
  const state = createProjectState({ store: memoryStore() })

  const result = state.startProject({
    name: 'demo',
    goal: '先做登录\n阶段：planning',
    acceptance: ['一条'],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /阶段/)
})

test('验收标准带换行时拒绝 —— 否则能凭空多出一条', () => {
  const state = createProjectState({ store: memoryStore() })

  const result = state.startProject({
    name: 'demo',
    goal: '做点事',
    acceptance: ['第一行\n第二行'],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /换行/)
})

test('项目名里有换行、路径分隔符或系统保留名时拒绝', () => {
  const state = createProjectState({ store: memoryStore() })

  for (const name of ['a\nb', '../逃逸', 'a/b', 'a\\b', 'a:b', 'CON', 'nul.txt']) {
    const result = state.startProject({ name, goal: '做点事', acceptance: ['一条'] })
    assert.equal(result.ok, false, `${JSON.stringify(name)} 应被拒绝`)
  }
})

test('读取路径同样防穿越：不会读到 .scratch 之外', () => {
  const state = createProjectState({ store: memoryStore() })

  for (const requested of ['../outside', 'a/b', '..']) {
    const result = state.status(requested)
    assert.equal(result.ok, false, `${requested} 应被拒绝`)
  }
})

test('同名项目重复启动被拒绝，不覆盖已有状态', () => {
  const store = memoryStore()
  const state = createProjectState({ store })

  startDemo(state)
  const again = startDemo(state)

  assert.equal(again.ok, false)
  assert.match(again.problem, /已存在/)
  assert.match(store.read('demo').project, /把登录流程做出来/)
})

test('status 读回目标与逐条验收标准', () => {
  const state = createProjectState({ store: memoryStore() })
  startDemo(state)

  const result = state.status()

  assert.equal(result.ok, true)
  assert.equal(result.project.slug, 'demo')
  assert.equal(result.project.name, 'demo')
  assert.equal(result.project.phase, 'planning')
  assert.equal(result.project.goal, '把登录流程做出来')
  assert.deepEqual(result.project.acceptance, [
    '用户能用邮箱密码登录',
    '密码错误时看到明确提示',
  ])
})

test('真文件存储：换一个全新的状态机实例仍能读回', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'project_manager-'))
  try {
    const root = join(workspace, '.scratch')
    startDemo(createProjectState({ store: createFsStore(root) }))

    const reopened = createProjectState({ store: createFsStore(root) })
    const result = reopened.status()

    assert.equal(result.ok, true)
    assert.equal(result.project.goal, '把登录流程做出来')
    assert.equal(result.project.acceptance.length, 2)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('状态文件缺字段时返回可读问题，而不是抛异常', () => {
  const store = memoryStore()
  store.write('demo', {
    project: '# demo\n\n## 目标\n\n把登录流程做出来\n',
    acceptance: '# 验收标准\n\n- [AC-1] 一条\n',
  })

  const result = createProjectState({ store }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /阶段/)
})

test('验收标准被手改成认不出的行时报错，而不是静默丢掉', () => {
  const store = memoryStore()
  store.write('demo', {
    project: '# demo\n\n阶段：planning\n\n## 目标\n\n把登录流程做出来\n',
    acceptance: '# 验收标准\n\n- 一项没带标记的\n',
  })

  const result = createProjectState({ store }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /认不出来/)
})

test('验收标准文件整个缺失时报错', () => {
  const store = memoryStore()
  store.write('demo', {
    project: '# demo\n\n阶段：planning\n\n## 目标\n\n把登录流程做出来\n',
    acceptance: null,
  })

  const result = createProjectState({ store }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /验收标准/)
})

test('存储本身出错时不崩，而是返回可读问题', () => {
  const broken = {
    listProjects() {
      throw new Error('磁盘掉了')
    },
    read() {
      throw new Error('磁盘掉了')
    },
    write() {},
  }

  const result = createProjectState({ store: broken }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /磁盘掉了/)
})

test('还没有项目时说明这一点，而不是报错', () => {
  const result = createProjectState({ store: memoryStore() }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /还没有项目/)
})

test('多个项目并存时要求指定，而不是随便挑一个', () => {
  const state = createProjectState({ store: memoryStore() })
  state.startProject({ name: 'a', goal: '目标一', acceptance: ['一条'] })
  state.startProject({ name: 'b', goal: '目标二', acceptance: ['一条'] })

  const result = state.status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /a/)
  assert.match(result.problem, /b/)
})

test('用项目名或目录名都能查到同一个项目', () => {
  const state = createProjectState({ store: memoryStore() })
  state.startProject({ name: '我的 项目', goal: '做点事', acceptance: ['一条'] })

  for (const requested of ['我的 项目', '我的-项目']) {
    const result = state.status(requested)
    assert.equal(result.ok, true, `${requested} 应能查到`)
  }
})

test('status 文本把目标和每条验收标准都摊开给用户看', () => {
  const state = createProjectState({ store: memoryStore() })
  startDemo(state)
  const { project } = state.status()

  const text = formatStatus(project)

  assert.match(text, /demo/)
  assert.match(text, /规划/)
  assert.match(text, /把登录流程做出来/)
  assert.match(text, /AC-1/)
  assert.match(text, /用户能用邮箱密码登录/)
  assert.match(text, /AC-2/)
  assert.match(text, /密码错误时看到明确提示/)
})
