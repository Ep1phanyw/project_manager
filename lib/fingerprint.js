/**
 * 契约文件的指纹。
 *
 * 给一个路径，返回内容指纹；文件按内容算，目录按「下面所有文件的相对路径 + 内容」
 * 排序后算 —— 这样加一个文件、删一个文件、改一行内容，指纹都会变。
 * 路径越界、读不到，一律返回 null：调用方会把「没有指纹」当成证据不可信。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const DIGEST_LENGTH = 16

export function createFingerprinter(workspace) {
  const root = resolve(workspace)

  return (path) => {
    const absolute = resolve(root, path)
    if (absolute !== root && !absolute.startsWith(root + sep)) return null

    try {
      return statSync(absolute).isDirectory()
        ? hashDirectory(root, absolute)
        : hashFile(absolute)
    } catch {
      return null
    }
  }
}

function hashFile(absolute) {
  return createHash('sha256').update(readFileSync(absolute)).digest('hex').slice(0, DIGEST_LENGTH)
}

/** 目录：按相对路径排序后，把「路径 + 内容」依次喂进去。 */
function hashDirectory(root, absolute) {
  const files = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const next = join(dir, entry.name)
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile()) files.push(next)
    }
  }

  walk(absolute)
  files.sort()

  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file.slice(root.length + 1).split(sep).join('/'))
    digest.update('\u0000')
    digest.update(readFileSync(file))
    digest.update('\u0000')
  }

  return digest.digest('hex').slice(0, DIGEST_LENGTH)
}
