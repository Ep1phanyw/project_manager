/**
 * 给人看的渲染。状态机只管状态，怎么排版给用户看归这里。
 */

import { STATUS_LABELS } from './records.js'
import { describeCheck } from './project-state.js'

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
  acceptance: '待收尾验收',
  abandoned: '已放弃',
}

const APPROVAL_LABELS = {
  approved: '批准',
  rejected: '驳回',
  revised: '计划更新，需重新批准',
  criteria: '验收标准改过，需重新批准',
  abandoned: '放弃',
}

const PART_LABELS = {
  ...STATUS_LABELS,
  interrupted: '中断（等你解除）',
  'unverified-acceptance': '验收记录不完整',
}

/** 每条验收标准被哪些部分覆盖 —— 状态里要能一眼看出有没有标准没人管。 */
function coverageOf(parts) {
  const byCriterion = new Map()
  for (const part of parts ?? []) {
    for (const cover of part.covers ?? []) {
      if (!byCriterion.has(cover)) byCriterion.set(cover, [])
      byCriterion.get(cover).push(part.id)
    }
  }
  return byCriterion
}

export function formatStatus(project) {
  const phase = project.allDone ? '完成' : (PHASE_LABELS[project.phase] ?? project.phase)
  const goal = project.goal
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n')
  const acceptance = project.acceptance
    .map((item) => {
      const covering = coverageOf(project.parts).get(item.id) ?? []
      const by = covering.length > 0 ? covering.join('、') : '无'
      return `  ${item.id}  ${item.text}　｜　检查：${describeCheck(item.check)}　｜　覆盖：${by}`
    })
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
      const retries = project.attempts?.[part.id] ?? 0
      lines.push(
        `  ${part.id}  ${part.title}　｜　证据 ${part.evidence}　｜　依赖 ${dependsOn}　｜　${status}　｜　重试 ${retries} 次`,
      )

      // 越界改动是质量衰减的第一个信号：子对话动了不该动的文件。
      const latest = (project.records ?? []).filter((record) => record.partId === part.id).pop()
      if (latest?.stray?.length > 0) {
        const note = latest.strayUnreliable ? '（并行期间不可靠，仅供参考）' : ''
        lines.push(`    越界改动：${latest.stray.join('、')}${note}`)
      }
    }
  }

  // 部分做完不等于项目交付：收尾验收是唯一一次整体验证，必须露在状态里。
  if (project.allPartsVerified && !project.allDone && project.phase !== 'abandoned') {
    lines.push('', '收尾验收：')

    const last = project.acceptanceRun?.at(-1)

    if (project.acceptancePending && last) {
      lines.push('  跑过了，结果在等你确认：')
      lines.push(`    摘要：${last.summary}`)
      for (const item of last.evidence) {
        const [first, ...rest] = item.split('\n')
        lines.push(`    证据：${first}`)
        for (const extra of rest) lines.push(`      ${extra}`)
      }
      lines.push(`  /${project.commandName ?? 'manager'} accept 确认，或 decline <理由> 打回。`)
    } else if (last?.status === 'returned') {
      lines.push(`  上一轮被打回了：${last.reason}`)
      lines.push('  改完再跑一遍验收标准，用 manager_accept 重新记录。')
    } else {
      lines.push('  所有部分都验收通过了，但项目还没交付 —— 现在真的跑一遍上面的验收标准。')
      lines.push('  跑完用 manager_accept 记录结果，再由你确认。')
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
        const [first, ...rest] = item.split('\n')
        lines.push(`    证据：${first}`)
        for (const extra of rest) lines.push(`      ${extra}`)
      }
    }
  }

  return lines.join('\n')
}
