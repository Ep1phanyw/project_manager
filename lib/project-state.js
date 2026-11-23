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
    if (/[\r\n]/.test(note)) {
      return { ok: false, problem: '理由不能包含换行：那会把审批记录写坏' }
    }
    if (kind === 'rejected' && !note) {
      return { ok: false, problem: '驳回要写清理由：没有理由的记录等于没留下任何信息' }
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

    const completed = new Set()
    const part = project.parts.find((candidate) =>
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

    const attempt = project.records.filter((record) => record.partId === part.id).length + 1
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
      const written = writeRecord(project, {
        partId: part.id,
        attempt,
        at,
        status: RECORD_STATUS.failed,
        summary: problem,
        evidence: [],
        sessionId: '',
        blockedReason: '',
      })
      if (written) return { ok: false, problem: written }
      return { ok: false, problem: `部分 ${part.id} 的子对话失败了：${problem}`, retryable: true }
    }

    const report = outcome.report
    const problem = checkReport(report)
    if (problem) {
      const written = writeRecord(project, {
        partId: part.id,
        attempt,
        at,
        status: RECORD_STATUS.invalid,
        summary: `回报不合规：${problem}`,
        evidence: [],
        sessionId: '',
        blockedReason: '',
      })
      if (written) return { ok: false, problem: written }
      return { ok: false, problem: `部分 ${part.id} 的回报不合规：${problem}`, retryable: true }
    }

    const written = writeRecord(project, {
      partId: part.id,
      attempt,
      at,
      status: trimmedText(report.status),
      summary: trimmedText(report.summary),
      evidence: listOf(report.evidence),
      sessionId: trimmedText(outcome.sessionId) || trimmedText(report.sessionId),
      blockedReason: trimmedText(report.blockedReason),
    })
    if (written) return { ok: false, problem: written }

    return { ok: true, part, attempt, report }
  }

  function writeRecord(project, record) {
    try {
      store.write(project.slug, { parts: renderRecords([...project.records, record]) })
      return ''
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
        approved: last?.kind === 'approved',
      },
    }
  }

  function stamp() {
    return new Date(now()).toISOString()
  }

  return { startProject, submitPlan, approvePlan, rejectPlan, nextPart, dispatchNext, status }
}

const REPORT_STATUSES = [
  RECORD_STATUS.done,
  RECORD_STATUS.needsUserVerification,
  RECORD_STATUS.blocked,
]

function checkReport(report) {
  if (!report || typeof report !== 'object') return '回报不是一个对象'

  const status = trimmedText(report.status)
  if (!REPORT_STATUSES.includes(status)) {
    return `回报里的状态「${status}」不认识；只接受 ${REPORT_STATUSES.join(' / ')}`
  }
  if (!trimmedText(report.summary)) return '回报缺摘要'
  if (status === RECORD_STATUS.done && listOf(report.evidence).length === 0) {
    return '判为完成却没有给证据：证据必须可复现'
  }
  if (status === RECORD_STATUS.blocked && !trimmedText(report.blockedReason)) {
    return '判为阻塞却没说清卡在哪：要说清需要用户提供什么'
  }
  return ''
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
    '3. 证据必须可复现：测试输出、构建结果、命令输出或产物。不要写「我确认过了」。',
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
