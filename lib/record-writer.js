/**
 * 部分记录的写入。
 *
 * 并发的派分各自持有一份旧快照，直接整份写回会把别人的记录盖掉。
 * 这里把所有**派分相关**的写入排成一条队，并且每次都先重读当前文件再改 ——
 * 这是「并发派分不互相覆盖」的唯一实现处。
 *
 * 例外（已知）：验收与改计划的那两次整份写入是同步动作，没走这条队。
 * 验收要求最新一条是候选完成，正常时序下不会与在飞的派分重叠；
 * 要彻底收口，得把那两处也改成异步排队，留作后续。
 */

import { parseRecords, renderRecords } from './records.js'

export function createRecordWriter({ store, reasonOf }) {
  let queue = Promise.resolve()

  /** 读当前记录、交给 mutate 改、再整份写回。整条链按调用顺序串行。 */
  function locked(slug, mutate) {
    const task = queue.then(async () => {
      let records
      try {
        records = parseRecords(store.read(slug)?.parts)
      } catch (error) {
        return { problem: `部分记录读不懂：${reasonOf(error)}` }
      }

      try {
        store.write(slug, { parts: renderRecords(mutate(records)) })
      } catch (error) {
        return { problem: `写不了部分记录：${reasonOf(error)}` }
      }

      return {}
    })

    queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  function append(slug, record) {
    return locked(slug, (records) => [...records, record])
  }

  /** 结果落盘时，这一轮的在飞记录就该消失了。 */
  function replaceInFlight(slug, partId, attempt, record) {
    return locked(slug, (records) => [
      ...records.filter(
        (item) =>
          !(item.partId === partId && item.attempt === attempt && item.status === 'running'),
      ),
      record,
    ])
  }

  return { locked, append, replaceInFlight }
}
