import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOrchestrator, formatStatus } from '../lib/orchestrator.js'

/** 内存版状态存储 —— 与真实文件存储同一个接口，但不出进程。 */
function memoryStore() {
  const files = new Map()

  return {
    listProjects() {
      const slugs = new Set()
      for (const key of files.keys()) {
        const [slug, file] = key.split('/')
        if (file === 'project.md') slugs.add(slug)
      }
      return [...slugs].sort()
    },
    read(slug, file) {
      return files.get(`${slug}/${file}`) ?? null
    },
    write(slug, file, text) {
      files.set(`${slug}/${file}`, text)
    },
  }
}

function startDemo(orchestrator) {
  return orchestrator.startProject({
    name: 'demo',
    goal: '把登录流程做出来',
    acceptance: ['用户能用邮箱密码登录', '密码错误时看到明确提示'],
  })
}

test('启动项目会写出项目与验收标准两份 markdown', () => {
  const store = memoryStore()
  const orchestrator = createOrchestrator({ store })

  const result = startDemo(orchestrator)

  assert.equal(result.ok, true)
  assert.equal(result.slug, 'demo')

  const project = store.read('demo', 'project.md')
  assert.match(project, /# demo/)
  assert.match(project, /## 目标/)
  assert.match(project, /把登录流程做出来/)
  assert.match(project, /阶段：planning/)

  const acceptance = store.read('demo', 'acceptance.md')
  assert.match(acceptance, /1\. 用户能用邮箱密码登录/)
  assert.match(acceptance, /2\. 密码错误时看到明确提示/)
})

test('目标为空时拒绝启动并说明原因', () => {
  const orchestrator = createOrchestrator({ store: memoryStore() })

  const result = orchestrator.startProject({
    name: 'demo',
    goal: '   ',
    acceptance: ['随便一条'],
  })

  assert.equal(result.ok, false)
  assert.match(result.problem, /目标/)
})

test('没有验收标准时拒绝启动', () => {
  const orchestrator = createOrchestrator({ store: memoryStore() })

  const result = orchestrator.startProject({ name: 'demo', goal: '做点事', acceptance: [] })

  assert.equal(result.ok, false)
  assert.match(result.problem, /验收标准/)
})

test('项目名带路径分隔符时拒绝，不许写到 .scratch 之外', () => {
  const orchestrator = createOrchestrator({ store: memoryStore() })

  for (const name of ['../逃逸', 'a/b', 'a\\b']) {
    const result = orchestrator.startProject({ name, goal: '做点事', acceptance: ['一条'] })
    assert.equal(result.ok, false, `${name} 应被拒绝`)
  }
})

test('同名项目重复启动被拒绝，不覆盖已有状态', () => {
  const store = memoryStore()
  const orchestrator = createOrchestrator({ store })

  startDemo(orchestrator)
  const again = startDemo(orchestrator)

  assert.equal(again.ok, false)
  assert.match(again.problem, /已存在/)
  assert.match(store.read('demo', 'project.md'), /把登录流程做出来/)
})

test('status 读回目标与逐条验收标准', () => {
  const orchestrator = createOrchestrator({ store: memoryStore() })
  startDemo(orchestrator)

  const result = orchestrator.status()

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

test('换一个编排器实例仍能读回 —— 状态不活在内存里', () => {
  const store = memoryStore()
  startDemo(createOrchestrator({ store }))

  const reopened = createOrchestrator({ store }).status()

  assert.equal(reopened.ok, true)
  assert.equal(reopened.project.goal, '把登录流程做出来')
})

test('状态文件被手工改坏时返回可读的问题，而不是抛异常', () => {
  const store = memoryStore()
  store.write('demo', 'project.md', '# demo\n\n## 目标\n\n把登录流程做出来\n')
  store.write('demo', 'acceptance.md', '# 验收标准\n\n1. 一条\n')

  const result = createOrchestrator({ store }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /阶段/)
})

test('还没有项目时 status 说明这一点，而不是报错', () => {
  const result = createOrchestrator({ store: memoryStore() }).status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /还没有项目/)
})

test('多个项目并存时 status 要求指定，而不是随便挑一个', () => {
  const store = memoryStore()
  const orchestrator = createOrchestrator({ store })
  orchestrator.startProject({ name: 'a', goal: '目标一', acceptance: ['一条'] })
  orchestrator.startProject({ name: 'b', goal: '目标二', acceptance: ['一条'] })

  const result = orchestrator.status()

  assert.equal(result.ok, false)
  assert.match(result.problem, /a/)
  assert.match(result.problem, /b/)
})

test('status 文本把目标和每条验收标准都摊开给用户看', () => {
  const orchestrator = createOrchestrator({ store: memoryStore() })
  startDemo(orchestrator)
  const { project } = orchestrator.status()

  const text = formatStatus(project)

  assert.match(text, /demo/)
  assert.match(text, /规划/)
  assert.match(text, /把登录流程做出来/)
  assert.match(text, /AC-1/)
  assert.match(text, /用户能用邮箱密码登录/)
  assert.match(text, /AC-2/)
  assert.match(text, /密码错误时看到明确提示/)
})
