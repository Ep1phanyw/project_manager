import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject } from '../index.js'

/** 记录注册动作的最小假 ctx —— 只覆盖本票用到的两个能力。 */
function fakeCtx() {
  const commands = []
  const disposers = []
  const ctx = {
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
  }
  return { ctx, commands, disposers }
}

test('插件声明依赖 commands 服务', () => {
  assert.deepEqual(inject, ['commands'])
})

test('装好之后注册了一条名为 manager 的命令', () => {
  const { ctx, commands } = fakeCtx()

  apply(ctx, {})

  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'manager')
})

test('敲 /manager 会拿到一条非空的成功回应', () => {
  const { ctx, commands } = fakeCtx()

  apply(ctx, {})

  const result = commands[0].handler({ rawInput: '' })

  assert.equal(result.kind, 'success')
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.trim().length > 0)
})

test('注册句柄被 ctx.effect 收集，插件卸载时能回收', () => {
  const { ctx, disposers } = fakeCtx()

  apply(ctx, {})

  assert.equal(disposers.length, 1)
  assert.equal(typeof disposers[0].dispose, 'function')
  assert.match(disposers[0].label, /manager/)
})
