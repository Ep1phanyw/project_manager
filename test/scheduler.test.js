import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createScheduler } from '../lib/scheduler.js'

const part = (id, { files = [`${id}.js`], dependsOn = [] } = {}) => ({
  id,
  title: id,
  files,
  dependsOn,
  evidence: 'test',
  covers: [],
})

test('上限：默认 3，配置与平台名额取小，硬顶 8', () => {
  assert.equal(createScheduler().limit(), 3)
  assert.equal(createScheduler({ maxParallel: 1 }).limit(), 1)
  assert.equal(createScheduler({ maxParallel: 99 }).limit(), 8, '硬顶 8')
  assert.equal(
    createScheduler({ maxParallel: 8, capacity: () => ({ running: 2, limit: 3 }) }).limit(),
    1,
    '平台只剩一个名额',
  )
  assert.equal(
    createScheduler({ maxParallel: 3, capacity: () => ({ running: 3, limit: 3 }) }).limit(),
    0,
  )
  assert.equal(
    createScheduler({ capacity: () => { throw new Error('炸了') } }).limit(),
    3,
    '探测炸了就按配置来',
  )
})

test('可派：依赖都过了、状态不是完成/阻塞/等确认/在飞/中断', () => {
  const scheduler = createScheduler({ maxParallel: 8 })
  const parts = [part('P1'), part('P2', { dependsOn: ['P1'] }), part('P3')]
  const verified = new Set()

  const first = scheduler.ready(parts, { verified, partStatus: {}, size: 8 })
  assert.deepEqual(first.map((item) => item.id), ['P1', 'P3'], 'P2 依赖 P1，先不派')

  const skipped = scheduler.ready(
    [part('P1'), part('P2'), part('P3'), part('P4'), part('P5')],
    {
      verified: new Set(),
      partStatus: {
        P1: 'done',
        P2: 'blocked',
        P3: 'needs-user-verification',
        P4: 'running',
        P5: 'interrupted',
      },
      size: 8,
    },
  )
  assert.deepEqual(skipped, [], '五种状态一个都不该被选')
})

test('文件集相交的不一起选，重叠函数由调用方给', () => {
  const scheduler = createScheduler({ maxParallel: 8 })
  const parts = [part('P1', { files: ['src/a.js'] }), part('P2', { files: ['src/a.js'] })]
  const overlaps = (left, right) => left === right

  const selected = scheduler.ready(parts, { verified: new Set(), partStatus: {}, overlaps, size: 8 })

  assert.deepEqual(selected.map((item) => item.id), ['P1'])
})

test('选到的数量不超过上限', () => {
  const scheduler = createScheduler({ maxParallel: 2 })
  const parts = [part('P1'), part('P2'), part('P3'), part('P4')]

  const selected = scheduler.ready(parts, { verified: new Set(), partStatus: {}, size: 2 })

  assert.deepEqual(selected.map((item) => item.id), ['P1', 'P2'])
})

test('同一个部分不能被 begin 两次', () => {
  const scheduler = createScheduler()

  assert.equal(scheduler.begin('P1'), true)
  assert.equal(scheduler.begin('P1'), false, '第二次占位必须失败')
  assert.equal(scheduler.has('P1'), true)

  scheduler.end('P1')
  assert.equal(scheduler.has('P1'), false)
  assert.equal(scheduler.begin('P1'), true, '放开之后可以再占')
})
