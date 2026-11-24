import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectDshVersion,
  detectExpectedRange,
  formatDoctorReport,
  versionInRange,
} from '../lib/doctor.js'

function fakeInstall(version) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-install-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('从安装目录读真实版本', () => {
  const { dir, cleanup } = fakeInstall('0.2.3-alpha.2')
  try {
    assert.deepEqual(detectDshVersion({ DSH_INSTALL_DIR: dir }), { version: '0.2.3-alpha.2', source: 'DSH_INSTALL_DIR' })
  } finally {
    cleanup()
  }
})

test('没设 DSH_INSTALL_DIR 或读不到时返回空串，而不是抛错', () => {
  assert.deepEqual(detectDshVersion({}, undefined, {}), { version: '', source: '' })
  assert.deepEqual(detectDshVersion({ DSH_INSTALL_DIR: 'D:\\不存在' }, undefined, {}), {
    version: '',
    source: '',
  })
})

test('能从本插件自己的 package.json 读出期望范围', () => {
  assert.match(detectExpectedRange(), /\d+\.\d+\.\d+/)
})

test('版本范围判断：下界、上界、预发布版都照顾到', () => {
  const range = '>=0.2.3-alpha.2 <0.3.0'

  assert.equal(versionInRange('0.2.3-alpha.2', range), true)
  assert.equal(versionInRange('0.2.4', range), true)
  assert.equal(versionInRange('0.2.9', range), true)
  assert.equal(versionInRange('0.3.0', range), false)
  assert.equal(versionInRange('0.1.9', range), false)
  assert.equal(versionInRange('', range), null)
})

test('报告里逐项列出能力，缺的标出来并给结论', () => {
  const text = formatDoctorReport({
    version: '0.2.3-alpha.2',
    expected: '>=0.2.3-alpha.2 <0.3.0',
    workspace: 'D:\\demo',
    projects: ['pomodoro'],
    capabilities: [
      { name: 'commands.register', ok: true },
      { name: 'subagents.startActivation', ok: false, note: '服务不在' },
    ],
    config: { snapshot: 'files', evidenceTypes: ['test', 'build'] },
    git: { ok: true, note: 'git version 2.50.0' },
    skills: { original: ['grill-with-docs'], alias: ['project-manager-grill'], shadowed: ['grill-with-docs'] },
  })

  assert.match(text, /DSH 版本：0\.2\.3-alpha\.2/)
  assert.match(text, /范围判断：在范围内/)
  assert.match(text, /已验证清单：.*当前版本在清单里/)
  assert.match(text, /在  commands\.register/)
  assert.match(text, /缺  subagents\.startActivation　—— 服务不在/)
  assert.match(text, /git：可用/)
  assert.match(text, /别名 1 个/)
  assert.match(text, /被本机同名技能盖住：grill-with-docs/)
  assert.match(text, /结论：缺子对话能力/)
  assert.match(text, /本环境跑不了项目/)
})

test('没验证过的版本如实说：按能力探测跑', () => {
  const text = formatDoctorReport({
    version: '0.3.0',
    expected: '>=0.2.3-alpha.2 <0.4.0',
    workspace: 'D:\\demo',
    projects: [],
    capabilities: [{ name: 'subagents.startActivation', ok: true }],
    config: { snapshot: 'off', evidenceTypes: ['test'] },
    git: { ok: false, note: '找不到 git' },
    skills: { original: [], alias: [], shadowed: [] },
  })

  assert.match(text, /范围判断：在范围内/)
  assert.match(text, /当前版本不在清单里：按能力探测运行/)
  assert.match(text, /结论：能力齐全/)
})

test('能力齐全时说可以正常用', () => {
  const text = formatDoctorReport({
    version: '0.2.3-alpha.2',
    expected: '>=0.2.3-alpha.2 <0.3.0',
    workspace: 'D:\\demo',
    projects: [],
    capabilities: [{ name: 'commands.register', ok: true }],
    config: { snapshot: 'off', evidenceTypes: ['test'] },
    git: { ok: false, note: '找不到 git' },
    skills: { original: [], alias: [], shadowed: [] },
  })

  assert.match(text, /结论：能力齐全/)
  assert.match(text, /快照与越界改动检查会跳过/)
})

test('版本超出范围时提示可能缺接口', () => {
  const text = formatDoctorReport({
    version: '0.4.0',
    expected: '>=0.2.3-alpha.2 <0.3.0',
    workspace: 'D:\\demo',
    projects: [],
    capabilities: [{ name: 'commands.register', ok: true }],
    config: { snapshot: 'files', evidenceTypes: ['test'] },
    git: { ok: true, note: 'ok' },
    skills: { original: [], alias: [], shadowed: [] },
  })

  assert.match(text, /不在范围内 —— 可能缺接口/)
})
