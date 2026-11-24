import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canRunParts, describeCapabilities, missingConsequences } from '../lib/capabilities.js'

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
