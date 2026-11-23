/**
 * 给人看的渲染。状态机只管状态，怎么排版给用户看归这里。
 */

import { STATUS_LABELS } from './records.js'

/** 把阻塞报告排版给用户看：卡在哪、试过什么、需要你给什么。 */
export function formatBlockReport(blocked) {
  const lines = []

  for (const item of blocked) {
    lines.push(`卡在：部分 ${item.id}「${item.title}」`)
    lines.push(`情形：${item.condition}`)
    lines.push('试过：')
    for (const record of item.history) {
      const label = STATUS_LABELS[record.status] ?? record.status
      lines.push(`  - 第 ${record.attempt} 次 · ${label}：${record.summary || '（无说明）'}`)
    }
    if (item.need) lines.push(`需要你：${item.need}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

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
  ...STATUS_LABELS,
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

  const pending = []
  for (const part of project.parts ?? []) {
    const latest = (project.records ?? []).filter((record) => record.partId === part.id).pop()
    if (latest?.status === 'needs-user-verification') pending.push({ part, latest })
  }

  if (pending.length > 0) {
    lines.push('', '待你确认：')
    for (const { part, latest } of pending) {
      lines.push(`  ${part.id}「${part.title}」`)
      lines.push(`    摘要：${latest.summary}`)
      for (const item of latest.evidence) {
        lines.push(`    证据：${item.split('\n')[0]}`)
      }
    }
  }

  return lines.join('\n')
}
