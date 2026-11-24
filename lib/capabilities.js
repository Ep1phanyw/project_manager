/**
 * 平台能力清单与探测。
 *
 * 探测是一个纯函数：给一组「当前可用的能力名」，输出每项在不在、缺了会怎样。
 * 这样「缺什么」可以单独测，不必把 Cordis 装起来。
 */

export const CAPABILITIES = [
  { name: 'commands', hard: true, consequence: '没有 /manager 命令' },
  { name: 'tools', hard: true, consequence: '模型没有可调用的工具' },
  { name: 'workingDirectory', hard: true, consequence: '读不到会话工作区' },
  { name: 'subagents', hard: false, consequence: '能规划、能看状态，但派分跑不了' },
]

export function describeCapabilities(available) {
  const present = available instanceof Set ? available : new Set(available ?? [])

  return CAPABILITIES.map((item) => ({
    name: item.name,
    hard: item.hard,
    present: present.has(item.name),
    consequence: present.has(item.name) ? '' : item.consequence,
  }))
}

/** 能派分吗？只有子对话能力是它的前提。 */
export function canRunParts(report) {
  return report.some((item) => item.name === 'subagents' && item.present)
}

/** 缺了会怎样：空数组表示什么都不缺。 */
export function missingConsequences(report) {
  return report.filter((item) => !item.present).map((item) => item.consequence)
}

/** 子对话服务：没有 get 的宿主上下文（测试里常见）就当作没有。 */
export function subagentsOf(ctxRef) {
  return ctxRef?.get?.('subagents') ?? null
}

/** 能派分吗：只看子对话服务在不在，别处不要自己再写 typeof。 */
export function canDispatch(ctxRef) {
  return typeof subagentsOf(ctxRef)?.startActivation === 'function'
}

/** 从宿主上下文探出可用能力名集合 —— 探测只有这一处。 */
export function detectCapabilities(ctxRef) {
  const available = new Set()

  if (typeof ctxRef?.commands?.register === 'function') available.add('commands')
  if (typeof ctxRef?.tools?.register === 'function') available.add('tools')
  if (typeof ctxRef?.workingDirectory?.ensure === 'function') available.add('workingDirectory')
  if (canDispatch(ctxRef)) available.add('subagents')

  return available
}
