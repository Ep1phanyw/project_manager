import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aliasRegistrations, flowBrief, missingSkills, readSkill } from '../lib/skills.js'

function fakeRoot(present = ['grill-with-docs', 'to-spec']) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  for (const name of present) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: x\n---\n\n# ${name}\n\n正文 ${name}。\n`,
    )
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('读技能正文时去掉 frontmatter', () => {
  const { root, cleanup } = fakeRoot()
  try {
    const body = readSkill('grill-with-docs', root)
    assert.match(body, /正文 grill-with-docs/)
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

test('只给机器上真有的技能注册别名，且别名可被模型调用', () => {
  const { root, cleanup } = fakeRoot()
  try {
    const aliases = aliasRegistrations(root)

    assert.deepEqual(
      aliases.map((alias) => alias.name),
      ['dsh-manager-grill', 'dsh-manager-spec'],
    )
    for (const alias of aliases) {
      assert.equal(alias.invocation.modelInvocable, true)
      assert.equal(alias.invocation.userInvocable, false)
      assert.match(alias.content, /第 \d 步/)
    }
  } finally {
    cleanup()
  }
})

test('缺哪些源技能能报出来', () => {
  const { root, cleanup } = fakeRoot(['grill-with-docs'])
  try {
    assert.deepEqual(missingSkills(root), ['to-spec', 'to-tickets'])
  } finally {
    cleanup()
  }
})

test('流程指令是短的：只点别名，不把正文塞进来', () => {
  const { root, cleanup } = fakeRoot(['grill-with-docs', 'to-spec', 'to-tickets'])
  try {
    const brief = flowBrief(root)

    assert.match(brief, /dsh-manager-grill/)
    assert.match(brief, /dsh-manager-spec/)
    assert.match(brief, /dsh-manager-tickets/)
    assert.match(brief, /manager_plan/)
    assert.match(brief, /票：/)
    assert.ok(brief.split('\n').length < 15, '指令应该短')
    assert.doesNotMatch(brief, /正文 grill-with-docs/, '正文不该出现在指令里')
  } finally {
    cleanup()
  }
})

test('缺技能时指令里如实点名，并给出退路', () => {
  const { root, cleanup } = fakeRoot([])
  try {
    const brief = flowBrief(root)

    assert.match(brief, /缺少 grill-with-docs、to-spec、to-tickets/)
    assert.match(brief, /manager_start/)
    assert.match(brief, /~\/.agents\/skills/)
  } finally {
    cleanup()
  }
})
