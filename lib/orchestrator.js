/**
 * Orchestrator 核心 —— 本插件唯一的行为接缝。
 *
 * 它不碰 DSH：状态怎么存由注入的 store 决定，时间、子对话、问用户
 * 都在后续部分各自注入。测试从这一层驱动，外部能力全部是假件。
 */

const PROJECT_FILE = 'project.md'
const ACCEPTANCE_FILE = 'acceptance.md'

/** 阶段用稳定的机器 token 落在文件里，中文只在给人看的输出里出现。 */
const PHASE_LABELS = {
  planning: '规划',
  'awaiting-approval': '待批准',
  executing: '执行',
  'awaiting-user': '待确认',
  blocked: '阻塞',
  done: '完成',
}

const SLUG_UNSAFE = /[\\/\u0000-\u001f]/

export function createOrchestrator({ store }) {
  function startProject(input) {
    const name = text(input?.name)
    const goal = text(input?.goal)
    const acceptance = listOf(input?.acceptance)

    if (!name) return { ok: false, problem: '项目名不能为空' }
    if (!goal) return { ok: false, problem: '目标不能为空' }
    if (acceptance.length === 0) return { ok: false, problem: '至少要有一条验收标准' }

    const slug = slugOf(name)
    if (SLUG_UNSAFE.test(slug) || slug === '.' || slug === '..') {
      return { ok: false, problem: `项目名不能当目录名用：「${name}」` }
    }
    if (store.read(slug, PROJECT_FILE) !== null) {
      return { ok: false, problem: `项目「${slug}」已存在` }
    }

    store.write(slug, PROJECT_FILE, renderProject({ name, goal }))
    store.write(slug, ACCEPTANCE_FILE, renderAcceptance(acceptance))

    return { ok: true, slug }
  }

  function status(slug) {
    const explicit = text(slug)
    if (explicit) return readProject(explicit)

    const slugs = store.listProjects()
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
    const projectText = store.read(slug, PROJECT_FILE)
    if (projectText === null) return { ok: false, problem: `找不到项目「${slug}」` }

    try {
      const { name, phase, goal } = parseProject(projectText)
      const acceptance = parseAcceptance(store.read(slug, ACCEPTANCE_FILE) ?? '')
      if (acceptance.length === 0) {
        return { ok: false, problem: `项目「${slug}」的验收标准是空的` }
      }
      return { ok: true, project: { slug, name, phase, goal, acceptance } }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reason}` }
    }
  }

  return { startProject, status }
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

  return [
    `项目：${project.name}`,
    `阶段：${phase}`,
    '',
    '目标：',
    goal,
    '',
    '验收标准：',
    acceptance,
  ].join('\n')
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(value) {
  if (!Array.isArray(value)) return []
  return value.map(text).filter(Boolean)
}

function slugOf(name) {
  return name.replace(/\s+/g, '-')
}

function renderProject({ name, goal }) {
  return ['# ' + name, '', '阶段：planning', '', '## 目标', '', goal, ''].join('\n')
}

function renderAcceptance(items) {
  const lines = items.map((item, index) => `${index + 1}. ${item}`)
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
  const items = []
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+(.+?)\s*$/.exec(line)
    if (match) items.push(match[1])
  }
  return items
}

function sectionBody(source, heading) {
  const marker = `## ${heading}`
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === marker)
  if (start < 0) return ''

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}
