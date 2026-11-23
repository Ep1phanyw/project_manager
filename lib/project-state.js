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

  function status(requested) {
    const wanted = trimmedText(requested)

    if (wanted) {
      const problem = checkName(wanted)
      if (problem) return { ok: false, problem }
      return readProject(slugOf(wanted))
    }

    let slugs
    try {
      slugs = store.listProjects()
    } catch (error) {
      return { ok: false, problem: `读不了项目列表：${reasonOf(error)}` }
    }

    if (slugs.length === 0) {
      return { ok: false, problem: '还没有项目；先让主对话启动一个项目' }
    }
    if (slugs.length > 1) {
      return {
        ok: false,
        problem: `有多个项目：${slugs.join('、')} —— 请指定一个（/manager <项目名>）`,
      }
    }
    return readProject(slugs[0])
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
      return { ok: true, project: { slug, name, phase, goal, acceptance } }
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }
  }

  return { startProject, status }
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

function renderProject({ name, goal }) {
  return ['# ' + name, '', '阶段：planning', '', '## 目标', '', goal, ''].join('\n')
}

function renderAcceptance(items) {
  const lines = items.map((item, index) => `- [AC-${index + 1}] ${item}`)
  return ['# 验收标准', '', ...lines, ''].join('\n')
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
  if (source === null) throw new Error('缺少验收标准文件')

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
