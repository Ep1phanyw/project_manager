/**
 * ProjectState —— 本插件唯一的行为接缝：项目的状态机与校验器。
 *
 * 它不碰 DSH，也不知道文件怎么存：状态怎么读写由注入的 store 决定。
 * 以后的时间、子对话、问用户，同样各自注入。
 */

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const HEADING_LINE = /^\s*#{1,6}\s/
const PHASE_LINE = /^\s*阶段[：:]/
const ACCEPTANCE_LINE = /^- \[AC-\d+\] (.*)$/
const PART_HEADING = /^## \[(P\d+)\] (.+)$/
const PLAN_FIELD = /^- (依赖|证据|文件)[：:](.*)$/
const PART_ID = /^P\d+$/

/** 只认可复现的证据类型；「我确认过了」不在其中。 */
export const EVIDENCE_TYPES = ['test', 'build', 'command', 'artifact']

export function createProjectState({ store, now = () => Date.now() }) {
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
        project: renderProject({ name, goal, phase: 'planning', approvals: [] }),
        acceptance: renderAcceptance(acceptance),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, slug }
  }

  function submitPlan(input) {
    const resolved = resolveProject(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const loaded = loadProject(resolved.slug)
    if (loaded.problem) return { ok: false, problem: loaded.problem }

    const parts = normalizeParts(input?.parts)
    const problem = validatePlan(parts)
    if (problem) return { ok: false, problem }

    if (loaded.phase === 'executing') {
      return { ok: false, problem: '计划已经批准，不能直接覆盖；先用 /manager reject 驳回' }
    }

    try {
      store.write(resolved.slug, {
        plan: renderPlan(parts),
        project: renderProject({ ...loaded, phase: 'awaiting-approval' }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了计划：${reasonOf(error)}` }
    }

    return { ok: true, count: parts.length }
  }

  /** 批准与驳回只认 user —— 模型没有通往这里的工具，这一层是第二道锁。 */
  function approvePlan(input) {
    return decidePlan(input, 'approved')
  }

  function rejectPlan(input) {
    return decidePlan(input, 'rejected')
  }

  function decidePlan(input, kind) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能批准或驳回计划' }
    }

    const resolved = resolveProject(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const loaded = loadProject(resolved.slug)
    if (loaded.problem) return { ok: false, problem: loaded.problem }
    if (loaded.plan === null) return { ok: false, problem: '还没有计划；先提交一份计划' }

    if (kind === 'approved') {
      if (loaded.phase === 'executing') return { ok: false, problem: '计划已经批准过了' }
      if (loaded.phase !== 'awaiting-approval') {
        return { ok: false, problem: '计划还没到待批准；先重新提交一份计划' }
      }
    } else if (loaded.phase !== 'awaiting-approval') {
      return { ok: false, problem: '现在没有待批准的计划可以驳回' }
    }

    const approvals = [
      ...loaded.approvals,
      {
        at: new Date(now()).toISOString(),
        kind,
        note: trimmedText(input?.reason),
      },
    ]
    const phase = kind === 'approved' ? 'executing' : 'planning'

    try {
      store.write(resolved.slug, { project: renderProject({ ...loaded, phase, approvals }) })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true }
  }

  function nextPart(input) {
    const resolved = resolveProject(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const loaded = loadProject(resolved.slug)
    if (loaded.problem) return { ok: false, problem: loaded.problem }

    let parts
    try {
      parts = parsePlan(loaded.plan)
    } catch (error) {
      return { ok: false, problem: `计划读不出来：${reasonOf(error)}` }
    }

    if (parts.length === 0) return { ok: false, problem: '还没有计划；先提交一份计划' }
    if (loaded.phase !== 'executing') {
      return { ok: false, problem: '计划还没批准；先用 /manager approve 批准' }
    }

    const part = parts.find((candidate) =>
      candidate.dependsOn.every((dependency) => loaded.completed.includes(dependency)),
    )
    if (!part) return { ok: false, problem: '没有可派分的部分：剩下的都被未完成的部分挡着' }

    return { ok: true, part }
  }

  function loadProject(slug) {
    let raw
    try {
      raw = store.read(slug)
    } catch (error) {
      return { problem: `项目「${slug}」的状态读不出来：${reasonOf(error)}` }
    }
    if (raw === null) return { problem: `找不到项目「${slug}」` }

    try {
      return { ...parseProject(raw.project), plan: raw.plan ?? null, completed: [] }
    } catch (error) {
      return { problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }
  }

  function status(requested) {
    const resolved = resolveProject(requested)
    if (resolved.problem) return { ok: false, problem: resolved.problem }
    return readProject(resolved.slug)
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
      return { problem: `有多个项目：${slugs.join('、')} —— 请指定一个（/manager <项目名>）` }
    }
    return { slug: slugs[0] }
  }

  function readProject(slug) {
    let raw
    try {
      raw = store.read(slug)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态读不出来：${reasonOf(error)}` }
    }
    if (raw === null) return { ok: false, problem: `找不到项目「${slug}」` }

    try {
      const { name, phase, goal, approvals } = parseProject(raw.project)
      const acceptance = parseAcceptance(raw.acceptance)

      // 计划读不出来时只降级计划本身：目标与验收标准仍然要看得见，
      // 否则用户手改坏一行 plan.md，整个项目就变成一团黑。
      let parts = []
      let planProblem = ''
      try {
        parts = parsePlan(raw.plan)
      } catch (error) {
        planProblem = reasonOf(error)
      }

      return {
        ok: true,
        project: { slug, name, phase, goal, acceptance, approvals, parts, planProblem },
      }
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }
  }

  return { startProject, submitPlan, approvePlan, rejectPlan, nextPart, status }
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

  if (approvals && approvals.length > 0) {
    lines.push('', '## 审批', '')
    for (const record of approvals) {
      const label = record.kind === 'approved' ? '批准' : '驳回'
      const note = record.kind === 'rejected' && record.note ? `：${record.note}` : ''
      lines.push(`- ${record.at} ${label}${note}`)
    }
  }

  return [...lines, ''].join('\n')
}

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

  return { name: nameMatch[1].trim(), phase: phaseMatch[1], goal, approvals: parseApprovals(source) }
}

function parseApprovals(source) {
  const body = sectionBody(source, '审批')
  if (!body) return []

  const records = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = /^- (\S+) (批准|驳回)(?:[：:](.*))?$/.exec(trimmed)
    if (!match) throw new Error(`审批记录里有一行认不出来：「${trimmed}」`)

    records.push({
      at: match[1],
      kind: match[2] === '批准' ? 'approved' : 'rejected',
      note: (match[3] ?? '').trim(),
    })
  }

  return records
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
