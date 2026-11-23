/**
 * 给人看的渲染。状态机只管状态，怎么排版给用户看归这里。
 */

const PHASE_LABELS = {
  planning: '规划',
  'awaiting-approval': '待批准',
  executing: '执行',
}

const APPROVAL_LABELS = {
  approved: '批准',
  rejected: '驳回',
  revised: '计划更新，需重新批准',
}

const PART_LABELS = {
  done: '候选完成，待验收',
  'needs-user-verification': '待确认',
  blocked: '阻塞',
  failed: '子对话出错',
  invalid: '回报不合规',
  accepted: '验收通过',
  returned: '验收不通过',
  'unverified-acceptance': '验收记录不完整',
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
      const label = APPROVAL_LABELS[record.kind] ?? record.kind
      const note = record.note ? `：${record.note}` : ''
      lines.push(`  ${record.at}  ${label}${note}`)
    }
  }

  if (project.approvalProblem) {
    lines.push('', `审批记录读不懂：${project.approvalProblem}`)
  }

  if (project.planProblem) {
    lines.push('', `计划读不出来：${project.planProblem}`)
  }

  if (project.recordsProblem) {
    lines.push('', `部分记录读不出来：${project.recordsProblem}`)
  } else if (project.parts && project.parts.length > 0) {
    lines.push('', '部分：')
    for (const part of project.parts) {
      const dependsOn = part.dependsOn.length > 0 ? part.dependsOn.join('、') : '无'
      const status = PART_LABELS[project.partStatus?.[part.id]] ?? '未开始'
      lines.push(
        `  ${part.id}  ${part.title}　｜　证据 ${part.evidence}　｜　依赖 ${dependsOn}　｜　${status}`,
      )
    }
  }

  return lines.join('\n')
}
