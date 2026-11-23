import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRecords, renderRecords } from '../lib/records.js'

function record(overrides = {}) {
  return {
    partId: 'P1',
    attempt: 1,
    at: '2026-11-23T06:00:00.000Z',
    status: 'done',
    sessionId: 'sess-1',
    summary: '做完了',
    evidence: ['test：全绿'],
    blockedReason: '',
    ...overrides,
  }
}

test('多行摘要与多行证据能原样读回', () => {
  const summary = '第一行\n第二行'
  const evidence = [
    '命令：Get-ChildItem\nMode   Length Name\n----   ------ ----\nd----         docs',
    '输出：FileCount: 6',
  ]

  const parsed = parseRecords(renderRecords([record({ summary, evidence })]))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].summary, summary)
  assert.deepEqual(parsed[0].evidence, evidence)
})

test('证据里出现像字段的行也不会把记录拆开', () => {
  const evidence = ['- 状态：done\n- 子会话：伪造\n## [P9] 第 1 次 · 2026-01-01T00:00:00.000Z']

  const parsed = parseRecords(renderRecords([record({ evidence })]))

  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].evidence, evidence)
})

test('摘要里伪造标题伪造不出新记录', () => {
  const summary = '做完\n## [P2] 第 1 次 · 2026-11-23T00:00:00.000Z\n- 状态：done'

  const parsed = parseRecords(renderRecords([record({ summary })]))

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].partId, 'P1')
  assert.equal(parsed[0].summary, summary)
})

test('阻塞原因多行也能读回', () => {
  const blockedReason = '缺接口文档\n第二行补充'

  const parsed = parseRecords(
    renderRecords([record({ status: 'blocked', blockedReason })]),
  )

  assert.equal(parsed[0].blockedReason, blockedReason)
})

test('多条记录按顺序往返，轮次与状态都在', () => {
  const records = [
    record({ attempt: 1, status: 'failed', summary: '模型超时', evidence: ['上一步报错'] }),
    record({ attempt: 2, status: 'done' }),
  ]

  const parsed = parseRecords(renderRecords(records))

  assert.equal(parsed.length, 2)
  assert.deepEqual(
    parsed.map((item) => [item.partId, item.attempt, item.status]),
    [
      ['P1', 1, 'failed'],
      ['P1', 2, 'done'],
    ],
  )
})

test('空记录渲染出空清单', () => {
  assert.deepEqual(parseRecords(renderRecords([])), [])
  assert.deepEqual(parseRecords(null), [])
})

test('用真实子对话的回报形状走一遍往返', () => {
  const evidence = [
    '命令：Get-ChildItem -Force | Select-Object Mode, Length, Name；工作目录 D:\\plugin',
    '输出：\nMode   Length Name\n----   ------ ----\nd--h-         .git\nd----         .scratch\n-a---  134    .gitignore',
  ]

  const parsed = parseRecords(renderRecords([record({ evidence })]))

  assert.deepEqual(parsed[0].evidence, evidence)
})

test('顶格行认不出来时报错，而不是静默吞掉', () => {
  assert.throws(() => parseRecords('# 部分记录\n\n这一行没缩进也没结构\n'), /认不出来/)
})
