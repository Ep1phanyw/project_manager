/**
 * 测试用的验收标准构造器。
 *
 * 每条验收标准都必须说明怎么核对。大批测试只关心流程、不关心核对方式，
 * 所以统一给它们一个「判断型」检查 —— 那是唯一不依赖执行环境的检查。
 */
export function judged(texts) {
  return texts.map((text) => ({ text, check: { kind: 'judgement' } }))
}

export function commandCheck(text, command, extra = {}) {
  return { text, check: { kind: 'command', command, ...extra } }
}

export function artifactCheck(text, path, extra = {}) {
  return { text, check: { kind: 'artifact', path, ...extra } }
}
