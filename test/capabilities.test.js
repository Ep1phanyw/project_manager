import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canDispatch,
  canRunParts,
  describeCapabilities,
  detectCapabilities,
  missingConsequences,
} from '../lib/capabilities.js'

test('四项能力逐项报在不在，缺的给出后果', () => {
  const report = describeCapabilities(['commands', 'tools', 'workingDirectory'])

  assert.deepEqual(
    report.map((item) => [item.name, item.present]),
    [
      ['commands', true],
      ['tools', true],
      ['workingDirectory', true],
      ['subagents', false],
    ],
  )
  assert.equal(report.find((item) => item.name === 'subagents').hard, false)
  assert.match(report.find((item) => item.name === 'subagents').consequence, /派分跑不了/)
  assert.equal(report.find((item) => item.name === 'commands').consequence, '')
})

test('缺硬能力与缺软能力区分得开', () => {
  const report = describeCapabilities(['tools', 'workingDirectory'])

  assert.equal(report.every((item) => item.hard || item.present === false), true)
  assert.equal(canRunParts(report), false)
  assert.deepEqual(missingConsequences(report), ['没有 /manager 命令', '能规划、能看状态，但派分跑不了'])
})

test('子对话在的时候可以派分', () => {
  const report = describeCapabilities(new Set(['commands', 'tools', 'workingDirectory', 'subagents']))

  assert.equal(canRunParts(report), true)
  assert.deepEqual(missingConsequences(report), [])
})

test('从宿主上下文探测：三项硬能力齐了、没有 get 就是没有子对话', () => {
  const ctx = {
    commands: { register() {} },
    tools: { register() {} },
    workingDirectory: { ensure() {} },
  }

  assert.deepEqual([...detectCapabilities(ctx)].sort(), ['commands', 'tools', 'workingDirectory'])
  assert.equal(canDispatch(ctx), false, '没有 get 的上下文不能假装有子对话')
})

test('从宿主上下文探测：get 拿不到服务也不算', () => {
  const ctx = {
    commands: { register() {} },
    tools: { register() {} },
    workingDirectory: { ensure() {} },
    get: () => undefined,
  }

  assert.equal(canDispatch(ctx), false)
  assert.equal(detectCapabilities(ctx).has('subagents'), false)
})

test('从宿主上下文探测：子对话服务在就算', () => {
  const ctx = {
    commands: { register() {} },
    tools: { register() {} },
    workingDirectory: { ensure() {} },
    get: (name) => (name === 'subagents' ? { startActivation() {} } : undefined),
  }

  assert.equal(canDispatch(ctx), true)
  assert.equal(detectCapabilities(ctx).has('subagents'), true)
})
