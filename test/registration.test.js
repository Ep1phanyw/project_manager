import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/**
 * 装一次插件，只返回它注册出来的东西。
 * 假的 register 会真的把命令记进列表、并在注销时移出去，
 * 这样「卸载后命令消失」才是被验证过的，而不是只断言拿到个函数。
 */
function install() {
  const commands = []
  const disposers = []
  const ctx = {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    },
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
  }

  // 第二个参数对着 Cordis 的 apply(ctx, config) 契约，本票还不用它。
  apply(ctx, {})

  return { commands, disposers }
}

test('装好之后注册了一条名为 manager 的命令', () => {
  const { commands } = install()

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
})

test('敲 /manager 会拿到一条非空的成功回应', () => {
  const { commands } = install()

  const result = commands[0].handler({ rawInput: '' })

  assert.equal(result.kind, 'success')
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.trim().length > 0)
})

test('插件卸载后 /manager 不再注册', () => {
  const { commands, disposers } = install()

  assert.equal(commands.length, 1)
  assert.equal(disposers.length, 1)

  disposers[0].dispose()

  assert.equal(commands.length, 0)
})
