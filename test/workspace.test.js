import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { surveyWorkspace, workspaceContext } from '../lib/workspace.js'

function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('空目录不算有活', () => {
  const { dir, cleanup } = temp()
  try {
    const survey = surveyWorkspace(dir)
    assert.equal(survey.hasWork, false)
  } finally {
    cleanup()
  }
})

test('只有 .git 与 .scratch 时不算有活', () => {
  const { dir, cleanup } = temp()
  try {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, '.scratch'))
    assert.equal(surveyWorkspace(dir).hasWork, false)
  } finally {
    cleanup()
  }
})

test('有源码或配置文件就算有活，并报出顶层条目', () => {
  const { dir, cleanup } = temp()
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    mkdirSync(join(dir, 'src'))

    const survey = surveyWorkspace(dir)
    assert.equal(survey.hasWork, true)
    assert.deepEqual(survey.top.sort(), ['package.json', 'src'])
  } finally {
    cleanup()
  }
})

test('上下文文件只报真实存在的那些', () => {
  const { dir, cleanup } = temp()
  try {
    writeFileSync(join(dir, 'README.md'), '# x')
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'adr', '0001-x.md'), '# adr')

    assert.deepEqual(workspaceContext(dir), ['README.md', 'docs/adr'])
  } finally {
    cleanup()
  }
})

test('空目录没有上下文文件', () => {
  const { dir, cleanup } = temp()
  try {
    assert.deepEqual(workspaceContext(dir), [])
  } finally {
    cleanup()
  }
})
