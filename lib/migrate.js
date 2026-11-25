/**
 * 旧格式项目的迁移。
 *
 * 它不知道 DSH、不知道命令名、也不 import 状态机：解析、渲染、时间戳、
 * 项目解析、错误描述都在创建时注入。所以这块逻辑能脱离状态机，
 * 状态机那边只剩一个转发的入口。
 */

function trim(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createMigration({
  store,
  schema,
  formatVersion,
  phases,
  evidenceTypes,
  stamp,
  resolve,
  reasonOf,
}) {
  const {
    parseProject,
    parseLegacyAcceptance,
    parsePlan,
    renderAcceptance,
    renderPlan,
    renderProject,
    sortById,
    acceptanceFingerprint,
  } = schema

  /**
   * 迁移一个项目：先备份，再把文档改写成当前格式。
   * 旧计划没有覆盖关系，所以给各标准轮着找部分，然后退回待批准 ——
   * 用户不认这个分法，改计划就行。
   */
  function migrate(input) {
    if (trim(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能迁移项目' }
    }

    const resolved = resolve(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const slug = resolved.slug
    let raw
    try {
      raw = store.read(slug)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态读不出来：${reasonOf(error)}` }
    }
    if (raw === null || raw?.project === null || raw?.project === undefined) {
      return { ok: false, problem: `找不到项目「${slug}」` }
    }

    let fields
    try {
      fields = parseProject(raw.project)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }

    if (fields.formatVersion >= formatVersion) {
      return { ok: false, problem: `项目「${slug}」已经是当前格式（v${formatVersion}），不用迁移` }
    }

    let acceptance
    try {
      acceptance = parseLegacyAcceptance(raw.acceptance)
    } catch (error) {
      return { ok: false, problem: `旧格式的验收标准读不出来：${reasonOf(error)}` }
    }

    if (typeof store.backup !== 'function') {
      return { ok: false, problem: '这个存储不支持备份，迁移不做 —— 没有备份的迁移不许发生' }
    }

    let backup
    try {
      backup = store.backup(slug, raw)
    } catch (error) {
      return { ok: false, problem: `备份失败，迁移没做：${reasonOf(error)}` }
    }

    // 旧计划没有覆盖关系：先按旧格式读出来（跳过覆盖校验），再把标准分给各个部分。
    let legacyParts = []
    try {
      legacyParts = parsePlan(raw.plan, evidenceTypes, [], { validate: false })
    } catch {
      legacyParts = []
    }

    const migratedParts = legacyParts.map((part) => ({ ...part, covers: [] }))
    for (const [index, item] of acceptance.entries()) {
      if (migratedParts.length === 0) break
      migratedParts[index % migratedParts.length].covers.push(item.id)
    }

    // 退役登记不能因为迁移就丢掉：丢掉了旧编号就能被重新用上。
    const retiredKept = (fields.acceptanceIds ?? []).filter(
      (entry) => entry.retired && !acceptance.some((item) => item.id === entry.id),
    )
    const nextIds = sortById([
      ...acceptance.map((item) => ({ id: item.id, retired: false })),
      ...retiredKept,
    ])

    const hasPlan = migratedParts.length > 0

    // 已经批过的老项目，迁移不再强迫重走一遍批准：覆盖是自动分的，写进审批历史留痕。
    // 没批过的老项目仍然要批 —— 那是它原本就欠的那一步。
    const DECISIVE = ['approved', 'rejected', 'revised', 'abandoned']
    const previousDecisive = [...(fields.approvals ?? [])]
      .reverse()
      .find((entry) => DECISIVE.includes(entry.kind))
    const wasApproved = hasPlan && previousDecisive?.kind === 'approved'

    const phase = wasApproved
      ? phases.executing
      : hasPlan
        ? phases.awaitingApproval
        : phases.planning

    const approvals = wasApproved
      ? [...fields.approvals, { at: stamp(), kind: 'migrated', note: '' }]
      : hasPlan
        ? [...fields.approvals, { at: stamp(), kind: 'revised', note: '' }]
        : fields.approvals

    const documents = {
      acceptance: renderAcceptance(acceptance),
      project: renderProject({
        ...fields,
        phase,
        acceptanceHash: wasApproved ? acceptanceFingerprint(acceptance) : '',
        acceptanceIds: nextIds,
        approvals,
      }),
    }
    if (hasPlan) documents.plan = renderPlan(migratedParts)

    try {
      store.write(slug, documents)
    } catch (error) {
      return { ok: false, problem: `写不了迁移后的状态：${reasonOf(error)}` }
    }

    return {
      ok: true,
      count: acceptance.length,
      backup,
      parts: migratedParts.length,
      approved: wasApproved,
    }
  }

  return { migrate }
}
