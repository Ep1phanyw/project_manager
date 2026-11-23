/**
 * ProjectState —— 本插件唯一的行为接缝：项目的状态机与校验器。
 *
 * 它不碰 DSH，也不知道文件怎么存：状态怎么读写由注入的 store 决定，
 * 跑子对话由注入的 runChild 决定。测试里两者都是假件。
 */

import { RECORD_STATUS, parseRecords, renderRecords } from './records.js'

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const HEADING_LINE = /^\s*#{1,6}\s/
const PHASE_LINE = /^\s*阶段[：:]/
const ACCEPTANCE_LINE = /^- \[AC-\d+\] (.*)$/
const PART_HEADING = /^## \[(P\d+)\] (.+)$/
const PLAN_FIELD = /^- (依赖|证据|文件)[：:](.*)$/
const APPROVAL_LINE = /^- (\S+) (批准|驳回|更新)(?:[：:](.*))?$/
const PART_ID = /^P\d+$/

/** 只认可复现的证据类型；「我确认过了」不在其中。 */
export const EVIDENCE_TYPES = ['test', 'build', 'command', 'artifact']

/** 阶段是状态机的基础，写死在文件里，但闸门不单靠这一行。 */
const PHASE = {
  planning: 'planning',
  awaitingApproval: 'awaiting-approval',
  executing: 'executing',
}

