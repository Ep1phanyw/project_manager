/**
 * 部分记录：每次派分子对话的结果都留一条，按部分分组。
 *
 * 格式与其他状态文件一样是普通 markdown，解析严格 —— 认不出的行会报错，
 * 不会静默丢掉一条记录。
 */

const RECORD_HEADING = /^## \[(P\d+)\] 第 (\d+) 次 · (\S+)$/
const RECORD_FIELD = /^- (状态|子会话|阻塞原因)[：:](.*)$/

export const RECORD_STATUS = {
  done: 'done',
  needsUserVerification: 'needs-user-verification',
  blocked: 'blocked',
  failed: 'failed',
  invalid: 'invalid',
}

export function renderRecords(records) {
  if (records.length === 0) return '# 部分记录\n'

  const blocks = records.map((record) => {
    const lines = [
      `## [${record.partId}] 第 ${record.attempt} 次 · ${record.at}`,
      '',
      `- 状态：${record.status}`,
    ]

    if (record.sessionId) lines.push(`- 子会话：${record.sessionId}`)
    if (record.blockedReason) lines.push(`- 阻塞原因：${record.blockedReason}`)

    if (record.summary) {
      lines.push('', '### 摘要', '', record.summary)
    }

    if (record.evidence.length > 0) {
      lines.push('', '### 证据', '')
      for (const item of record.evidence) lines.push(`- ${item}`)
    }

    return lines.join('\n')
  })

  return ['# 部分记录', '', blocks.join('\n\n'), ''].join('\n')
}

export function parseRecords(source) {
  if (source === null || source === undefined) return []

  const records = []
  let current = null
  let section = ''

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line === '# 部分记录') continue

    const heading = RECORD_HEADING.exec(line)
    if (heading) {
      current = {
        partId: heading[1],
        attempt: Number(heading[2]),
        at: heading[3],
        status: '',
        sessionId: '',
        summary: '',
        evidence: [],
        blockedReason: '',
      }
      records.push(current)
      section = ''
      continue
    }

    if (line === '### 摘要') {
      section = 'summary'
      continue
    }
    if (line === '### 证据') {
      section = 'evidence'
      continue
    }

    if (!current) throw new Error(`部分记录里有一行认不出来：「${line}」`)

    if (section === 'summary') {
      current.summary = current.summary ? `${current.summary}\n${line}` : line
      continue
    }

    if (section === 'evidence') {
      const item = /^- (.*)$/.exec(line)
      if (!item) throw new Error(`证据里有一行认不出来：「${line}」`)
      current.evidence.push(item[1].trim())
      continue
    }

    const field = RECORD_FIELD.exec(line)
    if (!field) throw new Error(`部分记录里有一行认不出来：「${line}」`)

    const value = field[2].trim()
    if (field[1] === '状态') current.status = value
    else if (field[1] === '子会话') current.sessionId = value
    else current.blockedReason = value
  }

  for (const record of records) {
    if (!record.status) throw new Error(`部分 ${record.partId} 第 ${record.attempt} 次没有状态`)
  }

  return records
}
