import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_FILE = 'project.md'
const ACCEPTANCE_FILE = 'acceptance.md'

/**
 * 文件版状态存储：一个项目一个目录，目录里是普通 markdown。
 *
 * 只负责「哪个项目、哪个文件、写什么字」，怎么解释内容归 ProjectState。
 * 写入时先落验收标准、最后落 project.md —— 后者是「项目存在」的标记，
 * 所以第二次写失败不会留下一个能被列出却读不完的项目。
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
      }
    },

    write(slug, { project, acceptance }) {
      const dir = join(root, slug)
      mkdirSync(dir, { recursive: true })

      writeFileSync(join(dir, ACCEPTANCE_FILE), acceptance, 'utf8')
      writeFileSync(join(dir, PROJECT_FILE), project, 'utf8')
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
