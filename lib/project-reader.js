/**
 * 按显式工作区路径读项目状态 —— 不依赖会话，也不依赖 agent。
 *
 * `stateFor(agent)` 解析的是「当前会话的工作区」；项目面板要读的是用户选中的
 * 那个工作区，所以读取入口必须能拿一个绝对路径就工作。
 *
 * 只读路径只装配读状态用得上的三项：store、hasOrigin、contextFiles。
 * 派分、执行检查、写日志、快照都不接 —— 只读路径上误用到它们应当立刻报错，
 * 而不是悄悄跑出别的东西。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createProjectState } from './project-state.js'
import { createFsStore } from './store.js'
import { workspaceContext } from './workspace.js'

const SCRATCH_DIR = '.scratch'
const PROJECT_FILE = 'project.md'

/**
 * @param {object} options
 * @param {string} options.workspace 工作区绝对路径（`.scratch/` 的上一级）
 * @param {object} [options.store] 注入存储（测试用；默认读工作区下的 `.scratch/`）
 * @param {(slug: string) => string | null} [options.lastUpdated] 注入「最后更新时间」
 */
export function createProjectReader({ workspace, store = null, lastUpdated = null } = {}) {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new Error('createProjectReader: 缺少 workspace')
  }

  const root = workspace.trim()
  const stateStore = store ?? createFsStore(join(root, SCRATCH_DIR))
  const updatedAtOf = lastUpdated ?? ((slug) => fileUpdatedAt(root, slug))

  const state = createProjectState({
    store: stateStore,
    hasOrigin: () => true,
    contextFiles: () => workspaceContext(root),
  })

  /**
   * 该工作区下的全部项目，按最后更新时间倒序。
   * 单个项目读不出来只降级它自己：别的项目照常列出，坏掉的那项带原因。
   */
  function list() {
    if (!existsSync(root)) return { ok: false, problem: `工作区不存在：${root}` }

    let slugs
    try {
      slugs = stateStore.listProjects()
    } catch (error) {
      return { ok: false, problem: `读不了项目列表：${reasonOf(error)}` }
    }

    const projects = slugs.map((slug) => {
      const status = state.status(slug)
      if (!status.ok) return { ok: false, slug, problem: status.problem }

      return {
        ok: true,
        slug,
        name: status.project.name,
        phase: status.project.phase,
        updatedAt: updatedAtOf(slug),
      }
    })

    projects.sort(compareProjects)
    return { ok: true, projects }
  }

  /** 一个项目的完整解析状态。项目名与命令里用的是同一套校验。 */
  function read(name) {
    const wanted = typeof name === 'string' ? name.trim() : ''
    if (!wanted) return { ok: false, problem: '没有指定项目名' }
    if (!existsSync(root)) return { ok: false, problem: `工作区不存在：${root}` }

    const status = state.status(wanted)
    if (!status.ok) return status
    return { ok: true, project: status.project, updatedAt: updatedAtOf(status.project.slug) }
  }

  return { list, read }
}

/** 最近改过的排前面；读不到时间的排最后，同时间按名字排。 */
function compareProjects(left, right) {
  const a = left.updatedAt ?? ''
  const b = right.updatedAt ?? ''
  if (a !== b) return a < b ? 1 : -1
  return left.slug.localeCompare(right.slug)
}

/** `project.md` 是「项目存在」的标记，它的 mtime 就是最后一次写入的时间。 */
function fileUpdatedAt(root, slug) {
  try {
    return statSync(join(root, SCRATCH_DIR, slug, PROJECT_FILE)).mtime.toISOString()
  } catch {
    return null
  }
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}
