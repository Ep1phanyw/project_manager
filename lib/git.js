/**
 * 越界改动检查：这一部分实际动了哪些文件，有没有超出它声明的文件集。
 *
 * 做法是让 git 把 diff 写进临时文件再读，而不是抓子进程的 stdout ——
 * 本沙箱不允许抓管道（会 EPERM）。
 *
 * 只覆盖已跟踪文件（`git diff HEAD`）。新加的文件不算 —— 那通常是这一部分
 * 自己的产出；真正要防的是「悄悄改/删了别人负责的东西」，那都是已跟踪的。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATUS_LABEL = { A: '新增', M: '改动', D: '删除', R: '重命名', C: '复制', T: '改类型' }

/** 工作区里相对 HEAD 的变更清单；不是 git 仓库或出错时返回 null。 */
export function changedSinceHead(workspace) {
  if (!existsSync(join(workspace, '.git'))) return null

  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-diff-'))
    const out = join(dir, 'diff.txt')

    execFileSync(
      'git',
      ['-C', workspace, 'diff', '--name-status', `--output=${out}`, 'HEAD'],
      { stdio: 'ignore' },
    )

    if (!existsSync(out)) return []

    return readFileSync(out, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [code, ...rest] = line.split('\t')
        return {
          status: STATUS_LABEL[code?.[0]] ?? code,
          path: rest[rest.length - 1],
        }
      })
  } catch {
    return null
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** 这个路径算不算被声明的文件集覆盖到（文件本身或它的上级目录）。 */
function covered(path, declared) {
  return declared.some((entry) => {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '')
    return path === normalized || path.startsWith(`${normalized}/`)
  })
}

/**
 * 超出声明文件集的改动。返回 `null` 表示查不了（不是仓库/没有 git），
 * 返回空数组表示查过且没有越界。
 */
export function strayChanges(workspace, declaredFiles) {
  const changes = changedSinceHead(workspace)
  if (changes === null) return null

  return changes
    .filter((change) => !covered(change.path, declaredFiles))
    .map((change) => `${change.path}（${change.status}）`)
}
