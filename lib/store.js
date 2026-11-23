import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_FILE = 'project.md'
const ACCEPTANCE_FILE = 'acceptance.md'
const PLAN_FILE = 'plan.md'
const PARTS_FILE = 'parts.md'
const ACCEPTANCE_RUN_FILE = 'acceptance-run.md'

/**
 * 文件版状态存储：一个项目一个目录，目录里是普通 markdown。
 *
 * 只负责「哪个项目、哪个文件、写什么字」，怎么解释内容归 ProjectState。
 * 写入时 project.md 永远最后落 —— 它是「项目存在」的标记，
 * 所以半途失败不会留下一个能被列出却读不完的项目。
 */
export function createFsStore(root) {
  return {
    listProjects() {
      if (!existsSync(root)) return []

      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((slug) => existsSync(join(root, slug, PROJECT_FILE)))
        .sort()
    },

    read(slug) {
      const project = readOrNull(join(root, slug, PROJECT_FILE))
      if (project === null) return null

      return {
        project,
        acceptance: readOrNull(join(root, slug, ACCEPTANCE_FILE)),
        plan: readOrNull(join(root, slug, PLAN_FILE)),
        parts: readOrNull(join(root, slug, PARTS_FILE)),
        acceptanceRun: readOrNull(join(root, slug, ACCEPTANCE_RUN_FILE)),
      }
    },

    write(slug, documents) {
      const dir = join(root, slug)
      mkdirSync(dir, { recursive: true })

      if (documents.parts !== undefined) {
        writeFileSync(join(dir, PARTS_FILE), documents.parts, 'utf8')
      }
      if (documents.plan !== undefined) {
        writeFileSync(join(dir, PLAN_FILE), documents.plan, 'utf8')
      }
      if (documents.acceptanceRun !== undefined) {
        writeFileSync(join(dir, ACCEPTANCE_RUN_FILE), documents.acceptanceRun, 'utf8')
      }
      if (documents.acceptance !== undefined) {
        writeFileSync(join(dir, ACCEPTANCE_FILE), documents.acceptance, 'utf8')
      }
      if (documents.project !== undefined) {
        writeFileSync(join(dir, PROJECT_FILE), documents.project, 'utf8')
      }
    },
  }
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
