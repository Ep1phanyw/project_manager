import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_EVIDENCE_TYPES,
  DEFAULT_SNAPSHOT_MODE,
  readEvidenceTypes,
  readSnapshotMode,
} from '../lib/config.js'

test('默认快照只提交这个部分声明的文件', () => {
  assert.equal(DEFAULT_SNAPSHOT_MODE, 'files')
  assert.equal(readSnapshotMode(undefined, {}), 'files')
})

test('配置能关掉快照，也能放宽成整个工作区', () => {
  assert.equal(readSnapshotMode({ snapshot: 'off' }, {}), 'off')
  assert.equal(readSnapshotMode({ snapshot: 'ALL' }, {}), 'all')
  assert.equal(readSnapshotMode({ snapshot: 'files' }, {}), 'files')
})

test('配置写错时退回默认值，不让插件起不来', () => {
  assert.equal(readSnapshotMode({ snapshot: '??? ' }, {}), 'files')
  assert.equal(readSnapshotMode({ snapshot: 42 }, {}), 'files')
})

test('环境变量能兜底，配置优先', () => {
  assert.equal(readSnapshotMode(undefined, { DSH_MANAGER_SNAPSHOT: 'off' }), 'off')
  assert.equal(readSnapshotMode({ snapshot: 'all' }, { DSH_MANAGER_SNAPSHOT: 'off' }), 'all')
})

test('证据类型默认四种，配置里的会加上去', () => {
  assert.deepEqual(readEvidenceTypes(undefined), DEFAULT_EVIDENCE_TYPES)
  assert.deepEqual(readEvidenceTypes({ evidenceTypes: ['review'] }), [
    ...DEFAULT_EVIDENCE_TYPES,
    'review',
  ])
})

test('证据类型去重，并丢掉不合理的名字', () => {
  assert.deepEqual(readEvidenceTypes({ evidenceTypes: ['test', 'review', 'review'] }), [
    ...DEFAULT_EVIDENCE_TYPES,
    'review',
  ])
  assert.deepEqual(readEvidenceTypes({ evidenceTypes: ['', '  ', '带空格 的', 42] }), [
    ...DEFAULT_EVIDENCE_TYPES,
  ])
})
