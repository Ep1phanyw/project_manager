/**
 * 调度：一次能派几个、派哪几个、同一个部分不派两次。
 *
 * 这里只做判断，不碰存储、不碰子对话、不碰 DSH —— 所以可以拿纯数据测。
 */

import { DEFAULT_PARALLEL_LIMIT, HARD_PARALLEL_LIMIT } from './config.js'
import { RECORD_STATUS } from './records.js'

/** 已经完成或不该再派的状态：完成、阻塞、等确认、在飞、中断。 */
const NOT_READY = new Set([
  RECORD_STATUS.done,
  RECORD_STATUS.blocked,
  RECORD_STATUS.needsUserVerification,
  RECORD_STATUS.running,
  'interrupted',
])

export function createScheduler({ maxParallel = DEFAULT_PARALLEL_LIMIT, capacity = null } = {}) {
  const inFlight = new Set()

  /** 一次最多几个：配置值与平台剩余名额取小，再夹在 1..硬顶 之间。 */
  function limit() {
    const configured = Math.min(
      Math.max(1, Number.isInteger(maxParallel) ? maxParallel : DEFAULT_PARALLEL_LIMIT),
      HARD_PARALLEL_LIMIT,
    )

    let left = HARD_PARALLEL_LIMIT
    if (typeof capacity === 'function') {
      try {
        const reported = capacity()
        if (reported && Number.isFinite(reported.limit)) {
          left = Math.max(0, reported.limit - (reported.running ?? 0))
        }
      } catch {
        left = HARD_PARALLEL_LIMIT
      }
    }

    return Math.max(0, Math.min(configured, left))
  }

  /** 占一个位子：已经在这个部分上了就返回 false —— 这是「不派两次」的那道闸。 */
  function begin(partId) {
    if (inFlight.has(partId)) return false
    inFlight.add(partId)
    return true
  }

  function end(partId) {
    inFlight.delete(partId)
  }

  function has(partId) {
    return inFlight.has(partId)
  }

  /**
   * 挑能同时开工的部分：依赖都过了、自身没完成、没在等验收、文件集与已选的不相交。
   * `overlaps(a, b)` 由调用方给，调度本身不认识路径规则。
   */
  function ready(
    parts,
    { verified, partStatus, overlaps = () => false, size = limit(), skipParts = new Set() } = {},
  ) {
    const selected = []
    const taken = []

    for (const part of parts ?? []) {
      if (selected.length >= size) break
      if (skipParts.has(part.id)) continue
      if (verified?.has(part.id)) continue
      if (!part.dependsOn.every((dependency) => verified?.has(dependency))) continue
      if (NOT_READY.has(partStatus?.[part.id])) continue

      const clashes = part.files.some((file) => taken.some((other) => overlaps(file, other)))
      if (clashes) continue

      selected.push(part)
      taken.push(...part.files)
    }

    return selected
  }

  return { limit, begin, end, has, ready }
}