export function createProjectState({
  store,
  now = () => Date.now(),
  commandName = 'manager',
  runChild,
}) {
  function startProject(input) {
    const name = trimmedText(input?.name)
    const goal = trimmedText(input?.goal)
    const acceptance = listOf(input?.acceptance)

    const problem = checkName(name) || checkGoal(goal) || checkAcceptance(acceptance)
    if (problem) return { ok: false, problem }

    const slug = slugOf(name)
    try {
      if (store.read(slug) !== null) return { ok: false, problem: `项目「${slug}」已存在` }
      store.write(slug, {
        project: renderProject({
          name,
          goal,
          phase: PHASE.planning,
          approvals: [],
        }),
        acceptance: renderAcceptance(acceptance),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, slug }
  }

  /**
   * 提交计划。已批准的计划可以被改 —— 但那一次改动会记进审批历史，
   * 并把项目退回待批准，所以「改过之后没人再看一眼就继续跑」不会发生。
   */
  function submitPlan(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const parts = normalizeParts(input?.parts)
    const problem = validatePlan(parts)
    if (problem) return { ok: false, problem }

    const { project } = loaded
    const revised = project.phase === PHASE.executing
    const approvals = revised
      ? [...project.approvals, { at: stamp(), kind: 'revised', note: '' }]
      : project.approvals

    try {
      store.write(project.slug, {
        plan: renderPlan(parts),
        // 计划变了，旧结果就不再对应新的活：记录清空，免得旧的「验收通过」
        // 被当成新计划的完成。
        parts: renderRecords([]),
        project: renderProject({ ...project, phase: PHASE.awaitingApproval, approvals }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了计划：${reasonOf(error)}` }
    }

    return { ok: true, count: parts.length, revised }
  }

  /** 批准与驳回只认 user：模型没有通往这里的工具，这一层是第二道锁。 */
  function approvePlan(input) {
    return recordDecision(input, 'approved')
  }

  function rejectPlan(input) {
    return recordDecision(input, 'rejected')
  }

  function recordDecision(input, kind) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能批准或驳回计划' }
    }

    const note = trimmedText(input?.reason)
    if (kind === 'rejected') {
      const problem = checkReason(note, '驳回')
      if (problem) return { ok: false, problem }
    } else if (/[\r\n]/.test(note)) {
      return { ok: false, problem: '理由不能包含换行：那会把审批记录写坏' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    if (project.approvalProblem) {
      return { ok: false, problem: `审批记录读不懂，不敢动：${project.approvalProblem}` }
    }
    if (project.phase === PHASE.planning && project.parts.length === 0) {
      return { ok: false, problem: '还没有计划；先提交一份计划' }
    }

    if (kind === 'approved') {
      if (project.approved && project.phase === PHASE.executing) {
        return { ok: false, problem: '计划已经批准过了' }
      }
      if (project.phase !== PHASE.awaitingApproval) {
        return { ok: false, problem: '计划还没到待批准；先重新提交一份计划' }
      }
      if (project.planProblem) {
        return { ok: false, problem: `计划读不出来，不能批准：${project.planProblem}` }
      }

      const problem = validatePlan(project.parts)
      if (problem) return { ok: false, problem: `计划不合法，不能批准：${problem}` }
    } else if (project.phase !== PHASE.awaitingApproval && project.phase !== PHASE.executing) {
      return { ok: false, problem: '现在没有可以驳回的计划' }
    }

    const approvals = [...project.approvals, { at: stamp(), kind, note }]
    const phase = kind === 'approved' ? PHASE.executing : PHASE.planning

    try {
      store.write(project.slug, { project: renderProject({ ...project, phase, approvals }) })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true }
  }

  /**
   * 取下一个可派分的部分。
   *
   * 闸门不信任 `阶段：` 这一行 —— 它是普通 markdown，谁都改得了 ——
   * 而是要求审批历史里最后一条确实是「批准」。手改阶段行骗不过这里。
   */
  function nextPart(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    if (project.approvalProblem) {
      return { ok: false, problem: `审批记录读不懂，无法确认计划是否批准：${project.approvalProblem}` }
    }
    if (project.planProblem) {
      return { ok: false, problem: `计划读不出来：${project.planProblem}` }
    }
    if (project.parts.length === 0) {
      return { ok: false, problem: '还没有计划；先提交一份计划' }
    }
    if (project.phase !== PHASE.executing || !project.approved) {
      return { ok: false, problem: `计划尚未批准；先用 /${commandName} approve 批准` }
    }

    const latest = new Map()
    for (const record of project.records) latest.set(record.partId, record)

    // 有部分在等用户时先停下：再派一次只会把同一个结果重跑一遍。
    const waiting = project.parts.find((candidate) => {
      const status = latest.get(candidate.id)?.status
      return status === RECORD_STATUS.blocked || status === RECORD_STATUS.needsUserVerification
    })
    if (waiting) {
      const why =
        latest.get(waiting.id).status === RECORD_STATUS.blocked ? '报了阻塞' : '等你确认'
      return { ok: false, problem: `部分 ${waiting.id}「${waiting.title}」${why}，先处理它` }
    }

    // 子对话说完成只是候选，主对话验收之后才算完 —— 验收没过就不许往后派。
    const pending = project.parts.find(
      (candidate) => latest.get(candidate.id)?.status === RECORD_STATUS.done,
    )
    if (pending) {
      return {
        ok: false,
        problem: `部分 ${pending.id}「${pending.title}」有候选完成回报，先验收它`,
      }
    }

    const completed = project.verified
    const part = project.parts.find(
      (candidate) =>
        !completed.has(candidate.id) &&
        candidate.dependsOn.every((dependency) => completed.has(dependency)),
    )
    if (!part) return { ok: false, problem: '没有可派分的部分：剩下的都被未完成的部分挡着' }

    return { ok: true, project, part }
  }

  /**
   * 派分下一个部分：起一个子对话，把它交回的回报记下来。
   *
   * 子对话失败、抛异常、回报不合规，都不算项目崩了 —— 这个部分记为可重试。
   */
  async function dispatchNext(input) {
    const gate = nextPart(input)
    if (!gate.ok) return gate

    const { project, part } = gate
    if (typeof runChild !== 'function') {
      return { ok: false, problem: '没有接上跑子对话的能力，派分不了' }
    }

    // 轮次只数「派分结果」：验收结论之外的一律算一次派分。
    // 用「排除验收结论」而不是白名单 —— 以后新增派分状态不会因为漏加而悄悄少数。
    const verdictStatuses = new Set([RECORD_STATUS.accepted, RECORD_STATUS.returned])
    const attempt =
      project.records.filter(
        (record) => record.partId === part.id && !verdictStatuses.has(record.status),
      ).length + 1
    const prompt = buildPrompt({ project, part, attempt })
    const at = stamp()

    let outcome
    try {
      outcome = await runChild({ part, project, attempt, prompt, signal: input?.signal })
    } catch (error) {
      outcome = { ok: false, problem: reasonOf(error) }
    }

    if (!outcome || outcome.ok !== true) {
      const problem = outcome?.problem ?? '子对话没有返回结果'
      const written = writeRecords(project, [
        ...project.records,
        {
          partId: part.id,
          attempt,
          at,
          status: RECORD_STATUS.failed,
          summary: problem,
          evidence: [],
          sessionId: '',
          blockedReason: '',
        },
      ])
      if (written) return { ok: false, problem: written }
      return { ok: false, problem: `部分 ${part.id} 的子对话失败了：${problem}`, retryable: true }
    }

    const report = outcome.report
    const problem = checkReport(report, part, project)
    if (problem) {
      const written = writeRecords(project, [
        ...project.records,
        {
          partId: part.id,
          attempt,
          at,
          status: RECORD_STATUS.invalid,
          summary: `回报不合规：${problem}`,
          evidence: [],
          sessionId: '',
          blockedReason: '',
        },
      ])
      if (written) return { ok: false, problem: written }
      return { ok: false, problem: `部分 ${part.id} 的回报不合规：${problem}`, retryable: true }
    }

    const written = writeRecords(project, [
      ...project.records,
      {
        partId: part.id,
        attempt,
        at,
        status: trimmedText(report.status),
        summary: trimmedText(report.summary),
        evidence: listOf(report.evidence),
        sessionId: trimmedText(outcome.sessionId) || trimmedText(report.sessionId),
        blockedReason: trimmedText(report.blockedReason),
      },
    ])
    if (written) return { ok: false, problem: written }

    return { ok: true, part, attempt, report }
  }

  /**
   * 验收一个部分。子对话说完成只是候选，这里才决定算不算数：
   * 通过要有候选完成 + 证据 + 写明理由；不通过要写明差在哪。
   */
  function verifyPart(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    if (project.phase !== PHASE.executing || !project.approved) {
      return { ok: false, problem: `计划尚未批准或已退回；先用 /${commandName} approve 批准` }
    }

    const partId = trimmedText(input?.part)
    const part = project.parts.find((candidate) => candidate.id === partId)
    if (!part) return { ok: false, problem: `计划里没有部分「${partId || '未指定'}」` }

    const latest = project.records.filter((record) => record.partId === partId).pop()
    if (!latest) return { ok: false, problem: `部分 ${partId} 还没有子对话回报，没什么可验收的` }
    if (latest.status !== RECORD_STATUS.done) {
      return {
        ok: false,
        problem: `部分 ${partId} 最近一次回报是「${latest.status}」，不是候选完成；先重新派分`,
      }
    }
    if (latest.evidence.length === 0) {
      return { ok: false, problem: `部分 ${partId} 的回报没有证据，不能算完成` }
    }

    const verdict = trimmedText(input?.verdict)
    if (!Object.hasOwn(VERDICT_STATUS, verdict)) {
      return { ok: false, problem: `验收结论「${verdict}」不认识；只接受 pass 或 fail` }
    }

    const reason = trimmedText(input?.reason)
    const reasonProblem = checkReason(reason, '验收')
    if (reasonProblem) return { ok: false, problem: reasonProblem }

    const records = [
      ...project.records,
      {
        partId,
        attempt: latest.attempt,
        at: stamp(),
        status: VERDICT_STATUS[verdict],
        summary: reason,
        evidence: latest.evidence,
        sessionId: '',
        blockedReason: '',
      },
    ]

    // 同一部分连续两次因同一个原因验收失败，就直接判阻塞 —— 不用等谁来宣布。
    let blocked = false
    if (verdict === 'fail') {
      const repeat = repeatFailureReason(records, partId)
      if (repeat) {
        blocked = true
        records.push({
          partId,
          attempt: latest.attempt,
          at: stamp(),
          status: RECORD_STATUS.blocked,
          summary: `连续两次验收失败，原因都是「${repeat}」`,
          evidence: [],
          sessionId: '',
          blockedReason: '同一个原因已经卡了两次：换个方向、补上缺的东西，或者调整验收标准',
        })
      }
    }

    const written = writeRecords(project, records)
    if (written) return { ok: false, problem: written }

    return { ok: true, part, verdict, ...(blocked ? { blocked: true } : {}) }
  }

  /**
   * 模型请求阻塞。只承认 ADR-0001 的三种情形，别的一律拒；
   * 「连续两次同样失败」由插件自己数，模型说了不算。
   */
  function requestBlock(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    const partId = trimmedText(input?.part)
    const part = project.parts.find((candidate) => candidate.id === partId)
    if (!part) return { ok: false, problem: `计划里没有部分「${partId || '未指定'}」` }

    const condition = trimmedText(input?.condition)
    const label = CONDITION_LABELS[condition]
    if (!label) {
      return {
        ok: false,
        problem: `阻塞情形「${condition || '未指定'}」不在允许的三种里：只接受 ${Object.keys(CONDITION_LABELS).join(' / ')}`,
      }
    }

    const detail = trimmedText(input?.detail)
    if (!detail) {
      return { ok: false, problem: '请求阻塞要说清：缺什么、或者为什么现有验收标准做不到' }
    }
    if (/[\r\n]/.test(detail)) {
      return { ok: false, problem: '阻塞说明不能包含换行：那会把记录写坏' }
    }

    if (condition === BLOCK_CONDITIONS.repeatedFailure && !repeatFailureReason(project.records, partId)) {
      return { ok: false, problem: `部分 ${partId} 没有连续两次同样的验收失败，不构成这个情形` }
    }

    const latest = project.records.filter((record) => record.partId === partId).pop()

    const written = writeRecords(project, [
      ...project.records,
      {
        partId,
        attempt: latest?.attempt ?? 1,
        at: stamp(),
        status: RECORD_STATUS.blocked,
        summary: label,
        evidence: [],
        sessionId: '',
        blockedReason: detail,
      },
    ])
    if (written) return { ok: false, problem: written }

    return { ok: true, part }
  }

  /** 把当前阻塞的部分摊成一份给用户看的报告。 */
  function blockReport(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    const lines = []

    for (const part of project.parts) {
      const latest = project.records.filter((record) => record.partId === part.id).pop()
      if (latest?.status !== RECORD_STATUS.blocked) continue

      lines.push(`卡在：部分 ${part.id}「${part.title}」`)
      lines.push(`情形：${latest.summary}`)
      if (latest.blockedReason) lines.push(`需要你：${latest.blockedReason}`)
      lines.push('')
    }

    if (lines.length === 0) return { ok: false, problem: '现在没有部分处于阻塞' }
    return { ok: true, text: lines.join('\n').trim() }
  }

  /** 成功返回 null，失败返回可读原因。 */
  function writeRecords(project, records) {
    try {
      store.write(project.slug, { parts: renderRecords(records) })
      return null
    } catch (error) {
      return `写不了部分记录：${reasonOf(error)}`
    }
  }

  function status(requested) {
    const resolved = resolveProject(requested)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const loaded = load({ project: resolved.slug })
    if (!loaded.ok) return loaded
    return { ok: true, project: loaded.project }
  }

  function resolveProject(requested) {
    const wanted = trimmedText(requested)

    if (wanted) {
      const problem = checkName(wanted)
      if (problem) return { problem }
      return { slug: slugOf(wanted) }
    }

    let slugs
    try {
      slugs = store.listProjects()
    } catch (error) {
      return { problem: `读不了项目列表：${reasonOf(error)}` }
    }

    if (slugs.length === 0) return { problem: '还没有项目；先在主对话里启动一个项目' }
    if (slugs.length > 1) {
      return {
        problem: `有多个项目：${slugs.join('、')} —— 请指定一个（/${commandName} <项目名>）`,
      }
    }
    return { slug: slugs[0] }
  }

  /** 唯一的状态读取形状：要么 `{ ok: true, project }`，要么 `{ ok: false, problem }`。 */
  function load(input) {
    const resolved = resolveProject(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const slug = resolved.slug
    let raw
    try {
      raw = store.read(slug)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态读不出来：${reasonOf(error)}` }
    }
    if (raw === null) return { ok: false, problem: `找不到项目「${slug}」` }

    let fields
    try {
      fields = parseProject(raw.project)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }

    let acceptance
    try {
      acceptance = parseAcceptance(raw.acceptance)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的验收标准读不出来：${reasonOf(error)}` }
    }

    // 计划读不出来只降级计划本身：目标与验收标准仍然要看得见。
    let parts = []
    let planProblem = ''
    try {
      parts = parsePlan(raw.plan)
    } catch (error) {
      planProblem = reasonOf(error)
    }

    // 部分记录读不出来也只降级它自己。
    let records = []
    let recordsProblem = ''
    try {
      records = parseRecords(raw.parts)
    } catch (error) {
      recordsProblem = reasonOf(error)
    }

    const partStatus = {}
    for (const record of records) partStatus[record.partId] = record.status

    // 验收通过必须站得住：它前面得有一条同轮次、带证据的候选完成记录。
    const verified = verifiedParts(records)
    for (const [id, status] of Object.entries(partStatus)) {
      if (status === RECORD_STATUS.accepted && !verified.has(id)) {
        partStatus[id] = 'unverified-acceptance'
      }
    }

    const last = fields.approvals[fields.approvals.length - 1]

    return {
      ok: true,
      project: {
        slug,
        ...fields,
        acceptance,
        parts,
        planProblem,
        records,
        recordsProblem,
        partStatus,
        verified,
        approved: last?.kind === 'approved',
      },
    }
  }

  function stamp() {
    return new Date(now()).toISOString()
  }

  return {
    startProject,
    submitPlan,
    approvePlan,
    rejectPlan,
    nextPart,
    dispatchNext,
    verifyPart,
    requestBlock,
    blockReport,
    status,
  }
}

const REPORT_STATUSES = [
  RECORD_STATUS.done,
  RECORD_STATUS.needsUserVerification,
  RECORD_STATUS.blocked,
]

/** 验收结论 → 写进记录的状态。 */
const VERDICT_STATUS = {
  pass: RECORD_STATUS.accepted,
  fail: RECORD_STATUS.returned,
}

/** ADR-0001：阻塞只在这三种情形成立，别的一律不认。 */
const BLOCK_CONDITIONS = {
  repeatedFailure: 'repeated-failure',
  missingUserInput: 'missing-user-input',
  criteriaChange: 'criteria-change',
}

const CONDITION_LABELS = {
  'repeated-failure': '同一部分连续两次验收失败且原因未变',
  'missing-user-input': '缺少只有用户能提供的东西',
  'criteria-change': '需要改动验收标准本身',
}

function checkReport(report, part, project) {
  if (!report || typeof report !== 'object') return '回报不是一个对象'

  const status = trimmedText(report.status)
  if (!REPORT_STATUSES.includes(status)) {
    return `回报里的状态「${status}」不认识；只接受 ${REPORT_STATUSES.join(' / ')}`
  }
  if (!trimmedText(report.summary)) return '回报缺摘要'

  const evidence = listOf(report.evidence)
  if (evidence.length === 0) {
    return '回报里没有证据：每条回报都要带证据清单，即使这一部分没做成'
  }

  if (status === RECORD_STATUS.done) {
    // 证据类型不是装饰：报完成时至少要有一条证据真是这个类型。
    const typed = evidence.some((item) => matchesEvidenceType(item, part.evidence))
    if (!typed) {
      return `判为完成，但没有一条证据是这部分要求的 ${part.evidence} 类型；证据要写成「${part.evidence}：<具体内容>」`
    }
  }

  if (status === RECORD_STATUS.blocked) {
    const condition = trimmedText(report.blockedCondition)
    if (!CONDITION_LABELS[condition]) {
      return `判为阻塞，但没说清是哪种情形；只接受 ${Object.keys(CONDITION_LABELS).join(' / ')}`
    }
    if (!trimmedText(report.blockedReason)) {
      return '判为阻塞却没说清卡在哪：要说清需要用户提供什么'
    }
    if (
      condition === BLOCK_CONDITIONS.repeatedFailure &&
      !repeatFailureReason(project.records, part.id)
    ) {
      return '声称连续两次同样的失败，但记录里对不上：这个情形由插件自己判定'
    }
  }

  return ''
}

/** 同一部分最近两次验收失败且理由一样时，返回那个理由。 */
function repeatFailureReason(records, partId) {
  const failures = records.filter(
    (record) => record.partId === partId && record.status === RECORD_STATUS.returned,
  )
  if (failures.length < 2) return ''

  const last = failures[failures.length - 1]
  const before = failures[failures.length - 2]
  return last.summary === before.summary ? last.summary : ''
}

function checkReason(value, what) {
  if (!value) return `${what}要给理由：没有理由的记录等于没留下信息`
  if (/[\r\n]/.test(value)) return `${what}理由不能包含换行：那会把记录写坏`
  return ''
}

/**
 * 一条 accepted 记录只有前面紧挨着同部分、同轮次、带证据的 done 记录时才算数。
 * 这样手写一行「- 状态：accepted」绕不过验收 —— 它得连同前置的候选完成一起伪造。
 */
function verifiedParts(records) {
  const verified = new Set()
  const last = new Map()

  for (const record of records) {
    const previous = last.get(record.partId)

    if (record.status === RECORD_STATUS.returned) {
      verified.delete(record.partId)
    } else if (record.status === RECORD_STATUS.accepted) {
      const stands =
        previous !== undefined &&
        previous.status === RECORD_STATUS.done &&
        previous.attempt === record.attempt &&
        previous.evidence.length > 0

      if (stands) verified.add(record.partId)
      else verified.delete(record.partId)
    }

    last.set(record.partId, record)
  }

  return verified
}

function matchesEvidenceType(item, type) {
  return new RegExp(`^${type}\\s*[：:]`, 'i').test(item)
}

function buildPrompt({ project, part, attempt }) {
  const acceptance = project.acceptance
    .map((item, index) => `  - AC-${index + 1} ${item}`)
    .join('\n')
  const files = part.files.map((file) => `  - ${file}`).join('\n')

  return [
    `你是「${project.name}」这个项目里的子对话，只负责下面这一个部分（第 ${attempt} 次尝试）。`,
    '',
    `部分编号：${part.id}`,
    `部分标题：${part.title}`,
    '会改动的文件：',
    files,
    `要求的证据类型：${part.evidence}`,
    '',
    '项目目标：',
    project.goal,
    '',
    '项目的验收标准：',
    acceptance,
    '',
    '要求：',
    '1. 只做这个部分，不要顺手改别的部分负责的文件。',
    '2. 做完后按结构化结果回报：status（done / needs-user-verification / blocked）、summary、evidence。',
    '3. 证据必须可复现：测试输出、构建结果、命令输出或产物。每条证据以「' +
      part.evidence +
      '：」开头，不要写「我确认过了」。',
    '4. 只有三种情况报 blocked：同一个原因连续失败、缺只有用户能提供的东西、需要改验收标准。报 blocked 必须写 blockedReason。',
  ].join('\n')
}

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(value) {
  if (!Array.isArray(value)) return []
  return value.map(trimmedText).filter(Boolean)
}

function slugOf(name) {
  return name.replace(/\s+/g, '-')
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function checkName(name) {
  if (!name) return '项目名不能为空'
  if (/[\r\n]/.test(name)) return '项目名不能包含换行'
  if (BAD_NAME_CHARS.test(name)) {
    return `项目名不能包含 \\ / : * ? " < > | 这些字符：「${name}」`
  }
  if (name === '.' || name === '..') return `项目名不能是「${name}」`
  if (RESERVED_NAME.test(name)) return `「${name}」是系统保留名，不能当目录名`
  return ''
}

function checkGoal(goal) {
  if (!goal) return '目标不能为空'
  for (const line of goal.split(/\r?\n/)) {
    if (HEADING_LINE.test(line)) {
      return '目标里不能有 markdown 标题行（# 开头）：那会把状态文件截断'
    }
    if (PHASE_LINE.test(line)) {
      return '目标里不能有以「阶段：」开头的行：那会和状态字段混淆'
    }
  }
  return ''
}

function checkAcceptance(items) {
  if (items.length === 0) return '至少要有一条验收标准'
  for (const item of items) {
    if (/[\r\n]/.test(item)) {
      return `验收标准不能包含换行：「${item.slice(0, 20)}…」`
    }
  }
  return ''
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => ({
    id: trimmedText(item?.id) || `P${index + 1}`,
    title: trimmedText(item?.title),
    dependsOn: listOf(item?.dependsOn),
    files: listOf(item?.files).map(normalizePath),
    evidence: trimmedText(item?.evidence),
  }))
}

function validatePlan(parts) {
  if (parts.length === 0) return '计划里至少要有一个部分'

  const ids = new Set()
  for (const part of parts) {
    if (!PART_ID.test(part.id)) return `部分的编号「${part.id}」不合法，应形如 P1`
    if (ids.has(part.id)) return `部分编号重复：${part.id}`
    ids.add(part.id)
  }

  for (const part of parts) {
    if (!part.title) return `部分 ${part.id} 缺少标题`
    if (/[\r\n]/.test(part.title)) {
      return `部分 ${part.id} 的标题不能包含换行：那会把计划文件写坏`
    }
    if (part.files.length === 0) return `部分 ${part.id} 没有声明涉及的文件集`
    for (const file of part.files) {
      if (/[\r\n]/.test(file)) return `部分 ${part.id} 的文件路径不能包含换行`
    }
    if (!EVIDENCE_TYPES.includes(part.evidence)) {
      return `部分 ${part.id} 的证据类型「${part.evidence}」不认识；只接受 ${EVIDENCE_TYPES.join(' / ')}`
    }
  }

  for (const part of parts) {
    for (const dependency of part.dependsOn) {
      if (!ids.has(dependency)) return `部分 ${part.id} 依赖了不存在的部分 ${dependency}`
    }
  }

  const byId = new Map(parts.map((part) => [part.id, part]))
  const cycle = findCycle(parts, byId)
  if (cycle) return `依赖成环：${cycle.join(' → ')}`

  const overlapping = overlappingPairs(parts)
  if (overlapping.length === 0) return ''

  const ancestorsOf = memoizedAncestors(byId)

  for (const { first, second, file } of overlapping) {
    const ordered =
      ancestorsOf(first.id).has(second.id) || ancestorsOf(second.id).has(first.id)
    if (!ordered) {
      return `部分 ${first.id} 与 ${second.id} 都改 ${file}，却没有先后关系（${first.id} → ${second.id} 或 ${second.id} → ${first.id}）`
    }
  }

  return ''
}

function overlappingPairs(parts) {
  const pairs = []

  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const first = parts[left]
      const second = parts[right]
      const shared = first.files.find((one) =>
        second.files.some((other) => pathsOverlap(one, other)),
      )
      if (shared) pairs.push({ first, second, file: shared })
    }
  }

  return pairs
}

/**
 * 两条路径是否落在同一片地方。
 * 相等算重叠，目录与它下面的文件也算 —— 计划里写 `src/auth/` 和 `src/auth/login.js`
 * 的两个部分如果并行，一样会互相踩。
 */
function pathsOverlap(one, other) {
  if (one === other) return true
  return one.startsWith(other + '/') || other.startsWith(one + '/')
}

function memoizedAncestors(byId) {
  const cache = new Map()

  return function ancestorsOf(id) {
    const cached = cache.get(id)
    if (cached) return cached

    const seen = new Set()
    cache.set(id, seen)
    const stack = [...(byId.get(id)?.dependsOn ?? [])]

    while (stack.length > 0) {
      const next = stack.pop()
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(...(byId.get(next)?.dependsOn ?? []))
    }

    return seen
  }
}

function findCycle(parts, byId) {
  const state = new Map()
  const stack = []

  function visit(id) {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }

    state.set(id, 'visiting')
    stack.push(id)

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }

    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const part of parts) {
    const cycle = visit(part.id)
    if (cycle) return cycle
  }
  return null
}

