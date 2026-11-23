import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { bundledRoot, flowBrief, flowSkillRegistrations, missingSkills, readSkill } from '../lib/skills.js'

function fakeRoot(present = ['grill-with-docs', 'to-spec']) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skills-'))
  for (const name of present) {
    writeFileSync(join(root, `${name}.md`), `# ${name}\n\n正文 ${name}。\n`)
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('包里自带的三个技能都能读到正文', () => {
  for (const name of ['grill-with-docs', 'to-spec', 'to-tickets']) {
    const body = readSkill(name, bundledRoot(), null)
    assert.ok(body && body.length > 50, `${name} 应该有正文`)
  }
})

test('每个技能注册两份：原名 + 前缀别名，都可被模型调用', () => {
  const registrations = flowSkillRegistrations(bundledRoot(), null)

  assert.deepEqual(
    registrations.map((item) => item.name),
    [
      'grill-with-docs',
      'dsh-manager-grill',
      'to-spec',
      'dsh-manager-spec',
      'to-tickets',
      'dsh-manager-tickets',
    ],
  )
  for (const item of registrations) {
    assert.equal(item.invocation.modelInvocable, true)
    assert.equal(item.invocation.userInvocable, true)
    assert.equal(item.source, 'bundled', 'source 缺了会让加载时报错')
    assert.match(item.content, /第 \d 步/)
  }
})

test('frontmatter 被剥掉', () => {
  const { root, cleanup } = fakeRoot()
  try {
    writeFileSync(
      join(root, 'to-spec.md'),
      '---\nname: to-spec\ndescription: x\n---\n\n# To Spec\n\n正文。\n',
    )
    const body = readSkill('to-spec', root, null)
    assert.match(body, /# To Spec/)
    assert.doesNotMatch(body, /description: x/)
  } finally {
    cleanup()
  }
})

test('缺哪些技能能报出来', () => {
  const { root, cleanup } = fakeRoot(['grill-with-docs'])
  try {
    assert.deepEqual(missingSkills(root, null), ['to-spec', 'to-tickets'])
  } finally {
    cleanup()
  }
})

test('流程指令是短的：只点原名，不把正文塞进来', () => {
  const { root, cleanup } = fakeRoot(['grill-with-docs', 'to-spec', 'to-tickets'])
  try {
    const brief = flowBrief(root, null)

    assert.match(brief, /grill-with-docs/)
    assert.match(brief, /to-spec/)
    assert.match(brief, /to-tickets/)
    assert.match(brief, /manager_plan/)
    assert.match(brief, /来源：/)
    assert.match(brief, /dsh-manager-grill/)
    assert.match(brief, /原名 grill-with-docs/)
    assert.ok(brief.split('\n').length < 20, '指令应该短')
    assert.doesNotMatch(brief, /正文 grill-with-docs/)
  } finally {
    cleanup()
  }
})

test('缺技能时指令里如实点名', () => {
  const { root, cleanup } = fakeRoot([])
  try {
    const brief = flowBrief(root, null)

    assert.match(brief, /缺少 grill-with-docs、to-spec、to-tickets/)
    assert.match(brief, /manager_start/)
  } finally {
    cleanup()
  }
})

test('本地有就用本地的，本地没有就用包里的', () => {
  const bundled = mkdtempSync(join(tmpdir(), 'dsh-bundled-'))
  const local = mkdtempSync(join(tmpdir(), 'dsh-local-'))
  try {
    writeFileSync(join(bundled, 'to-spec.md'), '# 包内\n\n包里的正文。\n')

    // 本地没有 → 用包里的
    assert.match(readSkill('to-spec', bundled, local), /包里的正文/)

    // 本地有了 → 用本地的
    writeFileSync(join(local, 'to-spec.md'), '# 本地\n\n本地的正文。\n')
    assert.match(readSkill('to-spec', bundled, local), /本地的正文/)
  } finally {
    rmSync(bundled, { recursive: true, force: true })
    rmSync(local, { recursive: true, force: true })
  }
})
