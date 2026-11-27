/**
 * 项目面板的视图模型 —— 纯函数：解析后的项目状态进，JSON 出。
 *
 * 这是面板唯一的「新接缝」：路由只做参数校验与序列化，浏览器半只负责画。
 * 派生状态（在飞、待确认、待复验、完成）由状态机算好，这里只翻成人话，
 * 不重新判断任何一条规则 —— 见 ADR-0004。
 */

import { APPROVAL_LABELS, PART_LABELS, PHASE_LABELS } from './format.js'
import { describeCheck } from './project-state.js'

const PENDING = 'needs-user-verification'

export function projectDetail(project, { updatedAt = null } = {}) {
  const coverage = coverageOf(project.parts)
  const records = project.records ?? []
  const latestOf = (partId) => records.filter((record) => record.partId === partId).pop()
  const runs = project.acceptanceRun ?? []
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined

  const criteria = (project.acceptance ?? []).map((item) => ({
    id: item.id,
    text: item.text,
    check: describeCheck(item.check),
    covering: coverage.get(item.id) ?? [],
    pendingApproval: (project.pendingCriteria ?? []).includes(item.id),
  }))

  const parts = (project.parts ?? []).map((part) => {
    const latest = latestOf(part.id)
    return {
      id: part.id,
      title: part.title,
      evidence: part.evidence,
      files: part.files ?? [],
      dependsOn: part.dependsOn ?? [],
      status: project.partStatus?.[part.id] ?? '',
      statusLabel: PART_LABELS[project.partStatus?.[part.id]] ?? '未开始',
      attempts: project.attempts?.[part.id] ?? 0,
      stray: latest?.stray ?? [],
      strayUnreliable: latest?.strayUnreliable === true,
    }
  })

  // 「待你确认」永远是页面第一块：它决定流程现在停没停。
  const pending = []
  for (const part of project.parts ?? []) {
    const latest = latestOf(part.id)
    if (latest?.status !== PENDING) continue
    pending.push({
      kind: 'part',
      partId: part.id,
      title: part.title,
      summary: latest.summary ?? '',
      evidence: latest.evidence ?? [],
    })
  }
  if (project.acceptancePending && lastRun) {
    pending.push({
      kind: 'acceptance',
      partId: 'AC',
      title: '收尾验收',
      summary: lastRun.summary ?? '',
      evidence: lastRun.evidence ?? [],
    })
  }

  // 收尾验收这一段：还没跑 / 跑完等你确认 / 被打回 / 已完成。
  let final = { state: 'none' }
  if (project.allDone) {
    final = { state: 'done', summary: lastRun?.summary ?? '', evidence: lastRun?.evidence ?? [] }
  } else if (project.allPartsVerified && project.phase !== 'abandoned') {
    if (project.acceptancePending && lastRun) {
      final = {
        state: 'pending-confirmation',
        summary: lastRun.summary ?? '',
        evidence: lastRun.evidence ?? [],
      }
    } else if (lastRun?.status === 'returned') {
      final = { state: 'returned', reason: lastRun.reason ?? '' }
    } else {
      final = { state: 'needs-run' }
    }
  }

  const problems = {}
  if (project.legacy) problems.legacy = '旧格式项目：只能看，要动先迁移'
  if (project.acceptanceProblem) problems.acceptance = project.acceptanceProblem
  if (project.planProblem) problems.plan = project.planProblem
  if (project.recordsProblem) problems.records = project.recordsProblem
  if (project.acceptanceRunProblem) problems.acceptanceRun = project.acceptanceRunProblem
  if (project.approvalProblem) problems.approvals = project.approvalProblem

  const retiredCriteria = (project.acceptanceIds ?? [])
    .filter((entry) => entry.retired)
    .map((entry) => entry.id)

  return {
    ok: true,
    updatedAt,
    project: {
      slug: project.slug,
      name: project.name,
      goal: project.goal,
      phase: project.phase,
      // 完成是「全部部分通过 + 收尾验收被确认」，读时按事实显示。
      phaseLabel: project.allDone ? '完成' : (PHASE_LABELS[project.phase] ?? project.phase),
      approved: project.approved === true,
      legacy: project.legacy === true,
    },
    criteria,
    retiredCriteria,
    parts,
    approvals: (project.approvals ?? []).map((record) => ({
      at: record.at,
      kind: record.kind,
      kindLabel: APPROVAL_LABELS[record.kind] ?? record.kind,
      note: record.note ?? '',
    })),
    pending,
    final,
    problems,
  }
}

/** 每条验收标准被哪些部分覆盖。 */
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