function renderProject({ name, goal, phase, approvals }) {
  const lines = ['# ' + name, '', `阶段：${phase}`, '', '## 目标', '', goal]

  if (approvals.length > 0) {
    lines.push('', '## 审批', '')
    for (const record of approvals) {
      lines.push(`- ${record.at} ${LABEL_OF[record.kind]}${record.note ? `：${record.note}` : ''}`)
    }
  }

  return [...lines, ''].join('\n')
}

const LABEL_OF = { approved: '批准', rejected: '驳回', revised: '更新' }

function renderAcceptance(items) {
  const lines = items.map((item, index) => `- [AC-${index + 1}] ${item}`)
  return ['# 验收标准', '', ...lines, ''].join('\n')
}

/** 一个文件一行、一个依赖一行：不靠分隔符，所以路径里带逗号也不会被拆开。 */
function renderPlan(parts) {
  const blocks = parts.map((part) => {
    const lines = [`## [${part.id}] ${part.title}`, '']

    const dependencies = part.dependsOn.length > 0 ? part.dependsOn : ['无']
    for (const dependency of dependencies) lines.push(`- 依赖：${dependency}`)

    lines.push(`- 证据：${part.evidence}`)

    const files = part.files.length > 0 ? part.files : ['无']
    for (const file of files) lines.push(`- 文件：${file}`)

    return lines.join('\n')
  })

  return ['# 计划', '', blocks.join('\n\n'), ''].join('\n')
}

