/**
 * 跑一条核对命令，把输出写进文件再读回来。
 *
 * 为什么不用管道：这个沙箱不允许抓子进程的 stdout（会 EPERM）。
 * 把 stdout/stderr 都指到一个已经打开的文件句柄上，就绕开了管道。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 输出留多长：够看清失败原因，又不会把状态文件撑爆。 */
const MAX_OUTPUT = 4000
const TAIL_LINES = 20

export function runCommandCapture(command, options = {}) {
  const cwd = options.cwd
  const timeout = options.timeoutMs ?? 120000

  let dir = null
  let fd = null

  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-run-'))
    const out = join(dir, 'out.txt')
    fd = openSync(out, 'w')

    const result = spawnSync(command, {
      cwd,
      shell: true,
      stdio: ['ignore', fd, fd],
      timeout,
    })

    closeSync(fd)
    fd = null

    const raw = existsSync(out) ? readFileSync(out, 'utf8') : ''
    const output = raw.length > MAX_OUTPUT ? raw.slice(-MAX_OUTPUT) : raw

    if (result.error) {
      return { ok: false, code: -1, output: `${output}\n${result.error.message}`.trim() }
    }

    return { ok: result.status === 0, code: result.status ?? -1, output: output.trim() }
  } catch (error) {
    return { ok: false, code: -1, output: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 已经关了就算了
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** 输出只留最后几行，写进记录时用。 */
export function tail(output, lines = TAIL_LINES) {
  const all = String(output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)

  return all.slice(-lines)
}
