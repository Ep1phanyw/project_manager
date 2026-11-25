import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createChecks } from '../lib/checks.js'

const command = (id, extra = {}) => ({
  id,
  text: id,
  check: { kind: 'command', command: 'node --test', expectExit: 0, allowEmptyOutput: true, output: '', ...extra },
})

const artifact = (id, extra = {}) => ({
  id,
  text: id,
  check: { kind: 'artifact', path: 'dist/app.js', match: '', ...extra },
})

const judged = (id) => ({ id, text: id, check: { kind: 'judgement' } })

test('命令检查：退出码对上就算过，明细里带命令与退出码', () => {
  const checks = createChecks({ runCommand: () => ({ code: 0, output: 'ok' }) })

  const result = checks.run([command('AC-1')], '部分 P1')

  assert.deepEqual(result.failures, [])
  assert.equal(result.checks[0].ok, true)
  assert.match(result.checks[0].detail, /命令 node --test → 退出码 0（期望 0）/)
})

test('命令检查：退出码不对、或输出没匹配，都算不过', () => {
  const wrongCode = createChecks({ runCommand: () => ({ code: 1, output: 'boom' }) })
  const failed = wrongCode.run([command('AC-1')], '部分 P1')
  assert.equal(failed.checks[0].ok, false)
  assert.match(failed.checks[0].detail, /退出码 1（期望 0）/)
  assert.match(failed.checks[0].detail, /输出：boom/)

  const wrongOutput = createChecks({ runCommand: () => ({ code: 0, output: '全绿' }) })
  const missed = wrongOutput.run([command('AC-1', { output: '12 passed' })], '部分 P1')
  assert.equal(missed.checks[0].ok, false)
  assert.match(missed.checks[0].detail, /输出没匹配/)
})

test('产物检查：在不在、内容匹配不匹配', () => {
  const present = createChecks({ readFile: () => 'hello login' })
  assert.equal(present.run([artifact('AC-1')], '收尾验收').checks[0].ok, true)

  const missing = createChecks({ readFile: () => null })
  const gone = missing.run([artifact('AC-1')], '收尾验收')
  assert.equal(gone.checks[0].ok, false)
  assert.match(gone.checks[0].detail, /不在/)

  const mismatched = createChecks({ readFile: () => '别的内容' })
  const wrong = mismatched.run([artifact('AC-1', { match: 'login' })], '收尾验收')
  assert.equal(wrong.checks[0].ok, false)
  assert.match(wrong.checks[0].detail, /内容匹配没通过/)
})

test('判断型不执行，单独标出来', () => {
  let called = 0
  const checks = createChecks({
    runCommand: () => {
      called += 1
      return { code: 0, output: '' }
    },
    readFile: () => {
      called += 1
      return ''
    },
  })

  const result = checks.run([judged('AC-1')], '部分 P1')

  assert.equal(called, 0, '判断型不该碰执行器')
  assert.deepEqual(result.judgements.map((item) => item.id), ['AC-1'])
  assert.deepEqual(result.failures, [])
})

test('缺执行器时明说，而不是判过或判不过', () => {
  const noRunner = createChecks()
  assert.match(noRunner.run([command('AC-1')], '部分 P1').problem, /命令执行器/)

  const noReader = createChecks()
  assert.match(noReader.run([artifact('AC-1')], '收尾验收').problem, /读文件的通道/)
})

test('没有任何标准可跑时说清楚是哪一层', () => {
  const checks = createChecks({ runCommand: () => ({ code: 0, output: '' }) })

  assert.match(checks.run([], '部分 P1').problem, /部分 P1/)
  assert.match(checks.run([], '收尾验收').problem, /收尾验收/)
})

test('空输出且没声明允许 → 判不过，理由说清楚', () => {
  const checks = createChecks({ runCommand: () => ({ code: 0, output: '   ' }) })
  const bare = { id: 'AC-1', text: 'AC-1', check: { kind: 'command', command: 'true', expectExit: 0 } }

  const result = checks.run([bare], '部分 P1')

  assert.equal(result.checks[0].ok, false)
  assert.match(result.checks[0].detail, /输出为空/)
})

test('输出说零个用例通过 → 退出码再漂亮也不算过', () => {
  for (const output of ['# pass 0\n# fail 0', 'Tests: 0 passing', '0 passed in 0.1s', 'no tests to run']) {
    const checks = createChecks({ runCommand: () => ({ code: 0, output }) })
    const result = checks.run([command('AC-1')], '部分 P1')
    assert.equal(result.checks[0].ok, false, `应判不过：${output}`)
  }
})

test('正常的通过输出不会被零用例规则误伤', () => {
  const checks = createChecks({ runCommand: () => ({ code: 0, output: '# pass 12\n# fail 0' }) })
  const result = checks.run([command('AC-1')], '部分 P1')

  assert.equal(result.checks[0].ok, true)
})

test('命令输出只留尾巴，不把几千行塞进记录', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行`)
  const checks = createChecks({ runCommand: () => ({ code: 0, output: lines.join('\n') }) })

  const detail = checks.run([command('AC-1')], '部分 P1').checks[0].detail

  assert.doesNotMatch(detail, /第 1 行/, '前 28 行不该出现')
  assert.match(detail, /第 40 行/)
})
