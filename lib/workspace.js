/**
 * 看一眼工作区：是不是已经有人做了一半？
 *
 * 只做很保守的判断 —— 顶层的可见条目、以及几个常见的上下文文件是否存在。
 * 宁可在空仓库上多问一句，也不要在半成品上假装从零开始。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const IGNORED = new Set([
  '.git',
  '.scratch',
  '.github',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.DS_Store',
  'Thumbs.db',
])

/** 开工前值得先读的东西。 */
const CONTEXT_CANDIDATES = [
  'README.md',
  'GLOSSARY.md',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/adr',
  'docs/agents',
  'docs/state-files.md',
  'package.json',
]

function visibleEntries(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !IGNORED.has(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 工作区里除了版本库与状态目录之外，还有没有东西。 */
export function surveyWorkspace(root) {
  const names = visibleEntries(root)
  return { hasWork: names.length > 0, top: names.slice(0, 12) }
}

/** 实际存在的上下文文件（相对路径）。 */
export function workspaceContext(root) {
  return CONTEXT_CANDIDATES.filter((relative) => existsSync(join(root, relative)))
}
