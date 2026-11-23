import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('装好之后注册了 /manager 命令与 manager_start 工具', () => {
  const { tools, commands } = install('D:\\plugin')

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'manager_start')
})

test('/manager status 与裸 /manager 走同一条路径', async () => {
  const workspace = emptyWorkspace()
  try {
    const { commands } = install(workspace.dir)

    for (const rawInput of ['', 'status', '  status  ']) {
      const result = await commands[0].handler({ rawInput, agent: {} })
      assert.equal(result.kind, 'error', `${JSON.stringify(rawInput)} 不该被当成项目名`)
      assert.match(result.text, /还没有项目/)
    }
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
