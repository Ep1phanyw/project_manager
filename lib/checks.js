/**
 * 执行检查并给判定。
 *
 * 这里只认「检查定义 + 执行结果」：命令检查比退出码与输出正则，产物检查比
 * 文件与内容正则，判断型不执行、留给用户。它不知道项目、不知道 store，
 * 执行器与读文件都由创建时注入，所以判定规则可以直接喂数据测。
 */

import { tail } from './exec.js'

export function createChecks({ runCommand = null, readFile = null } = {}) {
  /**
   * 把一组标准上的检查跑一遍。跑不了（缺执行器）要说清楚，
   * 不能悄悄变成「通过」或「不通过」。
   */
  function run(covered, label) {
    if (covered.length === 0) {
      return { problem: `${label} 没有覆盖任何验收标准，没有什么可验收的` }
    }

    const needsCommand = covered.some((item) => item.check.kind === 'command')
    if (needsCommand && typeof runCommand !== 'function') {
      return { problem: '验收要执行命令检查，但插件没有拿到命令执行器' }
    }

    const needsFile = covered.some((item) => item.check.kind === 'artifact')
    if (needsFile && typeof readFile !== 'function') {
      return { problem: '验收要检查产物，但插件没有拿到读文件的通道' }
    }

    const results = covered.map((criterion) => one(criterion))

    return {
      checks: results,
      failures: results.filter((item) => !item.ok),
      judgements: results.filter((item) => item.judged === true),
    }
  }

  function one(criterion) {
    const { check } = criterion

    if (check.kind === 'judgement') {
      return { id: criterion.id, ok: true, judged: true, detail: '判断型：留给你亲眼判断' }
    }

    if (check.kind === 'command') return judgeCommand(criterion)

    return judgeArtifact(criterion)
  }

  function judgeCommand(criterion) {
    const { check } = criterion
    const result = runCommand(check.command)
    const code = Number(result?.code ?? 1)
    const output = String(result?.output ?? '')
    const codeOk = code === check.expectExit
    const patternOk = !check.output || new RegExp(check.output).test(output)
    const ok = codeOk && patternOk

    const detail = [
      `命令 ${check.command} → 退出码 ${code}（期望 ${check.expectExit}）${patternOk ? '' : '，输出没匹配'}`,
      output.trim() ? `输出：${tail(output, 12).join('\n')}` : '输出：（空）',
    ].join('\n')

    return { id: criterion.id, ok, detail }
  }

  function judgeArtifact(criterion) {
    const { check } = criterion
    const content = readFile(check.path)
    const exists = content !== null && content !== undefined
    const patternOk = !check.match || new RegExp(check.match).test(String(content ?? ''))
    const ok = exists && patternOk

    const detail = `产物 ${check.path} → ${exists ? '在' : '不在'}${
      check.match ? `，内容匹配${patternOk ? '通过' : '没通过'}` : ''
    }`

    return { id: criterion.id, ok, detail }
  }

  return { run }
}
