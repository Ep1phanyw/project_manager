import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRecordWriter } from '../lib/record-writer.js'
import { memoryStore } from './memory-store.js'

const reasonOf = (error) => (error instanceof Error ? error.message : String(error))

function record(partId, attempt, status) {
  return {
    partId,
    attempt,
    at: '2026-11-23T06:00:00.000Z',
    status,
    summary: '',
    evidence: [],
    checks: [],
    sessionId: '',
    blockedReason: '',
  }
}

test('并发的两条追加都落盘 —— 写前会重读，不互相覆盖', async () => {
  const store = memoryStore()
  const writer = createRecordWriter({ store, reasonOf })

  await Promise.all([
    writer.append('demo', record('P1', 1, 'done')),
    writer.append('demo', record('P2', 1, 'done')),
  ])

  const text = store.read('demo').parts
  assert.match(text, /## \[P1\] 第 1 次/)
  assert.match(text, /## \[P2\] 第 1 次/)
})

test('replaceInFlight 把那一轮的在飞记录换成结果', async () => {
  const store = memoryStore()
  const writer = createRecordWriter({ store, reasonOf })

  await writer.append('demo', record('P1', 1, 'running'))
  await writer.replaceInFlight('demo', 'P1', 1, record('P1', 1, 'done'))

  const text = store.read('demo').parts
  assert.doesNotMatch(text, /- 状态：running/)
  assert.match(text, /- 状态：done/)
  assert.equal((text.match(/## \[P1\]/g) ?? []).length, 1, '同一条记录不该留两份')
})

test('replaceInFlight 只换匹配的那一轮，别的在飞不动', async () => {
  const store = memoryStore()
  const writer = createRecordWriter({ store, reasonOf })

  await writer.append('demo', record('P1', 1, 'running'))
  await writer.append('demo', record('P2', 1, 'running'))
  await writer.replaceInFlight('demo', 'P1', 1, record('P1', 1, 'done'))

  const text = store.read('demo').parts
  assert.equal((text.match(/- 状态：running/g) ?? []).length, 1, 'P2 还在飞')
  assert.match(text, /## \[P2\] 第 1 次/)
})

test('记录读不懂时返回可读问题，不抛异常', async () => {
  const store = memoryStore()
  store.write('demo', { parts: '# 部分记录\n\n这行认不出来\n' })
  const writer = createRecordWriter({ store, reasonOf })

  const result = await writer.append('demo', record('P1', 1, 'done'))

  assert.match(result.problem, /部分记录读不懂/)
})

test('写不进文件时返回可读问题，不抛异常', async () => {
  const store = {
    read: () => ({ parts: '# 部分记录\n' }),
    write: () => {
      throw new Error('磁盘满了')
    },
  }
  const writer = createRecordWriter({ store, reasonOf })

  const result = await writer.append('demo', record('P1', 1, 'done'))

  assert.match(result.problem, /写不了部分记录/)
  assert.match(result.problem, /磁盘满了/)
})

test('一次写入失败不会把后面的写入卡死', async () => {
  let calls = 0
  const store = {
    read: () => ({ parts: '# 部分记录\n' }),
    write: () => {
      calls += 1
      if (calls === 1) throw new Error('第一次失败')
    },
  }
  const writer = createRecordWriter({ store, reasonOf })

  const first = await writer.append('demo', record('P1', 1, 'done'))
  const second = await writer.append('demo', record('P2', 1, 'done'))

  assert.match(first.problem, /写不了部分记录/)
  assert.deepEqual(second, {}, '队列要恢复，后面照常写')
})