function parseProject(source) {
  const nameMatch = /^#[ \t]+(.+)$/m.exec(source)
  if (!nameMatch) throw new Error('缺少标题行「# 项目名」')

  const phaseMatch = /^阶段[：:][ \t]*(\S+)[ \t]*$/m.exec(source)
  if (!phaseMatch) throw new Error('缺少「阶段：」行')

  const goal = sectionBody(source, '目标')
  if (!goal) throw new Error('缺少「## 目标」段')

  const { records, problem } = parseApprovals(source)

  return {
    name: nameMatch[1].trim(),
    phase: phaseMatch[1],
    goal,
    approvals: records,
    approvalProblem: problem,
  }
}

/**
 * 审批记录按行读，认不出的一行不炸掉整个项目，而是记成 approvalProblem ——
 * 之后要靠它判断「计划到底批没批过」，所以也不许被忽略。
 */
function parseApprovals(source) {
  const body = sectionBody(source, '审批')
  if (!body) return { records: [], problem: '' }

  const records = []
  let problem = ''

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = APPROVAL_LINE.exec(trimmed)
    if (!match) {
      problem ||= `审批记录里有一行认不出来：「${trimmed}」`
      continue
    }

    records.push({
      at: match[1],
      kind: match[2] === '批准' ? 'approved' : match[2] === '驳回' ? 'rejected' : 'revised',
      note: (match[3] ?? '').trim(),
    })
  }

  return { records, problem }
}

