/**
 * 给人看的渲染。状态机只管状态，怎么排版给用户看归这里。
 */

const PHASE_LABELS = {
  planning: '规划',
}

export function formatStatus(project) {
  const phase = PHASE_LABELS[project.phase] ?? project.phase
  const goal = project.goal
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n')
  const acceptance = project.acceptance
    .map((item, index) => `  AC-${index + 1}  ${item}`)
    .join('\n')

  return [
    `项目：${project.name}`,
    `阶段：${phase}`,
    '',
    '目标：',
    goal,
    '',
    '验收标准：',
    acceptance,
  ].join('\n')
}
