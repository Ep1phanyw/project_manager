/**
 * 给人看的渲染。状态机只管状态，怎么排版给用户看归这里。
 */

const PHASE_LABELS = {
  planning: '规划',
  'awaiting-approval': '待批准',
  executing: '执行',
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

  const lines = [
    `项目：${project.name}`,
    `阶段：${phase}`,
    '',
    '目标：',
    goal,
    '',
    '验收标准：',
    acceptance,
  ]

  if (project.approvals && project.approvals.length > 0) {
    lines.push('', '审批：')
    for (const record of project.approvals) {
      const label = record.kind === 'approved' ? '批准' : '驳回'
      const note = record.note ? `：${record.note}` : ''
      lines.push(`  ${record.at}  ${label}${note}`)
    }
  }

  if (project.planProblem) {
    lines.push('', `计划读不出来：${project.planProblem}`)
  } else if (project.parts && project.parts.length > 0) {
    lines.push('', '部分：')
    for (const part of project.parts) {
      const dependsOn = part.dependsOn.length > 0 ? part.dependsOn.join('、') : '无'
      lines.push(`  ${part.id}  ${part.title}　｜　证据 ${part.evidence}　｜　依赖 ${dependsOn}`)
    }
  }

  return lines.join('\n')
}
