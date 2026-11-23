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

/** 只认可复现的证据类型；「我确认过了」不在其中。 */
const EVIDENCE_TYPES = ['test', 'build', 'command', 'artifact']

export function createProjectState({ store }) {
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
        project: renderProject({ name, goal }),
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

    const parts = normalizeParts(input?.parts)
    const problem = validatePlan(parts)
    if (problem) return { ok: false, problem }

    try {
      if (store.read(resolved.slug) === null) {
        return { ok: false, problem: `找不到项目「${resolved.slug}」` }
      }
      store.write(resolved.slug, { plan: renderPlan(parts) })
    } catch (error) {
      return { ok: false, problem: `写不了计划：${reasonOf(error)}` }
    }

    return { ok: true, count: parts.length }
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

    if (slugs.length === 0) return { problem: '还没有项目；先启动一个项目' }
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
      const { name, phase, goal } = parseProject(raw.project)
      const acceptance = parseAcceptance(raw.acceptance)
      const parts = parsePlan(raw.plan)
      return { ok: true, project: { slug, name, phase, goal, acceptance, parts } }
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }
  }

  return { startProject, submitPlan, status }
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
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function splitList(value) {
  return value
    .split(/[、,;]/)
    .map((item) => item.trim())
    .filter(Boolean)
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
    if (!/^P\d+$/.test(part.id)) return `部分的编号「${part.id}」不合法，应形如 P1`
    if (ids.has(part.id)) return `部分编号重复：${part.id}`
    ids.add(part.id)
  }

  for (const part of parts) {
    if (!part.title) return `部分 ${part.id} 缺少标题`
    if (part.files.length === 0) return `部分 ${part.id} 没有声明涉及的文件`
    if (!EVIDENCE_TYPES.includes(part.evidence)) {
      return `部分 ${part.id} 的证据类型「${part.evidence}」不认识；只接受 ${EVIDENCE_TYPES.join(' / ')}`
    }
  }

  for (const part of parts) {
    for (const dependency of part.dependsOn) {
      if (!ids.has(dependency)) return `部分 ${part.id} 依赖了不存在的部分 ${dependency}`
    }
  }

  const cycle = findCycle(parts)
  if (cycle) return `依赖成环：${cycle.join(' → ')}`

  const ancestors = new Map(parts.map((part) => [part.id, ancestorsOf(parts, part.id)]))

  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const a = parts[left]
      const b = parts[right]
      const shared = a.files.find((file) => b.files.includes(file))
      if (!shared) continue

      const ordered =
        ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id)
      if (!ordered) {
        return `部分 ${a.id} 与 ${b.id} 都改 ${shared}，却没有先后关系（${a.id} → ${b.id} 或 ${b.id} → ${a.id}）`
      }
    }
  }

  return ''
}

function findCycle(parts) {
  const byId = new Map(parts.map((part) => [part.id, part]))
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

function ancestorsOf(parts, id) {
  const byId = new Map(parts.map((part) => [part.id, part]))
  const seen = new Set()
  const stack = [...(byId.get(id)?.dependsOn ?? [])]

  while (stack.length > 0) {
    const next = stack.pop()
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...(byId.get(next)?.dependsOn ?? []))
  }

  return seen
}

function renderProject({ name, goal }) {
  return ['# ' + name, '', '阶段：planning', '', '## 目标', '', goal, ''].join('\n')
}

function renderAcceptance(items) {
  const lines = items.map((item, index) => `- [AC-${index + 1}] ${item}`)
  return ['# 验收标准', '', ...lines, ''].join('\n')
}

function renderPlan(parts) {
  const blocks = parts.map((part) =>
    [
      `## [${part.id}] ${part.title}`,
      '',
      `- 依赖：${part.dependsOn.length > 0 ? part.dependsOn.join('、') : '无'}`,
      `- 证据：${part.evidence}`,
      `- 文件：${part.files.length > 0 ? part.files.join('、') : '无'}`,
    ].join('\n'),
  )

  return ['# 计划', '', blocks.join('\n\n'), ''].join('\n')
}

function parseProject(source) {
  const nameMatch = /^#[ \t]+(.+)$/m.exec(source)
  if (!nameMatch) throw new Error('缺少标题行「# 项目名」')

  const phaseMatch = /^阶段[：:][ \t]*(\S+)[ \t]*$/m.exec(source)
  if (!phaseMatch) throw new Error('缺少「阶段：」行')

  const goal = sectionBody(source, '目标')
  if (!goal) throw new Error('缺少「## 目标」段')

  return { name: nameMatch[1].trim(), phase: phaseMatch[1], goal }
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
      if (field[1] === '依赖') current.dependsOn = value === '无' ? [] : splitList(value)
      else if (field[1] === '证据') current.evidence = value
      else current.files = value === '无' ? [] : splitList(value).map(normalizePath)
      continue
    }

    throw new Error(`计划里有一行认不出来：「${trimmed}」`)
  }

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
