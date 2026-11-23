/**
 * 插件配置。
 *
 * 通用插件的底线：危险行为要能关、能收窄。这里只放需要用户决定的开关，
 * 其余保持零配置可用。
 */

export const SNAPSHOT_MODES = ['off', 'files', 'all']

/** 默认只提交这个部分声明的文件，不碰工作区里别的东西。 */
export const DEFAULT_SNAPSHOT_MODE = 'files'

export const DEFAULT_EVIDENCE_TYPES = ['test', 'build', 'command', 'artifact']

/**
 * 快照模式。
 *
 * - `off`   不提交
 * - `files` 只 `git add` 这个部分声明的文件（默认）
 * - `all`   `git add -A`，提交整个工作区
 *
 * 配置优先，其次环境变量 `DSH_MANAGER_SNAPSHOT`，都非法就退回默认值 ——
 * 写错配置不该让插件起不来。
 */
export function readSnapshotMode(config, env = process.env) {
  const raw = config?.snapshot ?? env?.DSH_MANAGER_SNAPSHOT
  const value = String(raw ?? '').trim().toLowerCase()
  return SNAPSHOT_MODES.includes(value) ? value : DEFAULT_SNAPSHOT_MODE
}

/** 证据类型：默认四种，配置里可以加。 */
export function readEvidenceTypes(config) {
  const extra = Array.isArray(config?.evidenceTypes) ? config.evidenceTypes : []
  const cleaned = extra
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0 && /^[a-zA-Z][\w-]*$/.test(item))

  return [...new Set([...DEFAULT_EVIDENCE_TYPES, ...cleaned])]
}
