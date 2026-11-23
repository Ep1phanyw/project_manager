/**
 * 部分记录：每次派分子对话的结果都留一条，按部分分组。
 *
 * 关键约束：子对话给的文本（摘要、证据、阻塞原因）全部缩进写入，
 * 而结构行（## 标题、- 字段、### 小节）只在顶格时才被识别。
 * 所以子对话写不出合法结构行 —— 既写不坏文件，也伪造不了别的部分的记录。
 */

const RECORD_HEADING = /^## \[(P\d+)\] 第 (\d+) 次 · (\S+)$/
const RECORD_FIELD = /^- (状态|子会话)[：:](.*)$/

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
    if (record.summary) lines.push('', '### 摘要', '', indentBody(record.summary, '  '))

    if (record.evidence.length > 0) {
      lines.push('', '### 证据', '')
      for (const item of record.evidence) lines.push(indentItem(item))
    }

    if (record.blockedReason) {
      lines.push('', '### 阻塞原因', '', indentBody(record.blockedReason, '  '))
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

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue

    if (!line.startsWith(' ')) {
      section = handleStructural({ line, records, current, section })
      current = records[records.length - 1] ?? null
      continue
    }

    if (!current) throw new Error(`部分记录里有一行认不出来：「${line.trim()}」`)

    if (section === 'summary') {
      current.summary = appendLine(current.summary, line.slice(2))
      continue
    }

    if (section === 'blocked') {
      current.blockedReason = appendLine(current.blockedReason, line.slice(2))
      continue
    }

    if (section === 'evidence') {
      if (line.startsWith('  - ')) {
        current.evidence.push(line.slice(4))
        continue
      }
      if (line.startsWith('    ') && current.evidence.length > 0) {
        const index = current.evidence.length - 1
        current.evidence[index] = appendLine(current.evidence[index], line.slice(4))
        continue
      }
      throw new Error(`证据里有一行认不出来：「${line.trim()}」`)
    }

    throw new Error(`部分记录里有一行认不出来：「${line.trim()}」`)
  }

  for (const record of records) {
    if (!record.status) throw new Error(`部分 ${record.partId} 第 ${record.attempt} 次没有状态`)
  }

  return records
}

/** 顶格行只可能是结构行；返回新的小节状态。 */
function handleStructural({ line, records, current, section }) {
  if (line === '# 部分记录') return ''

  const heading = RECORD_HEADING.exec(line)
  if (heading) {
    records.push({
      partId: heading[1],
      attempt: Number(heading[2]),
      at: heading[3],
      status: '',
      sessionId: '',
      summary: '',
      evidence: [],
      blockedReason: '',
    })
    return ''
  }

  if (line === '### 摘要') return 'summary'
  if (line === '### 证据') return 'evidence'
  if (line === '### 阻塞原因') return 'blocked'

  if (!current) throw new Error(`部分记录里有一行认不出来：「${line}」`)

  const field = RECORD_FIELD.exec(line)
  if (!field) throw new Error(`部分记录里有一行认不出来：「${line}」`)

  if (field[1] === '状态') current.status = field[2].trim()
  else current.sessionId = field[2].trim()

  return section
}

function appendLine(text, line) {
  return text ? `${text}\n${line}` : line
}

function indentBody(text, prefix) {
  return text
    .split(/\r?\n/)
    .map((line) => (line ? prefix + line : ''))
    .join('\n')
}

function indentItem(item) {
  return item
    .split(/\r?\n/)
    .map((line, index) => {
      if (index === 0) return `  - ${line}`
      return line ? `    ${line}` : ''
    })
    .join('\n')
}
