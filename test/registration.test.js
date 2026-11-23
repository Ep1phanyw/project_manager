import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/**
 * 装一次插件。命令与工具真的会被登记、卸载时真的会被移除，
 * 工作区用注入的假件指定，所以这一层不依赖任何会话。
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

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-manager-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('装好之后注册了 /manager 命令与 manager_start 工具', () => {
  const { tools, commands } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'manager_start')
})

test('启动项目后 /manager 能把目标与验收标准读回来，且状态真的落盘', async () => {
  const workspace = tempWorkspace()
  try {
    const { tools, commands } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')

    await start.execute(
      { name: 'demo', goal: '把登录流程做出来', acceptance: ['能登录', '错误密码有提示'] },
      { agent: {} },
    )

    const result = await commands[0].handler({ rawInput: '', agent: {} })

    assert.equal(result.kind, 'success')
    assert.match(result.text, /把登录流程做出来/)
    assert.match(result.text, /AC-1/)
    assert.match(result.text, /能登录/)

    const onDisk = readFileSync(join(workspace.dir, '.scratch', 'demo', 'project.md'), 'utf8')
    assert.match(onDisk, /把登录流程做出来/)
  } finally {
    workspace.cleanup()
  }
})

test('还没有项目时 /manager 给出可读提示，而不是报错崩溃', async () => {
  const workspace = tempWorkspace()
  try {
    const { commands } = install(workspace.dir)

    const result = await commands[0].handler({ rawInput: '', agent: {} })

    assert.equal(result.kind, 'error')
    assert.match(result.text, /还没有项目/)
  } finally {
    workspace.cleanup()
  }
})

test('启动失败时工具真的报错，模型收不到「成功」', async () => {
  const workspace = tempWorkspace()
  try {
    const { tools } = install(workspace.dir)
    const start = tools.find((tool) => tool.name === 'manager_start')

    await assert.rejects(
      () => start.execute({ name: 'demo', goal: '有目标', acceptance: [] }, { agent: {} }),
      /验收标准/,
    )
  } finally {
    workspace.cleanup()
  }
})

test('插件卸载后命令与工具都不再注册', () => {
  const { tools, commands, disposers } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(tools.length, 1)
  assert.equal(disposers.length, 2)

  for (const { dispose } of disposers) dispose()

  assert.equal(commands.length, 0)
  assert.equal(tools.length, 0)
})
