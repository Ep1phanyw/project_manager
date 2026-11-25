/**
 * 测试用的验收标准构造器。
 *
 * 每条验收标准都必须说明怎么核对。大批测试只关心流程、不关心核对方式，
 * 所以统一给它们一个「判断型」检查 —— 那是唯一不依赖执行环境的检查。
 */
export function judged(texts) {
  return texts.map((text) => ({ text, check: { kind: 'judgement' } }))
}

/**
 * 大多数流程测试不关心「怎么核对」，只关心「验收能不能过」。
 * 给它们一条命令检查，配一个假的执行器，验收就是机械可过的。
 */
export function checked(texts) {
  return texts.map((text) => ({ text, check: { kind: 'command', command: 'check', expectExit: 0, allowEmptyOutput: true } }))
}

/** 假的命令执行器：默认全过；给一组命令名，它们就返回非零。 */
export function fakeCommands(failing = []) {
  const failingCommands = new Set(failing)
  return (command) => ({
    code: failingCommands.has(command) ? 1 : 0,
    output: failingCommands.has(command) ? `${command} 失败` : `${command} 通过`,
  })
}

export function commandCheck(text, command, extra = {}) {
  return { text, check: { kind: 'command', command, ...extra } }
}

export function artifactCheck(text, path, extra = {}) {
  return { text, check: { kind: 'artifact', path, ...extra } }
}