function parseAcceptance(source) {
  if (source === null || source === undefined) throw new Error('缺少验收标准文件')

  const items = []
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = ACCEPTANCE_LINE.exec(trimmed)
    if (!match) throw new Error(`验收标准里有一行认不出来：「${trimmed}」`)
    items.push(match[1])
  }
  if (items.length === 0) throw new Error('验收标准里一条都没有')
  return items
}

function parsePlan(source) {
  if (source === null || source === undefined) return []

  const parts = []
  let current = null

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '# 计划') continue

    const heading = PART_HEADING.exec(trimmed)
    if (heading) {
      current = {
        id: heading[1],
        title: heading[2].trim(),
        dependsOn: [],
        files: [],
        evidence: '',
      }
      parts.push(current)
      continue
    }

    const field = PLAN_FIELD.exec(trimmed)
    if (field && current) {
      const value = field[2].trim()

      if (field[1] === '依赖') {
        if (value !== '无') current.dependsOn.push(value)
      } else if (field[1] === '证据') {
        if (current.evidence) throw new Error(`部分 ${current.id} 有多行「证据」`)
        current.evidence = value
      } else if (value !== '无') {
        current.files.push(normalizePath(value))
      }

      continue
    }

    throw new Error(`计划里有一行认不出来：「${trimmed}」`)
  }

  const problem = validatePlan(parts)
  if (problem) throw new Error(problem)

  return parts
}

function sectionBody(source, heading) {
  const marker = `## ${heading}`
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === marker)
  if (start < 0) return ''

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING_LINE.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}
