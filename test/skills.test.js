import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { flowBrief, readSkill } from '../lib/skills.js'

function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  for (const [name, body] of [
    ['grill-with-docs', '# Grill\n\n问问题，一轮一轮。'],
    ['to-spec', '# To Spec\n\n收敛成 spec。'],
  ]) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n\n${body}\n`)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('读技能正文时去掉 frontmatter', () => {
  const { root, cleanup } = fakeRoot()
  try {
    const body = readSkill('grill-with-docs', root)
    assert.match(body, /问问题/)
    assert.doesNotMatch(body, /description: x/)
  } finally {
    cleanup()
  }
})

test('技能不存在时返回 null', () => {
  const { root, cleanup } = fakeRoot()
  try {
    assert.equal(readSkill('to-tickets', root), null)
  } finally {
    cleanup()
  }
})

test('流程说明把已有的技能正文带上，缺的如实说缺', () => {
  const { root, cleanup } = fakeRoot()
  try {
    const brief = flowBrief(root)

    assert.match(brief, /grill-with-docs/)
    assert.match(brief, /问问题/)
    assert.match(brief, /to-spec/)
    assert.match(brief, /to-tickets（没找到）/)
    assert.match(brief, /manager_plan/)
    assert.match(brief, /票：/)
  } finally {
    cleanup()
  }
})
