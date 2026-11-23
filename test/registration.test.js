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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manager-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('装好之后注册了 /manager 命令与五个工具', () => {
  const { tools, commands } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'manager_block',
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
      assert.match(result.text, /dsh-manager-grill/)
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

test('插件卸载后命令与工具都不再注册', () => {
  const { tools, commands, disposers } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(tools.length, 5)
  assert.equal(disposers.length, 6)

  for (const { dispose } of disposers) dispose()

  assert.equal(commands.length, 0)
  assert.equal(tools.length, 0)
})
