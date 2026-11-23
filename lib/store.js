import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 文件版状态存储：一个项目一个目录，目录里是普通 markdown。
 *
 * 这一层只做读写，不解释内容 —— 格式与校验都属于 Orchestrator 核心。
 */
export function createFsStore(root) {
  return {
    listProjects() {
      if (!existsSync(root)) return []
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((slug) => existsSync(join(root, slug, 'project.md')))
        .sort()
    },

    read(slug, file) {
      try {
        return readFileSync(join(root, slug, file), 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },

    write(slug, file, text) {
      const dir = join(root, slug)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, file), text, 'utf8')
    },
  }
}
