import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/**
 * 接线检查：装一次插件，确认命令与工具真的登记、卸载时真的移除。
 * 行为本身在 project-state 那一层测，这里不重复断言业务内容。
 */
function install(workspace) {
  const tools = []
  const commands = []
  const disposers = []

  const register = (list) => (definition) => {
    list.push(definition)
    return () => {
      const index = list.indexOf(definition)
      if (index >= 0) list.splice(index, 1)
    }
  }

  const ctx = {
    commands: { register: register(commands) },
    tools: { register: register(tools) },
    workingDirectory: { ensure: async () => workspace },
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
  }

  apply(ctx, {})

  return { tools, commands, disposers }
}

function emptyWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project_manager-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('装好之后注册了 /manager 命令与七个工具', () => {
  const { tools, commands } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'manager_accept',
    'manager_block',
    'manager_flow_skill',
    'manager_plan',
    'manager_run',
    'manager_start',
    'manager_verify',
  ])
})

test('/manager 在还没有项目时给出建项目的流程，而不是一句报错', async () => {
  const workspace = emptyWorkspace()
  try {
    const { commands } = install(workspace.dir)

    for (const rawInput of ['', 'status', '  status  ']) {
      const result = await commands[0].handler({ rawInput, agent: {} })
      assert.equal(result.kind, 'success', `${JSON.stringify(rawInput)} 应该走引导`)
      assert.match(result.text, /还没有项目/)
      assert.match(result.text, /grill-with-docs/)
      assert.match(result.text, /manager_plan/)
    }
  } finally {
    workspace.cleanup()
  }
})

test('/manager approve 走用户路径，批准后阶段变成执行', async () => {
  const workspace = emptyWorkspace()
  try {
    const { tools, commands } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')
    const plan = tools.find((tool) => tool.name === 'manager_plan')

    await start.execute(
      { name: 'demo', goal: '做点事', acceptance: ['一条'] },
      { agent: {} },
    )
    await plan.execute(
      { parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] },
      { agent: {} },
    )

    assert.match((await commands[0].handler({ rawInput: '', agent: {} })).text, /待批准/)

    const approved = await commands[0].handler({ rawInput: 'approve', agent: {} })
    assert.equal(approved.kind, 'success')
    assert.match((await commands[0].handler({ rawInput: '', agent: {} })).text, /执行/)
  } finally {
    workspace.cleanup()
  }
})

test('/manager reject 驳回后回到规划，并记下理由', async () => {
  const workspace = emptyWorkspace()
  try {
    const { tools, commands } = install(workspace.dir)
    await tools
      .find((tool) => tool.name === 'manager_start')
      .execute({ name: 'demo', goal: '做点事', acceptance: ['一条'] }, { agent: {} })
    await tools
      .find((tool) => tool.name === 'manager_plan')
      .execute({ parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] }, { agent: {} })

    const rejected = await commands[0].handler({
      rawInput: 'reject 第二部分太粗',
      agent: {},
    })

    assert.equal(rejected.kind, 'success')

    const status = await commands[0].handler({ rawInput: '', agent: {} })
    assert.match(status.text, /规划/)
    assert.match(status.text, /第二部分太粗/)
  } finally {
    workspace.cleanup()
  }
})

test('计划里的来源必须真的存在，写错编号会被拒', async () => {
  const workspace = emptyWorkspace()
  try {
    const { tools } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')
    const plan = tools.find((tool) => tool.name === 'manager_plan')

    await start.execute({ name: 'demo', goal: '做点事', acceptance: ['一条'] }, { agent: {} })

    mkdirSync(join(workspace.dir, '.scratch', 'demo', 'issues'), { recursive: true })
    writeFileSync(join(workspace.dir, '.scratch', 'demo', 'issues', '03-do-thing.md'), '# 03\n')

    await plan.execute(
      { parts: [{ title: '甲', origin: '03', files: ['a.js'], evidence: 'test' }] },
      { agent: {} },
    )

    await assert.rejects(
      () =>
        plan.execute(
          { parts: [{ title: '乙', origin: '99', files: ['b.js'], evidence: 'test' }] },
          { agent: {} },
        ),
      /99/,
    )
  } finally {
    workspace.cleanup()
  }
})

test('多个项目时用 @项目名 指定，驳回不会因为「有多个项目」而变成死路', async () => {
  const workspace = emptyWorkspace()
  try {
    const { tools, commands } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')
    const plan = tools.find((tool) => tool.name === 'manager_plan')

    for (const name of ['one', 'two']) {
      await start.execute({ name, goal: '做点事', acceptance: ['一条'] }, { agent: {} })
      await plan.execute(
        { project: name, parts: [{ title: '甲', files: ['a.js'], evidence: 'test' }] },
        { agent: {} },
      )
    }

    const result = await commands[0].handler({ rawInput: 'reject @two 太粗了', agent: {} })

    assert.equal(result.kind, 'success', result.text)
  } finally {
    workspace.cleanup()
  }
})

test('查询阻塞报告时「没有阻塞」是正常结果，不是错误', async () => {
  const workspace = emptyWorkspace()
  try {
    const { tools } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')
    const block = tools.find((tool) => tool.name === 'manager_block')

    await start.execute({ name: 'demo', goal: '做点事', acceptance: ['一条'] }, { agent: {} })

    const result = await block.execute({ project: 'demo' }, { agent: {} })

    assert.match(result?.content?.[0]?.text ?? JSON.stringify(result), /没有部分处于阻塞/)
  } finally {
    workspace.cleanup()
  }
})

test('技能注册抛错不会把整个插件拖下水', () => {
  const workspace = emptyWorkspace()
  try {
    const tools = []
    const commands = []
    const disposers = []
    const register = (list) => (definition) => {
      list.push(definition)
      return () => {}
    }

    const ctx = {
      commands: { register: register(commands) },
      tools: { register: register(tools) },
      workingDirectory: { ensure: async () => workspace.dir },
      get: (name) =>
        name === 'skills'
          ? {
              register() {
                throw new Error('invalid skill name')
              },
              async list() {
                return []
              },
            }
          : undefined,
      effect(callback, label) {
        const dispose = callback()
        disposers.push({ label, dispose })
        return () => {}
      },
    }

    assert.doesNotThrow(() => apply(ctx))
    assert.equal(commands.length, 1, '技能挂了，命令还得在')
    assert.equal(tools.length, 7)
  } finally {
    workspace.cleanup()
  }
})

test('插件卸载后命令与工具都不再注册', () => {
  const { tools, commands, disposers } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(tools.length, 7)
  assert.equal(disposers.length, 8)

  for (const { dispose } of disposers) dispose()

  assert.equal(commands.length, 0)
  assert.equal(tools.length, 0)
})
