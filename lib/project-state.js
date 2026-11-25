/**
 * ProjectState —— 本插件唯一的行为接缝：项目的状态机与校验器。
 *
 * 它不碰 DSH，也不知道文件怎么存：状态怎么读写由注入的 store 决定，
 * 跑子对话由注入的 runChild 决定。测试里两者都是假件。
 */

import { createHash } from 'node:crypto'

import { tail } from './exec.js'
import { createScheduler } from './scheduler.js'
import { createMigration } from './migrate.js'
import { createChecks } from './checks.js'
import { createRecordWriter } from './record-writer.js'

import {
  RECORD_STATUS,
  STATUS_LABELS,
  isVerdictStatus,
  parseRecords,
  renderRecords,
} from './records.js'

const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const HEADING_LINE = /^\s*#{1,6}\s/
const PHASE_LINE = /^\s*阶段[：:]/
const ACCEPTANCE_HEADING = /^## \[(AC-\d+)\][ \t]*(.*)$/
const ACCEPTANCE_FIELD = /^- (检查|期望退出码|输出匹配|允许空输出|内容匹配)[：:][ \t]*(.*)$/
const AC_ID = /^AC-\d+$/
const ACCEPTANCE_ID_LINE = /^- (AC-\d+) (在|退役)$/
const LEGACY_ACCEPTANCE_LINE = /^- \[AC-(\d+)\] (.*)$/
const PART_HEADING = /^## \[(P\d+)\] (.+)$/
const PLAN_FIELD = /^- (依赖|证据|覆盖|文件|来源)[：:](.*)$/
const APPROVAL_LINE = /^- (\S+) (批准|驳回|更新|验收标准改过|契约指纹更新|放弃)(?:[：:](.*))?$/
const PART_ID = /^P\d+$/

/** 状态文件的格式版本：读到的比这旧，就只能看、不能动，等显式迁移。 */
const FORMAT_VERSION = 2

/** 只认可复现的证据类型；「我确认过了」不在其中。 */
export const EVIDENCE_TYPES = ['test', 'build', 'command', 'artifact']

/** 阶段是状态机的基础，写死在文件里，但闸门不单靠这一行。 */
const PHASE = {
  planning: 'planning',
  awaitingApproval: 'awaiting-approval',
  executing: 'executing',
  acceptance: 'acceptance',
  abandoned: 'abandoned',
}

/** 收尾验收的记录挂在什么编号下 —— 它不是计划里的部分。 */
const ACCEPTANCE_ID = 'AC'

export function createProjectState({
  store,
  now = () => Date.now(),
  commandName = 'manager',
  runChild,
  hasOrigin = () => true,
  contextFiles = () => [],
  snapshot = null,
  evidenceTypes = EVIDENCE_TYPES,
  strayCheck = null,
  runVerify = null,
  runCommand = null,
  readFile = null,
  processId = String(process.pid),
  maxParallel = undefined,
  capacity = null,
  fileHash = null,
  writeLog = null,
  preRun = true,
}) {
  // 注入项在入口处就检查：漏传时直接在这里说清楚，而不是等到某个分支里炸。
  if (!store) throw new Error('createProjectState: 缺少 store')
  if (typeof now !== 'function') throw new Error('createProjectState: now 必须是函数')
  if (typeof hasOrigin !== 'function') throw new Error('createProjectState: hasOrigin 必须是函数')
  if (typeof contextFiles !== 'function') {
    throw new Error('createProjectState: contextFiles 必须是函数')
  }

  // 调度的三件事（上限、可派部分、在飞占位）都在这里，不进状态机。
  const scheduler = createScheduler({ maxParallel, capacity })

  // 检查怎么跑、怎么判，归 checks.js；这里只把执行器交出去。
  const checkRunner = createChecks({ runCommand, readFile })

  // 记录写入要串行、且写前重读 —— 并发的事归 record-writer.js。
  const recordWriter = createRecordWriter({ store, reasonOf })

  // 迁移自己一套流程：解析、备份、改写。它不知道状态机，依赖都从这儿注进去。
  const migration = createMigration({
    store,
    schema: {
      parseProject,
      parseLegacyAcceptance,
      parsePlan,
      renderAcceptance,
      renderPlan,
      renderProject,
      sortById,
    },
    formatVersion: FORMAT_VERSION,
    phases: { planning: PHASE.planning, awaitingApproval: PHASE.awaitingApproval },
    evidenceTypes,
    stamp,
    resolve: resolveProject,
    reasonOf,
  })

  function startProject(input) {
    const name = trimmedText(input?.name)
    const goal = trimmedText(input?.goal)
    const acceptance = normalizeAcceptance(input?.acceptance)
    const verify = trimmedText(input?.verify)
    const contract = normalizeContract(input?.protectedFiles)

    const problem =
      checkName(name) ||
      checkGoal(goal) ||
      checkAcceptance(acceptance) ||
      checkVerify(verify) ||
      checkContract(contract)
    if (problem) return { ok: false, problem }

    const slug = slugOf(name)
    try {
      if (store.read(slug) !== null) return { ok: false, problem: `项目「${slug}」已存在` }
      store.write(slug, {
        project: renderProject({
          name,
          goal,
          phase: PHASE.planning,
          approvals: [],
          verify,
          // 编号即身份：从现在起，这些标准编号只会被标记退役，不会被复用。
          acceptanceIds: acceptance.map((item) => ({ id: item.id, retired: false })),
          // 契约文件的指纹在批准时才算；现在只登记「哪些文件是验收依据」。
          contract: contract.map((path) => ({ path, hash: '' })),
        }),
        acceptance: renderAcceptance(acceptance),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, slug }
  }

  /**
   * 提交计划。已批准的计划可以被改 —— 但那一次改动会记进审批历史，
   * 并把项目退回待批准，所以「改过之后没人再看一眼就继续跑」不会发生。
   */
  function submitPlan(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }

    const parts = normalizeParts(input?.parts)
    const problem = validatePlan({
      parts,
      hasOrigin,
      slug: project.slug,
      evidenceTypes,
      acceptance: project.acceptance,
      contract: project.contract,
    })
    if (problem) return { ok: false, problem }

    // 只在「新计划里还在」的部分上拦：删掉一个阻塞的部分是允许的，
    // 否则阻塞会把整份计划锁死，连拆错的部分都删不掉。
    const keptIds = new Set(parts.map((part) => part.id))
    for (const candidate of project.parts) {
      if (!keptIds.has(candidate.id)) continue

      const latest = latestFor(project.records, candidate.id)
      if (latest?.status === RECORD_STATUS.blocked) {
        return {
          ok: false,
          problem: `部分 ${candidate.id} 还处于阻塞：先处理阻塞报告，改计划不能替用户裁决`,
        }
      }
      if (latest?.status === RECORD_STATUS.needsUserVerification) {
        return {
          ok: false,
          problem: `部分 ${candidate.id} 在等你确认：先确认或打回，改计划不能跳过它`,
        }
      }
    }

    // 增量改计划：定义没动的部分保留它的记录，否则加一个部分就要
    // 把前面几十个已验收的重新验一遍。
    const previous = new Map(project.parts.map((part) => [part.id, part]))
    const unchanged = parts.filter((part) => {
      const before = previous.get(part.id)
      return before !== undefined && fingerprint(before) === fingerprint(part)
    })
    const unchangedIds = new Set(unchanged.map((part) => part.id))
    const kept = project.records.filter((record) => unchangedIds.has(record.partId))

    const revised =
      project.phase === PHASE.executing || project.phase === PHASE.acceptance
    const approvals = revised
      ? [...project.approvals, { at: stamp(), kind: 'revised', note: '' }]
      : project.approvals

    try {
      store.write(project.slug, {
        plan: renderPlan(parts),
        // 定义变过的部分，旧记录不再对应新的活，必须丢掉 —— 否则一条旧的
        // 「验收通过」会冒充新计划的完成。定义没变的原样保留。
        parts: renderRecords(kept),
        // 计划变了，收尾验收就得重来：它验的是上一版计划。
        acceptanceRun: '',
        project: renderProject({ ...project, phase: PHASE.awaitingApproval, approvals }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了计划：${reasonOf(error)}` }
    }

    return {
      ok: true,
      count: parts.length,
      revised,
      kept: unchanged.length,
      dropped: parts.length - unchanged.length,
    }
  }

  /** 批准与驳回只认 user：模型没有通往这里的工具，这一层是第二道锁。 */
  function approvePlan(input) {
    return recordDecision(input, 'approved')
  }

  function rejectPlan(input) {
    return recordDecision(input, 'rejected')
  }

  function recordDecision(input, kind) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能批准或驳回计划' }
    }

    const note = trimmedText(input?.reason)
    if (kind === 'rejected') {
      const problem = checkReason(note, '驳回')
      if (problem) return { ok: false, problem }
    } else if (/[\r\n]/.test(note)) {
      return { ok: false, problem: '理由不能包含换行：那会把审批记录写坏' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    if (project.approvalProblem) {
      return { ok: false, problem: `审批记录读不懂，不敢动：${project.approvalProblem}` }
    }
    if (project.phase === PHASE.planning && project.parts.length === 0) {
      return { ok: false, problem: '还没有计划；先提交一份计划' }
    }

    if (kind === 'approved') {
      if (project.approved && project.phase === PHASE.executing) {
        return { ok: false, problem: '计划已经批准过了' }
      }
      if (project.phase !== PHASE.awaitingApproval) {
        return { ok: false, problem: '计划还没到待批准；先重新提交一份计划' }
      }
      if (project.planProblem) {
        return { ok: false, problem: `计划读不出来，不能批准：${project.planProblem}` }
      }

      const problem = validatePlan({
        parts: project.parts,
        hasOrigin,
        slug: project.slug,
        evidenceTypes,
        acceptance: project.acceptance,
        contract: project.contract,
      })
      if (problem) return { ok: false, problem: `计划不合法，不能批准：${problem}` }
    } else if (project.phase !== PHASE.awaitingApproval && project.phase !== PHASE.executing) {
      return { ok: false, problem: '现在没有可以驳回的计划' }
    }

    const approvals = [...project.approvals, { at: stamp(), kind, note }]
    const phase = kind === 'approved' ? PHASE.executing : PHASE.planning
    const acceptanceHash =
      kind === 'approved' ? acceptanceFingerprint(project.acceptance) : project.acceptanceHash

    // 批准也是「把当前这份验收标准收下」的路径：删掉的编号同样要登记退役，
    // 否则删掉再塞一条新标准进同一个号，身份就悄悄换了。
    const reconciled =
      kind === 'approved'
        ? reconcileAcceptanceIds(project.acceptanceIds ?? [], project.acceptance)
        : null
    if (reconciled?.problem) return { ok: false, problem: reconciled.problem }

    // 批准 = 把当前的验收依据钉下来。之后谁动了这些文件，验收就作废。
    let contract = project.contract ?? []
    if (kind === 'approved' && contract.length > 0) {
      if (typeof fileHash !== 'function') {
        return { ok: false, problem: '契约文件要有指纹才能批准，但插件没有拿到文件指纹能力' }
      }

      const hashed = []
      for (const entry of contract) {
        const value = fileHash(entry.path)
        if (!value) {
          return {
            ok: false,
            problem: `契约文件「${entry.path}」读不到：验收依据必须在批准时就存在`,
          }
        }
        hashed.push({ path: entry.path, hash: value })
      }
      contract = hashed
    }

    // 批准时把命令检查先跑一遍：现在就已经绿的检查，多半没在测你要做的事。
    let preRunGreen = []
    if (kind === 'approved' && preRun !== false) {
      const commandCriteria = project.acceptance.filter((item) => item.check.kind === 'command')
      if (commandCriteria.length > 0) {
        const observed = checkRunner.run(commandCriteria, '预跑')
        if (!observed.problem) {
          const green = new Set(observed.checks.filter((item) => item.ok).map((item) => item.id))
          preRunGreen = commandCriteria
            .filter((item) => green.has(item.id))
            .map((item) => `${item.id}「${item.text}」`)
        }
      }
    }

    try {
      store.write(project.slug, {
        project: renderProject({
          ...project,
          phase,
          approvals,
          acceptanceHash,
          contract,
          acceptanceIds: reconciled?.ids ?? project.acceptanceIds,
        }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, ...(preRunGreen.length > 0 ? { preRunGreen } : {}) }
  }

  /**
   * 取下一个可派分的部分。
   *
   * 闸门不信任 `阶段：` 这一行 —— 它是普通 markdown，谁都改得了 ——
   * 而是要求审批历史里最后一条确实是「批准」。手改阶段行骗不过这里。
   */
  function nextPart(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    // 与派分入口共用同一道闸门，这里只额外管「先验收候选」与「停下等用户」。
    const gateProblem = dispatchGate(project)
    if (gateProblem) return { ok: false, problem: gateProblem }

    const latest = new Map()
    for (const record of project.records) latest.set(record.partId, record)


    // 有部分在等用户时先停下：再派一次只会把同一个结果重跑一遍。
    const waiting = project.parts.find((candidate) => {
      const status = latest.get(candidate.id)?.status
      return status === RECORD_STATUS.blocked || status === RECORD_STATUS.needsUserVerification
    })
    if (waiting) {
      const why =
        latest.get(waiting.id).status === RECORD_STATUS.blocked ? '报了阻塞' : '等你确认'
      return { ok: false, problem: `部分 ${waiting.id}「${waiting.title}」${why}，先处理它` }
    }

    // 子对话说完成只是候选，主对话验收之后才算完 —— 验收没过就不许往后派。
    const pending = project.parts.find(
      (candidate) => latest.get(candidate.id)?.status === RECORD_STATUS.done,
    )
    if (pending) {
      return {
        ok: false,
        problem: `部分 ${pending.id}「${pending.title}」有候选完成回报，先验收它`,
      }
    }

    const completed = project.verified

    if (project.allDone) {
      return { ok: false, problem: '项目已经全部完成：所有部分都验收通过，没有可派分的部分了' }
    }
    const part = project.parts.find(
      (candidate) =>
        !completed.has(candidate.id) &&
        candidate.dependsOn.every((dependency) => completed.has(dependency)),
    )
    if (!part) return { ok: false, problem: '没有可派分的部分：剩下的都被未完成的部分挡着' }

    return { ok: true, project, part }
  }

  /**
   * 派分下一个部分：起一个子对话，把它交回的回报记下来。
   *
   * 子对话失败、抛异常、回报不合规，都不算项目崩了 —— 这个部分记为可重试。
   */
  async function dispatchNext(input) {
    const gate = nextPart(input)
    if (!gate.ok) return gate

    if (typeof runChild !== 'function') {
      return { ok: false, problem: '没有接上跑子对话的能力，派分不了' }
    }

    return runPart(gate.project, gate.part, input)
  }

  /**
   * 并行派分：把「互不依赖、文件集不相交」的部分一次派出去，等它们都回来。
   *
   * 能派几个由三方决定：配置的上限、平台报的剩余名额、以及计划本身有多少
   * 个可以同时动的部分。验收仍然一次一个，那是 verifyPart 的事。
   */
  async function dispatchAll(input) {
    const gate = readyGate(input)
    if (!gate.ok) return gate
    if (typeof runChild !== 'function') {
      return { ok: false, problem: '没有接上跑子对话的能力，派分不了' }
    }

    const { project } = gate
    const limit = scheduler.limit()
    if (limit === 0) {
      return { ok: false, problem: '平台的子对话名额已经用完了：等一个回来再派' }
    }

    const candidates = scheduler.ready(project.parts, {
      verified: project.verified,
      partStatus: project.partStatus,
      overlaps: pathsOverlap,
      size: limit,
    })

    if (candidates.length === 0) return { ok: false, problem: '没有可以派分的部分了' }

    // 谁先回来谁先进结果：验收要按完成顺序做，别按计划顺序排队。
    const completed = []
    await Promise.all(
      candidates.map((part) =>
        runPart(project, part, { ...input, concurrent: candidates.length > 1 }).then((result) => {
          completed.push(result)
          return result
        }),
      ),
    )

    // 一个都没派成：整次算失败，理由用第一条 —— 别让模型以为派了。
    if (completed.every((result) => !result.ok)) {
      return { ok: false, problem: completed[0]?.problem ?? '派分失败', retryable: true }
    }

    return {
      ok: true,
      count: candidates.length,
      limit,
      parts: candidates.map((part) => part.id),
      // results 按完成顺序给：先回来的先验收。
      results: completed,
      failed: completed.filter((result) => !result.ok).length,
    }
  }

  /** 派分入口的共用闸门：为什么现在不能开工。空串表示可以。 */
  function dispatchGate(project) {
    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return recordsIssue
    if (project.approvalProblem) {
      return `审批记录读不懂，无法确认计划是否批准：${project.approvalProblem}`
    }
    if (project.planProblem) return `计划读不出来：${project.planProblem}`
    if (project.acceptanceProblem) return project.acceptanceProblem

    // 验收依据不可信的时候，先别派新活：派了也只能靠坏掉的证据收工。
    const contractIssue = contractProblem(project)
    if (contractIssue) return contractIssue
    if (project.parts.length === 0) return '还没有计划；先提交一份计划'
    if (project.phase === PHASE.acceptance) {
      return '所有部分都验收通过了。下一步不是派分，而是真的跑一遍项目验收标准，用 manager_accept 记录结果，等用户点头。'
    }
    if ((project.phase !== PHASE.executing && project.phase !== PHASE.acceptance) || !project.approved) {
      return `计划尚未批准；先用 /${commandName} approve 批准`
    }

    const inFlight = project.parts.find((candidate) => {
      const status = project.partStatus?.[candidate.id]
      return status === RECORD_STATUS.running || status === 'interrupted'
    })
    if (inFlight) {
      const interrupted = project.partStatus[inFlight.id] === 'interrupted'
      return interrupted
        ? `部分 ${inFlight.id}「${inFlight.title}」上一次派分断在半路：用 /${commandName} resolve [说明] 解除之后再派`
        : `部分 ${inFlight.id}「${inFlight.title}」正在派分中：等它回报`
    }

    return ''
  }

  /** 派分前置检查：阶段、批准、没有在飞。 */
  function readyGate(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    const problem = dispatchGate(project)
    if (problem) return { ok: false, problem }

    return { ok: true, project }
  }

  /**
   * 一次派分的完整过程：写台账、起子对话、落结果。
   * 串行与并行共用这一段，台账写入走队列，避免两个并发的派分互相覆盖。
   */
  async function runPart(project, part, input) {
    // 读闸门挡不住「两次派分同时通过检查」：这里同步占位，占了才开跑。
    if (!scheduler.begin(part.id)) {
      return { ok: false, part, problem: `部分 ${part.id} 正在派分中：等它回报` }
    }

    try {
      return await dispatchOne(project, part, input)
    } finally {
      scheduler.end(part.id)
    }
  }

  async function dispatchOne(project, part, input) {
    // 轮次只数「派分结果」：验收结论之外的一律算一次派分。
    // 用「排除裁决」而不是白名单 —— 以后新增派分状态不会因为漏加而悄悄少数。
    const attempt =
      project.records.filter(
        (record) => record.partId === part.id && !isVerdictStatus(record.status),
      ).length + 1
    const prompt = buildPrompt({ project, part, attempt, contextFiles: contextFiles() })
    const at = stamp()

    // 派分之前先把「在飞」写进台账：这一个部分从此不能被再派一次。
    // 进程中途断掉时，这条记录就留在盘上 —— 那正是「中断」的证据。
    const started = await recordWriter.append(project.slug, {
      partId: part.id,
      attempt,
      at,
      status: RECORD_STATUS.running,
      summary: '',
      evidence: [],
      checks: [],
      sessionId: '',
      pid: processId,
    })
    if (started.problem) return { ok: false, problem: started.problem }

    let outcome
    try {
      outcome = await runChild({ part, project, attempt, prompt, signal: input?.signal })
    } catch (error) {
      outcome = { ok: false, problem: reasonOf(error) }
    }

    const settle = (status, summary, extra = {}) =>
      recordWriter.replaceInFlight(project.slug, part.id, attempt, {
        partId: part.id,
        attempt,
        at,
        status,
        summary,
        evidence: [],
        sessionId: '',
        blockedReason: '',
        ...extra,
      })

    if (!outcome || outcome.ok !== true) {
      const problem = outcome?.problem ?? '子对话没有返回结果'
      const written = await settle(RECORD_STATUS.failed, problem)
      if (written.problem) return { ok: false, problem: written.problem }
      return { ok: false, part, problem: `部分 ${part.id} 的子对话失败了：${problem}`, retryable: true }
    }

    const report = outcome.report
    const problem = checkReport(report, part, project)
    if (problem) {
      const written = await settle(RECORD_STATUS.invalid, `回报不合规：${problem}`)
      if (written.problem) return { ok: false, problem: written.problem }
      return { ok: false, part, problem: `部分 ${part.id} 的回报不合规：${problem}`, retryable: true }
    }

    // 子对话说它只动了该动的文件 —— git 说了算。查不了（不是仓库）就留空。
    let stray = []
    try {
      stray = strayCheck ? strayCheck(part) ?? [] : []
    } catch {
      stray = []
    }

    const written = await settle(trimmedText(report.status), trimmedText(report.summary), {
      evidence: listOf(report.evidence),
      sessionId: trimmedText(outcome.sessionId) || trimmedText(report.sessionId),
      blockedReason: trimmedText(report.blockedReason),
      stray,
      // 并行时同一个工作区里的改动互相交织，越界归属不可靠 —— 标明，别让人当真。
      strayUnreliable: input?.concurrent === true && stray.length > 0,
    })
    if (written.problem) return { ok: false, problem: written.problem }

    return { ok: true, part, attempt, report, stray }
  }

  /**
   * 验收一个部分。子对话说完成只是候选；这里由插件**亲自执行**这部分覆盖的
   * 每条标准上的检查，按执行结果给出结论：
   *
   * - 有检查没过 → 打回，并把未通过的明细写进记录；
   * - 全过但还覆盖着判断型标准 → 进「待确认」，由用户点头；
   * - 全过且没有判断型标准 → 通过。
   *
   * 主对话不再提交结论：它只能请求验收。旧的 `verdict` 参数在这里没有作用。
   */
  function verifyPart(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    if ((project.phase !== PHASE.executing && project.phase !== PHASE.acceptance) || !project.approved) {
      return { ok: false, problem: `计划尚未批准或已退回；先用 /${commandName} approve 批准` }
    }
    if (project.acceptanceProblem) return { ok: false, problem: project.acceptanceProblem }
    const contractIssue = contractProblem(project)
    if (contractIssue) return { ok: false, problem: contractIssue }

    const partId = trimmedText(input?.part)
    const part = project.parts.find((candidate) => candidate.id === partId)
    if (!part) return { ok: false, problem: `计划里没有部分「${partId || '未指定'}」` }

    // 别的部分还在跑的时候工作区是脏的：这时跑检查，结果说明不了什么。
    const busy = project.parts.filter((candidate) => {
      const status = project.partStatus?.[candidate.id]
      return status === RECORD_STATUS.running || status === 'interrupted'
    })
    if (busy.length > 0) {
      return {
        ok: false,
        problem: `还有部分在跑（${busy
          .map((item) => item.id)
          .join('、')}）：等工作区安静下来再验收，检查结果才可信`,
      }
    }

    const latest = project.records.filter((record) => record.partId === partId).pop()
    if (!latest) return { ok: false, problem: `部分 ${partId} 还没有子对话回报，没什么可验收的` }
    if (latest.status !== RECORD_STATUS.done) {
      return {
        ok: false,
        problem: `部分 ${partId} 最近一次回报是「${latest.status}」，不是候选完成；先重新派分`,
      }
    }
    if (latest.evidence.length === 0) {
      return { ok: false, problem: `部分 ${partId} 的回报没有证据，不能算完成` }
    }

    const reason = trimmedText(input?.reason)
    if (reason) {
      const reasonProblem = checkReason(reason, '验收')
      if (reasonProblem) return { ok: false, problem: reasonProblem }
    }

    const covered = project.acceptance.filter((item) => part.covers.includes(item.id))
    const observed = checkRunner.run(covered, `部分 ${part.id}`)
    if (observed.problem) return { ok: false, problem: observed.problem }
    archiveOutputs(project, observed.checks)

    const { checks, failures, judgements } = observed
    const outcome =
      failures.length > 0
        ? RECORD_STATUS.returned
        : judgements.length > 0
          ? RECORD_STATUS.needsUserVerification
          : RECORD_STATUS.accepted

    const summary = reason || summaryOf(outcome, { checks, failures, judgements })

    const records = [
      ...project.records,
      {
        partId,
        attempt: latest.attempt,
        at: stamp(),
        status: outcome,
        summary,
        evidence: latest.evidence,
        checks,
        sessionId: '',
        blockedReason: '',
      },
    ]

    // 同一部分连续两次因同一个原因验收失败，就直接判阻塞 —— 不用等谁来宣布。
    let blocked = false
    if (outcome === RECORD_STATUS.returned) {
      const repeat = repeatFailureReason(records, partId)
      if (repeat) {
        blocked = true
        records.push({
          partId,
          attempt: latest.attempt,
          at: stamp(),
          status: RECORD_STATUS.blocked,
          summary: `连续两次验收失败，原因都是「${repeat}」`,
          evidence: [],
          checks: [],
          sessionId: '',
          blockedReason: '同一个原因已经卡了两次：换个方向、补上缺的东西，或者调整验收标准',
        })
      }
    }

    const written = writeRecords(project, records)
    if (written) return { ok: false, problem: written }

    // 验收通过才打快照：留下一个能回去的点。快照失败不推翻验收 ——
    // 它只是回滚能力，不是完成条件。
    const frozen = outcome === RECORD_STATUS.accepted ? safeSnapshot(part) : null

    return {
      ok: true,
      part,
      verdict: outcome,
      checks,
      failures: failures.map((item) => item.id),
      ...(judgements.length > 0 ? { judgements: judgements.map((item) => item.id) } : {}),
      ...(blocked ? { blocked: true } : {}),
      ...(frozen ? { snapshot: frozen } : {}),
    }
  }

  function safeSnapshot(part) {
    if (typeof snapshot !== 'function') return null

    try {
      const result = snapshot({ slug: part.slug, part })
      return result && typeof result === 'object' ? result : { ok: false, problem: '快照没有返回结果' }
    } catch (error) {
      return { ok: false, problem: reasonOf(error) }
    }
  }

  /**
   * 模型请求阻塞。只承认 ADR-0001 的三种情形，别的一律拒；
   * 「连续两次同样失败」由插件自己数，模型说了不算。
   */
  function requestBlock(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    if ((project.phase !== PHASE.executing && project.phase !== PHASE.acceptance) || !project.approved) {
      return { ok: false, problem: `计划尚未批准或已退回；先用 /${commandName} approve 批准` }
    }
    if (project.acceptanceProblem) return { ok: false, problem: project.acceptanceProblem }

    const partId = trimmedText(input?.part)
    const part = project.parts.find((candidate) => candidate.id === partId)
    if (!part) return { ok: false, problem: `计划里没有部分「${partId || '未指定'}」` }

    const latest = latestFor(project.records, partId)
    const cannotBlock = {
      [RECORD_STATUS.accepted]: '已经验收通过',
      [RECORD_STATUS.confirmed]: '已经由用户确认',
      [RECORD_STATUS.blocked]: '已经处于阻塞',
      [RECORD_STATUS.needsUserVerification]: '正在等用户确认',
    }
    if (latest !== undefined && Object.hasOwn(cannotBlock, latest.status)) {
      return { ok: false, problem: `部分 ${partId} ${cannotBlock[latest.status]}，不能再报阻塞` }
    }

    const condition = trimmedText(input?.condition)
    const label = Object.hasOwn(CONDITION_LABELS, condition) ? CONDITION_LABELS[condition] : ''
    if (!label) {
      return {
        ok: false,
        problem: `阻塞情形「${condition || '未指定'}」不在允许的三种里：只接受 ${Object.keys(CONDITION_LABELS).join(' / ')}`,
      }
    }

    const detail = trimmedText(input?.detail)
    if (!detail) {
      return { ok: false, problem: '请求阻塞要说清：缺什么、或者为什么现有验收标准做不到' }
    }
    if (/[\r\n]/.test(detail)) {
      return { ok: false, problem: '阻塞说明不能包含换行：那会把记录写坏' }
    }

    if (condition === BLOCK_CONDITIONS.repeatedFailure && !repeatFailureReason(project.records, partId)) {
      return { ok: false, problem: `部分 ${partId} 没有连续两次同样的验收失败，不构成这个情形` }
    }

    const written = writeRecords(project, [
      ...project.records,
      {
        partId,
        attempt: latest?.attempt ?? 1,
        at: stamp(),
        status: RECORD_STATUS.blocked,
        condition,
        summary: label,
        evidence: [],
        sessionId: '',
        blockedReason: detail,
      },
    ])
    if (written) return { ok: false, problem: written }

    return { ok: true, part }
  }

  /** 当前阻塞的部分，数据交给渲染层排版。 */
  function blockReport(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    const blocked = []

    for (const part of project.parts) {
      const history = project.records.filter((record) => record.partId === part.id)
      const latest = history[history.length - 1]
      if (latest?.status !== RECORD_STATUS.blocked) continue

      blocked.push({
        id: part.id,
        title: part.title,
        condition: Object.hasOwn(CONDITION_LABELS, latest.condition)
          ? CONDITION_LABELS[latest.condition]
          : latest.summary || '未说明',
        need: latest.blockedReason,
        history: history.map((record) => ({
          attempt: record.attempt,
          status: record.status,
          summary: record.summary,
        })),
      })
    }

    if (blocked.length === 0) return { ok: false, problem: '现在没有部分处于阻塞或中断' }
    return { ok: true, blocked }
  }

  /** 有些证据只能由用户亲眼判断：确认或打回都只认 user。 */
  function confirmPart(input) {
    return decideConfirmation(input, RECORD_STATUS.confirmed)
  }

  function declinePart(input) {
    return decideConfirmation(input, RECORD_STATUS.declined)
  }

  function decideConfirmation(input, kind) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能确认或打回这一部分' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    if ((project.phase !== PHASE.executing && project.phase !== PHASE.acceptance) || !project.approved) {
      return { ok: false, problem: `计划尚未批准或已退回；先用 /${commandName} approve 批准` }
    }
    if (project.acceptanceProblem) return { ok: false, problem: project.acceptanceProblem }
    const contractIssue = contractProblem(project)
    if (contractIssue) return { ok: false, problem: contractIssue }

    // 确认只是点个头，没写说明就记一句默认的；打回必须说清差在哪。
    const reason =
      kind === RECORD_STATUS.confirmed && !trimmedText(input?.reason)
        ? '用户确认（未写说明）'
        : trimmedText(input?.reason)
    const reasonProblem = checkReason(reason, kind === RECORD_STATUS.confirmed ? '确认' : '打回')
    if (reasonProblem) return { ok: false, problem: reasonProblem }

    const wanted = trimmedText(input?.part)
    let part = null

    if (wanted) {
      part = project.parts.find((candidate) => candidate.id === wanted) ?? null
      if (!part) return { ok: false, problem: `计划里没有部分「${wanted}」` }
    } else {
      const pending = project.parts.filter(
        (candidate) =>
          latestFor(project.records, candidate.id)?.status === RECORD_STATUS.needsUserVerification,
      )
      if (pending.length === 0) return { ok: false, problem: '现在没有部分在等你确认' }
      if (pending.length > 1) {
        return {
          ok: false,
          problem: `记录里同时有多个部分在等确认（${pending.map((item) => item.id).join('、')}），这不正常：先看一眼 parts.md`,
        }
      }
      part = pending[0]
    }

    const latest = latestFor(project.records, part.id)
    if (latest?.status !== RECORD_STATUS.needsUserVerification) {
      return {
        ok: false,
        problem: `部分 ${part.id} 没有待确认的回报（最近一次是「${latest?.status ?? '还没有回报'}」）`,
      }
    }

    const written = writeRecords(project, [
      ...project.records,
      {
        partId: part.id,
        attempt: latest.attempt,
        at: stamp(),
        status: kind,
        summary: reason,
        evidence: latest.evidence,
        sessionId: '',
        blockedReason: '',
      },
    ])
    if (written) return { ok: false, problem: written }

    return { ok: true, part }
  }

  /** 用户把阻塞处理掉之后恢复：让这一部分重新可派分。 */
  function resolvePart(input) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能解除阻塞' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const recordsIssue = recordsGuard(project)
    if (recordsIssue) return { ok: false, problem: recordsIssue }
    const reason = trimmedText(input?.reason)
    const reasonProblem = checkReason(reason, '解除阻塞')
    if (reasonProblem) return { ok: false, problem: reasonProblem }

    const blocked = project.parts.filter((candidate) => {
      const status = latestFor(project.records, candidate.id)?.status
      if (status === RECORD_STATUS.blocked) return true
      // 断在半路的在飞记录也由用户解除 —— 插件不替谁重试。
      return status === RECORD_STATUS.running && project.interrupted?.has(candidate.id) === true
    })
    const wanted = trimmedText(input?.part)

    let part = null
    if (wanted) {
      part = blocked.find((candidate) => candidate.id === wanted) ?? null
      if (!part) return { ok: false, problem: `部分 ${wanted} 没有处于阻塞、也没有断在半路` }
    } else {
      if (blocked.length === 0) return { ok: false, problem: '现在没有部分处于阻塞或中断' }
      if (blocked.length > 1) {
        return {
          ok: false,
          problem: `有多个部分阻塞：${blocked.map((item) => item.id).join('、')}；请指定一个`,
        }
      }
      part = blocked[0]
    }

    const latest = latestFor(project.records, part.id)
    const written = writeRecords(project, [
      ...project.records,
      {
        partId: part.id,
        attempt: latest.attempt,
        at: stamp(),
        status: RECORD_STATUS.resolved,
        summary: reason,
        evidence: [],
        sessionId: '',
        blockedReason: '',
      },
    ])
    if (written) return { ok: false, problem: written }

    return { ok: true, part }
  }

  /** 成功返回 null，失败返回可读原因。 */
  function writeRecords(project, records) {
    try {
      store.write(project.slug, { parts: renderRecords(records) })
      return null
    } catch (error) {
      return `写不了部分记录：${reasonOf(error)}`
    }
  }

  /**
   * 收尾验收：所有部分都过了之后，真的要跑一遍项目的验收标准。
   *
   * 「完成」不能只是记账 —— 这条记录是全项目唯一一次整体验证。
   */
  function acceptRun(input) {
    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    if (project.acceptanceProblem) return { ok: false, problem: project.acceptanceProblem }
    const contractIssue = contractProblem(project)
    if (contractIssue) return { ok: false, problem: contractIssue }
    if (project.acceptanceRunProblem) {
      return { ok: false, problem: `收尾验收记录读不出来：${project.acceptanceRunProblem}` }
    }
    if (!project.allPartsVerified) {
      const left = project.parts.filter((part) => !project.verified.has(part.id)).length
      return { ok: false, problem: `还有 ${left} 个部分没验收通过，现在做收尾验收不算数` }
    }
    if (project.acceptancePending) {
      return { ok: false, problem: '上一轮收尾验收还在等用户确认：先确认或打回' }
    }

    const summary = trimmedText(input?.summary)
    const claimed = listOf(input?.evidence)
      .map((item) => trimmedText(item))
      .filter((item) => item.length > 0)

    // 文本可以是假的，命令不行：配了核对命令就由插件自己跑一遍。
    let checked = null
    if (project.verify && typeof runVerify === 'function') {
      let outcome
      try {
        outcome = runVerify(project.verify)
      } catch (error) {
        outcome = { ok: false, code: -1, output: reasonOf(error) }
      }

      checked = { command: project.verify, ...outcome }

      if (!outcome.ok) {
        return {
          ok: false,
          problem: `核对命令没通过（退出码 ${outcome.code}），收尾验收不算数：\n${tail(outcome.output, 12).join('\n')}`,
          checked,
        }
      }
    }

    // 收尾不是「每个部分都过了」的加总：所有可执行标准的检查再跑一遍。
    // 判断型标准在这里不出现 —— 它们已在部分层面由用户确认过，不是机械判定。
    const executable = project.acceptance.filter((item) => item.check.kind !== 'judgement')
    const rerun =
      executable.length > 0
        ? checkRunner.run(executable, '收尾验收')
        : { checks: [], failures: [], judgements: [] }
    if (rerun.problem) return { ok: false, problem: rerun.problem, checked }
    archiveOutputs(project, rerun.checks)

    if (rerun.failures.length > 0) {
      return {
        ok: false,
        problem: `收尾验收没通过：${rerun.failures
          .map((item) => item.id)
          .join('、')}\n${rerun.failures
          .map((item) => `${item.id}：${item.detail}`)
          .join('\n')}`,
        checked,
        checks: rerun.checks,
      }
    }

    const evidence = [...claimed]
    for (const item of rerun.checks) {
      evidence.push(`检查 ${item.id} ${item.ok ? '通过' : '不通过'}：${item.detail.split(/\r?\n/)[0]}`)
    }
    if (checked) {
      evidence.push(`核对：${checked.command} → 退出码 ${checked.code}（插件自己跑的）`)
      for (const line of tail(checked.output, 8)) evidence.push(`核对：${line}`)
    }

    if (evidence.length === 0) {
      return { ok: false, problem: '收尾验收必须给证据：真的跑过验收标准之后的输出' }
    }
    if (!summary) return { ok: false, problem: '收尾验收要写一句摘要：逐条验收标准的结论' }

    const attempt =
      project.acceptanceRun.filter((record) => !isVerdictStatus(record.status)).length + 1
    const record = {
      partId: ACCEPTANCE_ID,
      attempt,
      at: stamp(),
      status: RECORD_STATUS.needsUserVerification,
      summary,
      evidence,
      checks: rerun.checks,
      reason: '',
    }

    try {
      store.write(project.slug, {
        acceptanceRun: renderRecords([...project.acceptanceRun, record]),
      })
    } catch (error) {
      return { ok: false, problem: `写不了收尾验收记录：${reasonOf(error)}` }
    }

    return { ok: true, attempt }
  }

  function acceptProject(input) {
    return decideAcceptance(input, RECORD_STATUS.accepted)
  }

  function declineAcceptance(input) {
    return decideAcceptance(input, RECORD_STATUS.returned)
  }

  function decideAcceptance(input, kind) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能确认或打回收尾验收' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    const last = project.acceptanceRun[project.acceptanceRun.length - 1]

    if (!last || last.status !== RECORD_STATUS.needsUserVerification) {
      return { ok: false, problem: '现在没有待你确认的收尾验收' }
    }

    const confirmed = kind === RECORD_STATUS.accepted
    const reason = confirmed && !trimmedText(input?.reason)
      ? '用户确认（未写说明）'
      : trimmedText(input?.reason)

    const problem = checkReason(reason, confirmed ? '确认' : '打回收尾验收')
    if (problem) return { ok: false, problem }

    const record = {
      partId: ACCEPTANCE_ID,
      attempt: last.attempt,
      at: stamp(),
      status: kind,
      summary: last.summary,
      evidence: last.evidence,
      reason,
    }

    try {
      store.write(project.slug, {
        acceptanceRun: renderRecords([...project.acceptanceRun, record]),
      })
    } catch (error) {
      return { ok: false, problem: `写不了收尾验收记录：${reasonOf(error)}` }
    }

    return { ok: true, confirmed }
  }

  /**
   * 放弃一个项目：不删文件，只是把它标成放弃。
   *
   * 通用工具必须能体面地退出 —— 以前想丢掉一个项目只能手动删目录。
   */
  function abandonProject(input) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能放弃项目' }
    }

    const loaded = load(input, { allowAbandoned: true })
    if (!loaded.ok) return loaded

    const { project } = loaded
    if (project.phase === PHASE.abandoned) {
      return { ok: false, problem: '这个项目已经放弃了' }
    }

    const reason = trimmedText(input?.reason)
    const problem = checkReason(reason, '放弃项目')
    if (problem) return { ok: false, problem }

    try {
      store.write(project.slug, {
        project: renderProject({
          ...project,
          phase: PHASE.abandoned,
          approvals: [...project.approvals, { at: stamp(), kind: 'abandoned', note: reason }],
        }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true }
  }

  /**
   * 验收标准改完之后，把它重新纳入流程。
   *
   * 标准本身还是由用户改文件（插件没有改标准的入口），这条的作用是：
   * 重新读一遍、更新指纹、退回待批准 —— 否则改过之后就再也批不了。
   */
  function reopenCriteria(input) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能重开验收标准' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded

    const reconciled = reconcileAcceptanceIds(project.acceptanceIds ?? [], project.acceptance)
    if (reconciled.problem) return { ok: false, problem: reconciled.problem }

    try {
      store.write(project.slug, {
        project: renderProject({
          ...project,
          phase: PHASE.awaitingApproval,
          acceptanceHash: acceptanceFingerprint(project.acceptance),
          acceptanceIds: reconciled.ids,
          approvals: [...project.approvals, { at: stamp(), kind: 'criteria', note: '' }],
        }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, count: project.acceptance.length }
  }

  /**
   * 迁移旧格式项目：先备份，再把验收标准迁成新格式（一律判断型），
   * 退回规划阶段 —— 旧计划没有覆盖关系，得重新提交一份。
   */
  /** 迁移只做转发：具体流程在 migrate.js 里。 */
  function migrateProject(input) {
    return migration.migrate(input)
  }

  /**
   * 验收依据有没有被动过。返回被改/被删的路径；空数组表示没动。
   * 拿不到指纹能力时按「都不可信」处理 —— 宁可停下，不假装验过。
   */
  function brokenContract(project) {
    const entries = project.contract ?? []
    if (entries.length === 0) return []
    if (typeof fileHash !== 'function') return entries.map((entry) => entry.path)

    return entries
      .filter((entry) => entry.hash && fileHash(entry.path) !== entry.hash)
      .map((entry) => entry.path)
  }

  function contractProblem(project) {
    const broken = brokenContract(project)
    if (broken.length === 0) return ''
    return `验收依据被改过（${broken.join('、')}）：先 /${commandName} contract 重新确认，再继续验收`
  }

  /**
   * 记录里只留输出尾巴；长输出或失败的检查，完整内容另存一份日志，
   * 记录里留一个指针。写不进去不影响判定 —— 日志是佐证，不是闸门。
   */
  function archiveOutputs(project, checks) {
    if (typeof writeLog !== 'function') return

    for (const check of checks ?? []) {
      if (!check.raw) continue
      const interesting = !check.ok || check.raw.split(/\r?\n/).filter((line) => line.trim()).length > 12
      if (!interesting) continue

      const name = `${stamp().replace(/[:.]/g, '-')}-${check.id}.log`
      try {
        writeLog(project.slug, name, check.raw)
        check.detail = `${check.detail}\n完整输出：.scratch/${project.slug}/logs/${name}`
      } catch {
        // 日志写不进去不影响判定
      }
    }
  }

  /** 契约文件换了内容之后，由用户重新钉指纹；钉完要重新批准，不自动续跑。 */
  function reopenContract(input) {
    if (trimmedText(input?.by) !== 'user') {
      return { ok: false, problem: '只有用户能重新确认契约文件' }
    }

    const loaded = load(input)
    if (!loaded.ok) return loaded

    const { project } = loaded
    const entries = project.contract ?? []
    if (entries.length === 0) return { ok: false, problem: '这个项目没有契约文件' }
    if (typeof fileHash !== 'function') {
      return { ok: false, problem: '插件没有拿到文件指纹能力，确认不了契约文件' }
    }

    const hashed = []
    for (const entry of entries) {
      const value = fileHash(entry.path)
      if (!value) return { ok: false, problem: `契约文件「${entry.path}」读不到` }
      hashed.push({ path: entry.path, hash: value })
    }

    try {
      store.write(project.slug, {
        project: renderProject({
          ...project,
          phase: PHASE.awaitingApproval,
          acceptanceHash: '',
          contract: hashed,
          approvals: [...project.approvals, { at: stamp(), kind: 'contract', note: '' }],
        }),
      })
    } catch (error) {
      return { ok: false, problem: `写不了项目状态：${reasonOf(error)}` }
    }

    return { ok: true, count: hashed.length }
  }

  function status(requested) {
    const resolved = resolveProject(requested)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const loaded = load({ project: resolved.slug }, { allowAbandoned: true, allowLegacy: true })
    if (!loaded.ok) return loaded
    return { ok: true, project: loaded.project }
  }

  function resolveProject(requested) {
    const wanted = trimmedText(requested)

    if (wanted) {
      const problem = checkName(wanted)
      if (problem) return { problem }
      return { slug: slugOf(wanted) }
    }

    let slugs
    try {
      slugs = store.listProjects()
    } catch (error) {
      return { problem: `读不了项目列表：${reasonOf(error)}` }
    }

    if (slugs.length === 0) return { problem: '还没有项目；先在主对话里启动一个项目' }
    if (slugs.length > 1) {
      return {
        problem: `有多个项目：${slugs.join('、')} —— 请指定一个（/${commandName} <项目名>）`,
      }
    }
    return { slug: slugs[0] }
  }

  /** 唯一的状态读取形状：要么 `{ ok: true, project }`，要么 `{ ok: false, problem }`。 */
  function load(input, { allowAbandoned = false, allowLegacy = false } = {}) {
    const resolved = resolveProject(input?.project)
    if (resolved.problem) return { ok: false, problem: resolved.problem }

    const slug = resolved.slug
    let raw
    try {
      raw = store.read(slug)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态读不出来：${reasonOf(error)}` }
    }
    if (raw === null) return { ok: false, problem: `找不到项目「${slug}」` }

    let fields
    try {
      fields = parseProject(raw.project)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的状态文件读不懂：${reasonOf(error)}` }
    }

    // 旧格式的项目只许看：要动它，先显式迁移。
    const legacy = !fields.formatVersion || fields.formatVersion < FORMAT_VERSION
    if (legacy && !allowLegacy) {
      return {
        ok: false,
        problem: `项目「${slug}」是旧格式（v${fields.formatVersion || 1}）：先用 /${commandName} migrate 迁移`,
      }
    }

    let acceptance
    try {
      acceptance = legacy ? parseLegacyAcceptance(raw.acceptance) : parseAcceptance(raw.acceptance)
    } catch (error) {
      return { ok: false, problem: `项目「${slug}」的验收标准读不出来：${reasonOf(error)}` }
    }

    // 放弃的项目只允许看状态，别的操作一律停手 —— 文件留着当存档。
    if (fields.phase === PHASE.abandoned && !allowAbandoned) {
      return {
        ok: false,
        problem: `项目「${slug}」已经放弃；要接着做请用别的名字重新 manager_start`,
      }
    }

    // 批准之后验收标准被改过，就不是用户批过的那一份了。
    // 旧格式的指纹算法不一样，比对没有意义，跳过。
    const acceptanceProblem =
      !legacy &&
      fields.acceptanceHash &&
      fields.acceptanceHash !== acceptanceFingerprint(acceptance)
        ? '验收标准在这次批准之后被改过：重新批准才算数'
        : ''

    // 计划读不出来只降级计划本身：目标与验收标准仍然要看得见。
    let parts = []
    let planProblem = ''
    try {
      parts = parsePlan(raw.plan, evidenceTypes, acceptance, { contract: fields.contract })
    } catch (error) {
      planProblem = reasonOf(error)
    }

    // 部分记录读不出来也只降级它自己。
    let records = []
    let recordsProblem = ''
    try {
      records = parseRecords(raw.parts)
    } catch (error) {
      recordsProblem = reasonOf(error)
    }

    const partStatus = {}
    for (const record of records) partStatus[record.partId] = record.status

    // 验收通过必须站得住：它前面得有一条同轮次、带证据的候选完成记录。
    const verified = verifiedParts(records)
    for (const [id, status] of Object.entries(partStatus)) {
      if (status === RECORD_STATUS.accepted && !verified.has(id)) {
        partStatus[id] = 'unverified-acceptance'
      }
    }

    // 在飞记录如果不是本进程写的，就是上一次进程断在半路 —— 状态里标成中断。
    const interrupted = new Set()
    for (const [id, status] of Object.entries(partStatus)) {
      if (status !== RECORD_STATUS.running) continue
      const record = records.filter((item) => item.partId === id).pop()
      if (record?.pid && String(record.pid) !== String(processId)) {
        interrupted.add(id)
        partStatus[id] = 'interrupted'
      }
    }

    const attempts = {}
    for (const record of records) {
      if (isVerdictStatus(record.status)) continue
      attempts[record.partId] = (attempts[record.partId] ?? 0) + 1
    }

    const allPartsVerified = parts.length > 0 && parts.every((part) => verified.has(part.id))

    // 收尾验收：所有部分都过了之后，还要真的跑一遍项目验收标准，
    // 并把结果交给用户点头。不然「完成」只是记账。
    let acceptanceRun = []
    let acceptanceRunProblem = ''
    try {
      acceptanceRun = parseRecords(raw.acceptanceRun)
    } catch (error) {
      acceptanceRunProblem = reasonOf(error)
    }

    const lastAcceptance = acceptanceRun[acceptanceRun.length - 1]
    const acceptanceAccepted = lastAcceptance?.status === RECORD_STATUS.accepted
    const acceptancePending = lastAcceptance?.status === RECORD_STATUS.needsUserVerification
    const allDone = allPartsVerified && acceptanceAccepted

    const last = fields.approvals[fields.approvals.length - 1]

    return {
      ok: true,
      project: {
        slug,
        ...fields,
        // 阶段在文件里不动，但读出来时按事实呈现：所有部分做完就
        // 显示「待收尾验收」，用户点头之后才算完成。
        phase: allDone
          ? fields.phase
          : allPartsVerified && fields.phase === PHASE.executing
            ? PHASE.acceptance
            : fields.phase,
        acceptance,
        legacy,
        parts,
        planProblem,
        records,
        recordsProblem,
        acceptanceRun,
        acceptanceRunProblem,
        acceptancePending,
        acceptanceAccepted,
        allPartsVerified,
        partStatus,
        interrupted,
        verified,
        attempts,
        allDone,
        acceptanceProblem,
        approved: last?.kind === 'approved',
      },
    }
  }

  function stamp() {
    return new Date(now()).toISOString()
  }

  return {
    startProject,
    submitPlan,
    approvePlan,
    rejectPlan,
    nextPart,
    dispatchNext,
    dispatchAll,
    verifyPart,
    confirmPart,
    declinePart,
    requestBlock,
    blockReport,
    resolvePart,
    acceptRun,
    acceptProject,
    declineAcceptance,
    abandonProject,
    reopenCriteria,
    reopenContract,
    migrateProject,
    status,
  }
}

function latestFor(records, partId) {
  return records.filter((record) => record.partId === partId).pop()
}

/**
 * 部分记录读不懂时，所有会写记录的操作都要停。
 *
 * 否则它们在空记录上继续跑，下一次写盘就把读不懂的历史整段覆盖掉 ——
 * 用户既看不到旧记录，也得不到任何提示。
 */
function recordsGuard(project) {
  return project.recordsProblem
    ? `部分记录读不懂，先修好 parts.md 再操作：${project.recordsProblem}`
    : ''
}

/**
 * 一个部分的定义指纹。
 *
 * 改计划时只有指纹没变的部分才沿用旧记录 —— 否则一条旧的「验收通过」
 * 会冒充新定义的完成。文件和依赖的顺序不算变化。
 */
function fingerprint(part) {
  return JSON.stringify([
    part.id,
    part.title,
    part.origin,
    [...part.files].sort(),
    [...part.dependsOn].sort(),
    part.evidence,
    [...part.covers].sort(),
  ])
}

const REPORT_STATUSES = [
  RECORD_STATUS.done,
  RECORD_STATUS.needsUserVerification,
  RECORD_STATUS.blocked,
]

/** 验收结论 → 写进记录的状态。 */
/** ADR-0001：阻塞只在这三种情形成立，别的一律不认。 */
const BLOCK_CONDITIONS = {
  repeatedFailure: 'repeated-failure',
  missingUserInput: 'missing-user-input',
  criteriaChange: 'criteria-change',
}

const CONDITION_LABELS = {
  'repeated-failure': '同一部分连续两次验收失败且原因未变',
  'missing-user-input': '缺少只有用户能提供的东西',
  'criteria-change': '需要改动验收标准本身',
}

function checkReport(report, part, project) {
  if (!report || typeof report !== 'object') return '回报不是一个对象'

  const status = trimmedText(report.status)
  if (!REPORT_STATUSES.includes(status)) {
    return `回报里的状态「${status}」不认识；只接受 ${REPORT_STATUSES.join(' / ')}`
  }
  if (!trimmedText(report.summary)) return '回报缺摘要'

  const evidence = listOf(report.evidence)
  if (evidence.length === 0) {
    return '回报里没有证据：每条回报都要带证据清单，即使这一部分没做成'
  }

  if (status === RECORD_STATUS.done) {
    // 证据类型不是装饰：报完成时至少要有一条证据真是这个类型。
    const typed = evidence.some((item) => matchesEvidenceType(item, part.evidence))
    if (!typed) {
      return `判为完成，但没有一条证据是这部分要求的 ${part.evidence} 类型；证据要写成「${part.evidence}：<具体内容>」`
    }
  }

  if (status === RECORD_STATUS.blocked) {
    const condition = trimmedText(report.blockedCondition)
    if (!Object.hasOwn(CONDITION_LABELS, condition)) {
      return `判为阻塞，但没说清是哪种情形；只接受 ${Object.keys(CONDITION_LABELS).join(' / ')}`
    }
    if (!trimmedText(report.blockedReason)) {
      return '判为阻塞却没说清卡在哪：要说清需要用户提供什么'
    }
    if (
      condition === BLOCK_CONDITIONS.repeatedFailure &&
      !repeatFailureReason(project.records, part.id)
    ) {
      return '声称连续两次同样的失败，但记录里对不上：这个情形由插件自己判定'
    }
  }

  return ''
}

/** 同一部分最近两次验收失败且理由一样时，返回那个理由。 */
/**
 * 「同样的失败」指的是同一条标准、同样没过 —— 不是模型把理由写得一样。
 * 有检查就用未通过的集合 + 各自的明细比较；旧记录没有检查时退回比较摘要。
 * 明细里带着输出尾巴，所以同一条标准换了个错法，不会算成「同样的失败」。
 */
function failureKeyOf(record) {
  const failed = (record.checks ?? []).filter((item) => !item.ok)
  if (failed.length > 0) {
    return failed
      .map((item) => `${item.id}｜${String(item.detail ?? '').trim()}`)
      .sort()
      .join('\n')
  }
  return record.summary
}

function repeatFailureReason(records, partId) {
  const failures = records.filter(
    (record) => record.partId === partId && record.status === RECORD_STATUS.returned,
  )
  if (failures.length < 2) return ''

  const last = failures[failures.length - 1]
  const before = failures[failures.length - 2]
  const key = failureKeyOf(last)
  return key !== '' && key === failureKeyOf(before) ? key : ''
}

/** 验收记录的默认说明：结论必须能一眼看出卡在哪条标准上。 */
function summaryOf(status, { checks, failures, judgements }) {
  if (status === RECORD_STATUS.returned) {
    return `未通过：${failures.map((item) => item.id).join('、')}`
  }
  if (status === RECORD_STATUS.needsUserVerification) {
    return `检查全过，待你确认：${judgements.map((item) => item.id).join('、')}`
  }
  return `检查全过：${checks.map((item) => item.id).join('、')}`
}

function checkReason(value, what) {
  if (!value) return `${what}要给理由：没有理由的记录等于没留下信息`
  if (/[\r\n]/.test(value)) return `${what}理由不能包含换行：那会把记录写坏`
  return ''
}

/**
 * 一条 accepted 记录只有前面紧挨着同部分、同轮次、带证据的 done 记录时才算数。
 * 这样手写一行「- 状态：accepted」绕不过验收 —— 它得连同前置的候选完成一起伪造。
 */
function verifiedParts(records) {
  const verified = new Set()
  const last = new Map()

  for (const record of records) {
    const previous = last.get(record.partId)

    if (record.status === RECORD_STATUS.returned || record.status === RECORD_STATUS.declined) {
      verified.delete(record.partId)
    } else if (record.status === RECORD_STATUS.resolved) {
      verified.delete(record.partId)
    } else if (record.status === RECORD_STATUS.accepted) {
      const stands =
        previous !== undefined &&
        previous.status === RECORD_STATUS.done &&
        previous.attempt === record.attempt &&
        previous.evidence.length > 0

      if (stands) verified.add(record.partId)
      else verified.delete(record.partId)
    } else if (record.status === RECORD_STATUS.confirmed) {
      const stands =
        previous !== undefined &&
        previous.status === RECORD_STATUS.needsUserVerification &&
        previous.attempt === record.attempt &&
        previous.evidence.length > 0

      if (stands) verified.add(record.partId)
      else verified.delete(record.partId)
    }

    last.set(record.partId, record)
  }

  return verified
}

function matchesEvidenceType(item, type) {
  return new RegExp(`^${type}\\s*[：:]`, 'i').test(item)
}

function buildPrompt({ project, part, attempt, contextFiles = [] }) {
  const acceptance = project.acceptance
    .map((item) => `  - ${item.id} ${item.text}（${describeCheck(item.check)}）`)
    .join('\n')
  const files = part.files.map((file) => `  - ${file}`).join('\n')

  // 上一轮没过的地方要带进来：重试的子对话得知道自己要补什么，而不是再猜一遍。
  const previous = project.records
    .filter((record) => record.partId === part.id && record.status === RECORD_STATUS.returned)
    .pop()

  const retry =
    previous === undefined
      ? []
      : previous.checks?.length > 0
        ? [
            '',
            '上一轮这里没过，这一轮要补上：',
            ...previous.checks
              .filter((item) => !item.ok)
              .map((item) => `  - ${item.id}：${item.detail.replace(/\r?\n/g, '\n    ')}`),
          ]
        : ['', '上一轮这里没过，这一轮要补上：', `  - ${previous.summary}`]

  const context =
    contextFiles.length === 0
      ? []
      : [
          '',
          '开工前先读这些文件，以既有约定为准，不要另起一套：',
          ...contextFiles.map((file) => `  - ${file}`),
        ]

  return [
    `你是「${project.name}」这个项目里的子对话，只负责下面这一个部分（第 ${attempt} 次尝试）。`,
    '',
    `部分编号：${part.id}`,
    `部分标题：${part.title}`,
    '会改动的文件：',
    files,
    `要求的证据类型：${part.evidence}`,
    ...context,
    '',
    '项目目标：',
    project.goal,
    '',
    '项目的验收标准：',
    acceptance,
    ...retry,
    '',
    '要求：',
    '1. 只做这个部分，不要顺手改别的部分负责的文件。',
    '2. 做完后按结构化结果回报：status（done / needs-user-verification / blocked）、summary、evidence。',
    '3. 证据必须可复现：测试输出、构建结果、命令输出或产物。每条证据以「' +
      part.evidence +
      '：」开头，不要写「我确认过了」。',
    '4. 只有三种情况报 blocked：同一个原因连续失败、缺只有用户能提供的东西、需要改验收标准。',
    '   报 blocked 必须同时给 blockedCondition（repeated-failure / missing-user-input / criteria-change）与 blockedReason（需要用户提供什么）。',
  ].join('\n')
}

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function listOf(value) {
  if (!Array.isArray(value)) return []
  return value.map(trimmedText).filter(Boolean)
}

function slugOf(name) {
  return name.replace(/\s+/g, '-')
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function checkName(name) {
  if (!name) return '项目名不能为空'
  if (/[\r\n]/.test(name)) return '项目名不能包含换行'
  if (BAD_NAME_CHARS.test(name)) {
    return `项目名不能包含 \\ / : * ? " < > | 这些字符：「${name}」`
  }
  if (name === '.' || name === '..') return `项目名不能是「${name}」`
  if (RESERVED_NAME.test(name)) return `「${name}」是系统保留名，不能当目录名`
  return ''
}

function checkGoal(goal) {
  if (!goal) return '目标不能为空'
  for (const line of goal.split(/\r?\n/)) {
    if (HEADING_LINE.test(line)) {
      return '目标里不能有 markdown 标题行（# 开头）：那会把状态文件截断'
    }
    if (PHASE_LINE.test(line)) {
      return '目标里不能有以「阶段：」开头的行：那会和状态字段混淆'
    }
  }
  return ''
}

function checkAcceptance(items) {
  if (items.length === 0) return '至少要有一条验收标准'

  const ids = new Set()
  for (const item of items) {
    const label = item.id ? `${item.id}「${item.text.slice(0, 12)}」` : `「${item.text.slice(0, 12)}」`

    if (!AC_ID.test(item.id)) return `验收标准编号「${item.id}」不合法，应形如 AC-1`
    if (ids.has(item.id)) return `验收标准编号重复：${item.id}`
    ids.add(item.id)

    if (!item.text) return `验收标准 ${label} 缺少正文`
    if (/[\r\n]/.test(item.text)) return `验收标准不能包含换行：${label}`

    const problem = checkCriterionCheck(item, label)
    if (problem) return problem
  }

  return ''
}

/**
 * 每条标准都要能回答「怎么核对」。回答不了，要么写检查，要么明确标成判断型 ——
 * 缺了这两者，验收就只能靠模型自己说。
 */
function checkCriterionCheck(item, label) {
  const check = item.check ?? {}

  if (!check.kind) {
    return `验收标准 ${label} 没有检查：给它一条命令、一条产物断言，或者标成判断型`
  }

  if (check.kind === 'judgement') return ''

  if (check.kind === 'command') {
    if (!check.command) return `验收标准 ${label} 的检查命令是空的`
    if (/[\r\n]/.test(check.command)) return `验收标准 ${label} 的检查命令不能包含换行`
    if (check.command.length > 300) {
      return `验收标准 ${label} 的检查命令太长了，写进脚本里再调用它`
    }
    if (!Number.isInteger(check.expectExit) || check.expectExit < 0) {
      return `验收标准 ${label} 的期望退出码必须是 0 或正整数`
    }
    // 「退出码 0 就算过」是最弱的检查：要么给一条输出断言，要么明说允许空输出。
    if (!check.output && check.allowEmptyOutput !== true) {
      return `验收标准 ${label} 的命令没有任何输出断言：要么给一条「输出匹配」，要么声明「允许空输出：是」`
    }
    return regexProblem(check.output, `验收标准 ${label} 的输出匹配`)
  }

  if (check.kind === 'artifact') {
    if (!check.path) return `验收标准 ${label} 的产物路径是空的`
    if (/[\r\n]/.test(check.path)) return `验收标准 ${label} 的产物路径不能包含换行`
    return regexProblem(check.match, `验收标准 ${label} 的内容匹配`)
  }

  return `验收标准 ${label} 的检查类型「${check.kind}」不认识；只接受 command / artifact / judgement`
}

function regexProblem(pattern, what) {
  if (!pattern) return ''
  try {
    new RegExp(pattern)
  } catch {
    return `${what}不是合法的正则：「${pattern}」`
  }
  return ''
}

/** 省略退出码就是 0；写了个不是整数的东西不是「是 0」，是写错了。 */
function normalizeExitCode(value) {
  if (value === undefined || value === null) return 0
  return Number.isInteger(value) ? value : NaN
}

function normalizeAcceptance(value) {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => ({
    id: trimmedText(item?.id) || `AC-${index + 1}`,
    text: trimmedText(item?.text),
    check: normalizeCheck(item?.check),
  }))
}

function normalizeCheck(check) {
  const kind = trimmedText(check?.kind)

  if (kind === 'command') {
    return {
      kind,
      command: trimmedText(check?.command),
      expectExit: normalizeExitCode(check?.expectExit),
      output: trimmedText(check?.output),
      allowEmptyOutput: check?.allowEmptyOutput === true,
    }
  }

  if (kind === 'artifact') {
    return { kind, path: trimmedText(check?.path), match: trimmedText(check?.match) }
  }

  if (kind === 'judgement') return { kind }

  return { kind }
}

function checkVerify(verify) {
  if (!verify) return ''
  if (/[\r\n]/.test(verify)) return '核对命令不能包含换行'
  if (verify.length > 300) return '核对命令太长了，写进脚本里再调用它'
  return ''
}

function normalizeContract(value) {
  const paths = listOf(value).map(normalizePath).filter(Boolean)
  // 目录也能当契约：它下面所有文件都算验收依据。
  return [...new Set(paths)]
}

function checkContract(paths) {
  for (const path of paths) {
    if (/[\r\n]/.test(path)) return '契约文件路径不能包含换行'
    if (path === '无') return '契约文件路径不能写成「无」'
  }
  return ''
}

function normalizeParts(value) {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => ({
    id: trimmedText(item?.id) || `P${index + 1}`,
    title: trimmedText(item?.title),
    origin: trimmedText(item?.origin),
    dependsOn: listOf(item?.dependsOn),
    files: listOf(item?.files).map(normalizePath),
    evidence: trimmedText(item?.evidence),
    // 覆盖是这部分对应哪几条验收标准：去重，但保留顺序。
    covers: [...new Set(listOf(item?.covers))],
  }))
}

function validatePlan(input) {
  const {
    parts,
    hasOrigin,
    slug = '',
    evidenceTypes = EVIDENCE_TYPES,
    acceptance,
    contract = [],
  } = input ?? {}

  // 参数用对象传：调用点漏传时这里能指名道姓，而不是在某个分支里
  // 抛一句「hasOrigin is not a function」。
  if (!Array.isArray(parts)) throw new Error('validatePlan: parts 必须是数组')
  if (typeof hasOrigin !== 'function') {
    throw new Error('validatePlan: hasOrigin 必须是函数 —— 调用点漏传了')
  }
  if (!Array.isArray(acceptance)) {
    throw new Error('validatePlan: acceptance 必须是数组 —— 调用点漏传了')
  }

  if (parts.length === 0) return '计划里至少要有一个部分'

  const ids = new Set()
  for (const part of parts) {
    if (!PART_ID.test(part.id)) return `部分的编号「${part.id}」不合法，应形如 P1`
    if (ids.has(part.id)) return `部分编号重复：${part.id}`
    ids.add(part.id)
  }

  for (const part of parts) {
    if (!part.title) return `部分 ${part.id} 缺少标题`
    if (/[\r\n]/.test(part.title)) {
      return `部分 ${part.id} 的标题不能包含换行：那会把计划文件写坏`
    }
    if (part.files.length === 0) return `部分 ${part.id} 没有声明涉及的文件集`
    for (const file of part.files) {
      if (/[\r\n]/.test(file)) return `部分 ${part.id} 的文件路径不能包含换行`
      // 「无」是渲染时的占位符，用户真写它会被解析器丢掉，计划就永远读不回来。
      if (file === '无') return `部分 ${part.id} 的文件路径不能写成「无」`

      // 验收依据不许改：改了，检查通过也说明不了什么。
      const touched = contract.find((entry) => pathsOverlap(file, entry.path))
      if (touched) {
        return `部分 ${part.id} 要改契约文件「${touched.path}」：验收依据不许动，换个活法`
      }
    }
    if (!evidenceTypes.includes(part.evidence)) {
      return `部分 ${part.id} 的证据类型「${part.evidence}」不认识；只接受 ${evidenceTypes.join(' / ')}`
    }
    if (part.origin && !hasOrigin(part.origin, slug)) {
      return `部分 ${part.id} 指向的来源「${part.origin}」找不到：先确认 .scratch/ 里的文件名`
    }
  }

  for (const part of parts) {
    for (const dependency of part.dependsOn) {
      if (dependency === '无') return `部分 ${part.id} 的依赖不能写成「无」`
      if (!ids.has(dependency)) return `部分 ${part.id} 依赖了不存在的部分 ${dependency}`
    }
  }

  // 覆盖：每条标准都得有人管。没人管的标准不是「默认通过」，是计划缺陷。
  const criteria = new Map(acceptance.map((item) => [item.id, item]))
  const covered = new Set()

  for (const part of parts) {
    for (const cover of part.covers) {
      if (!AC_ID.test(cover)) {
        return `部分 ${part.id} 的覆盖编号「${cover}」不合法，应形如 AC-1`
      }
      if (!criteria.has(cover)) {
        return `部分 ${part.id} 覆盖了不存在的验收标准 ${cover}：先看看 acceptance.md 里有哪些编号`
      }
      covered.add(cover)
    }
  }

  for (const criterion of acceptance) {
    if (covered.has(criterion.id)) continue
    return `验收标准 ${criterion.id}「${criterion.text}」没有任何部分覆盖：要么把它归给一个部分，要么把它删掉`
  }

  const byId = new Map(parts.map((part) => [part.id, part]))
  const cycle = findCycle(parts, byId)
  if (cycle) return `依赖成环：${cycle.join(' → ')}`

  const overlapping = overlappingPairs(parts)
  if (overlapping.length === 0) return ''

  const ancestorsOf = memoizedAncestors(byId)

  for (const { first, second, file } of overlapping) {
    const ordered =
      ancestorsOf(first.id).has(second.id) || ancestorsOf(second.id).has(first.id)
    if (!ordered) {
      return `部分 ${first.id} 与 ${second.id} 都改 ${file}，却没有先后关系（${first.id} → ${second.id} 或 ${second.id} → ${first.id}）`
    }
  }

  return ''
}

function overlappingPairs(parts) {
  const pairs = []

  for (let left = 0; left < parts.length; left += 1) {
    for (let right = left + 1; right < parts.length; right += 1) {
      const first = parts[left]
      const second = parts[right]
      const shared = first.files.find((one) =>
        second.files.some((other) => pathsOverlap(one, other)),
      )
      if (shared) pairs.push({ first, second, file: shared })
    }
  }

  return pairs
}

/**
 * 两条路径是否落在同一片地方。
 * 相等算重叠，目录与它下面的文件也算 —— 计划里写 `src/auth/` 和 `src/auth/login.js`
 * 的两个部分如果并行，一样会互相踩。
 */
function pathsOverlap(one, other) {
  if (one === other) return true
  return one.startsWith(other + '/') || other.startsWith(one + '/')
}

function memoizedAncestors(byId) {
  const cache = new Map()

  return function ancestorsOf(id) {
    const cached = cache.get(id)
    if (cached) return cached

    const seen = new Set()
    cache.set(id, seen)
    const stack = [...(byId.get(id)?.dependsOn ?? [])]

    while (stack.length > 0) {
      const next = stack.pop()
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(...(byId.get(next)?.dependsOn ?? []))
    }

    return seen
  }
}

function findCycle(parts, byId) {
  const state = new Map()
  const stack = []

  function visit(id) {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }

    state.set(id, 'visiting')
    stack.push(id)

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }

    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const part of parts) {
    const cycle = visit(part.id)
    if (cycle) return cycle
  }
  return null
}

function renderProject({
  name,
  goal,
  phase,
  approvals,
  acceptanceHash,
  verify,
  acceptanceIds = [],
  contract = [],
}) {
  const lines = ['# ' + name, '', `阶段：${phase}`, `格式：${FORMAT_VERSION}`]
  if (acceptanceHash) lines.push(`验收指纹：${acceptanceHash}`)
  lines.push('', '## 目标', '', goal)

  if (verify) lines.push('', '## 核对', '', `命令：${verify}`)

  lines.push(...renderAcceptanceIds(acceptanceIds))
  lines.push(...renderContract(contract))

  if (approvals.length > 0) {
    lines.push('', '## 审批', '')
    for (const record of approvals) {
      lines.push(`- ${record.at} ${LABEL_OF[record.kind]}${record.note ? `：${record.note}` : ''}`)
    }
  }

  return [...lines, ''].join('\n')
}

const LABEL_OF = {
  approved: '批准',
  rejected: '驳回',
  revised: '更新',
  criteria: '验收标准改过',
  contract: '契约指纹更新',
  abandoned: '放弃',
}

/** 编号即身份：退役的编号只在这里留档，不再回到标准里。 */
function renderAcceptanceIds(entries) {
  if (entries.length === 0) return []

  return ['', '## 验收', '', ...entries.map((entry) => `- ${entry.id} ${entry.retired ? '退役' : '在'}`)]
}

function parseAcceptanceIds(body) {
  if (!body) return []

  const entries = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = ACCEPTANCE_ID_LINE.exec(trimmed)
    if (!match) throw new Error(`验收编号记录里有一行认不出来：「${trimmed}」`)
    entries.push({ id: match[1], retired: match[2] === '退役' })
  }
  return entries
}

/** 契约：验收依据的文件指纹。批准时记下，验收前核对 —— 改了就说明证据不再可信。 */
function renderContract(entries) {
  if (entries.length === 0) return []

  return [
    '',
    '## 契约',
    '',
    ...entries.map((entry) => `- ${entry.path}${entry.hash ? ` ${entry.hash}` : ''}`),
  ]
}

const CONTRACT_LINE = /^- (.+?) ([0-9a-f]{4,64})$/

function parseContract(body) {
  if (!body) return []

  const entries = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = CONTRACT_LINE.exec(trimmed)
    if (match) {
      entries.push({ path: normalizePath(match[1]), hash: match[2] })
      continue
    }
    if (trimmed.startsWith('- ')) {
      entries.push({ path: normalizePath(trimmed.slice(2).trim()), hash: '' })
      continue
    }

    throw new Error(`契约记录里有一行认不出来：「${trimmed}」`)
  }

  return entries
}

function sortById(entries) {
  const number = (id) => Number.parseInt(id.replace(/^AC-/, ''), 10)
  return [...entries].sort((left, right) => number(left.id) - number(right.id))
}

/**
 * 把「上次见到的编号」与「这次文件里的编号」对一遍：
 * 消失的编号记为退役，退役的编号再出现就拒绝 —— 覆盖关系绑在编号上，
 * 编号被复用会让一条标准悄悄换掉身份。
 */
function reconcileAcceptanceIds(previous, acceptance) {
  const current = new Set(acceptance.map((item) => item.id))
  const known = new Map(previous.map((entry) => [entry.id, entry.retired]))

  const reused = [...current].filter((id) => known.get(id) === true)
  if (reused.length > 0) {
    return {
      problem: `验收标准编号 ${reused.join('、')} 已经退役：删掉的编号不复用，请改用没出现过的号`,
    }
  }

  const entries = []
  for (const [id, retired] of known) {
    entries.push({ id, retired: retired || !current.has(id) })
  }
  for (const id of current) {
    if (!known.has(id)) entries.push({ id, retired: false })
  }

  return { ids: sortById(entries) }
}

function renderAcceptance(items) {
  const blocks = items.map((item) => {
    const lines = [`## [${item.id}] ${item.text}`, '', `- 检查：${describeCheck(item.check)}`]

    if (item.check.kind === 'command') {
      lines.push(`- 期望退出码：${item.check.expectExit}`)
      if (item.check.output) lines.push(`- 输出匹配：${item.check.output}`)
      if (item.check.allowEmptyOutput) lines.push('- 允许空输出：是')
    }
    if (item.check.kind === 'artifact' && item.check.match) {
      lines.push(`- 内容匹配：${item.check.match}`)
    }

    return lines.join('\n')
  })

  return ['# 验收标准', '', blocks.join('\n\n'), ''].join('\n')
}

/** 检查在文件里的一句话写法：人能读，也能被解析器还原。 */
export function describeCheck(check) {
  if (check?.kind === 'command') return `命令 ${check.command}`
  if (check?.kind === 'artifact') return `产物 ${check.path}`
  return '判断型'
}

/** 一个文件一行、一个依赖一行：不靠分隔符，所以路径里带逗号也不会被拆开。 */
function renderPlan(parts) {
  const blocks = parts.map((part) => {
    const lines = [`## [${part.id}] ${part.title}`, '']

    const dependencies = part.dependsOn.length > 0 ? part.dependsOn : ['无']
    for (const dependency of dependencies) lines.push(`- 依赖：${dependency}`)

    lines.push(`- 证据：${part.evidence}`)
    const covers = part.covers.length > 0 ? part.covers : ['无']
    for (const cover of covers) lines.push(`- 覆盖：${cover}`)
    if (part.origin) lines.push(`- 来源：${part.origin}`)

    const files = part.files.length > 0 ? part.files : ['无']
    for (const file of files) lines.push(`- 文件：${file}`)

    return lines.join('\n')
  })

  return ['# 计划', '', blocks.join('\n\n'), ''].join('\n')
}

function parseProject(source) {
  const nameMatch = /^#[ \t]+(.+)$/m.exec(source)
  if (!nameMatch) throw new Error('缺少标题行「# 项目名」')

  const phaseMatch = /^阶段[：:][ \t]*(\S+)[ \t]*$/m.exec(source)
  if (!phaseMatch) throw new Error('缺少「阶段：」行')

  const goal = sectionBody(source, '目标')
  if (!goal) throw new Error('缺少「## 目标」段')

  const { records, problem } = parseApprovals(source)
  const hashMatch = /^验收指纹[：:][ \t]*(\S+)[ \t]*$/m.exec(source)

  // 核对命令：有它的时候，收尾验收由插件自己跑一遍，不信文本。
  const verifyBody = sectionBody(source, '核对')
  const verifyMatch = verifyBody ? /^命令[：:][ \t]*(.+)$/m.exec(verifyBody) : null

  const formatMatch = /^格式[：:][ \t]*(\d+)[ \t]*$/m.exec(source)

  return {
    name: nameMatch[1].trim(),
    phase: phaseMatch[1],
    goal,
    approvals: records,
    approvalProblem: problem,
    acceptanceHash: hashMatch ? hashMatch[1] : '',
    verify: verifyMatch ? verifyMatch[1].trim() : '',
    acceptanceIds: parseAcceptanceIds(sectionBody(source, '验收')),
    // 没有这一行的是 v1 项目：只能看，要动先迁移。
    formatVersion: formatMatch ? Number(formatMatch[1]) : 0,
    contract: parseContract(sectionBody(source, '契约')),
  }
}

function acceptanceFingerprint(acceptance) {
  // 按编号排序后再算：重排文件不改身份，也不该改指纹。
  return createHash('sha256')
    .update(renderAcceptance(sortById(acceptance)))
    .digest('hex')
    .slice(0, 16)
}

/**
 * 审批记录按行读，认不出的一行不炸掉整个项目，而是记成 approvalProblem ——
 * 之后要靠它判断「计划到底批没批过」，所以也不许被忽略。
 */
function parseApprovals(source) {
  const body = sectionBody(source, '审批')
  if (!body) return { records: [], problem: '' }

  const records = []
  let problem = ''

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = APPROVAL_LINE.exec(trimmed)
    if (!match) {
      problem ||= `审批记录里有一行认不出来：「${trimmed}」`
      continue
    }

    records.push({
      at: match[1],
      kind:
        match[2] === '批准'
          ? 'approved'
          : match[2] === '驳回'
            ? 'rejected'
            : match[2] === '放弃'
              ? 'abandoned'
              : match[2] === '验收标准改过'
                ? 'criteria'
                : match[2] === '契约指纹更新'
                  ? 'contract'
                  : 'revised',
      note: (match[3] ?? '').trim(),
    })
  }

  return { records, problem }
}

/** v1 的验收标准一行一条：读得出来，但只能当判断型标准用。 */
function parseLegacyAcceptance(source) {
  if (source === null || source === undefined) throw new Error('缺少验收标准文件')

  const items = []
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const match = LEGACY_ACCEPTANCE_LINE.exec(trimmed)
    if (!match) throw new Error(`旧格式的验收标准里有一行认不出来：「${trimmed}」`)
    items.push({ id: `AC-${match[1]}`, text: match[2].trim(), check: { kind: 'judgement' } })
  }

  if (items.length === 0) throw new Error('验收标准里一条都没有')
  return items
}

function parseAcceptance(source) {
  if (source === null || source === undefined) throw new Error('缺少验收标准文件')

  const items = []
  let current = null

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '# 验收标准') continue

    const heading = ACCEPTANCE_HEADING.exec(trimmed)
    if (heading) {
      current = { id: heading[1], text: heading[2].trim(), check: { kind: '' } }
      items.push(current)
      continue
    }

    const field = ACCEPTANCE_FIELD.exec(trimmed)
    if (field && current) {
      applyAcceptanceField(current, field[1], field[2].trim())
      continue
    }

    throw new Error(`验收标准里有一行认不出来：「${trimmed}」`)
  }

  if (items.length === 0) throw new Error('验收标准里一条都没有')

  const problem = checkAcceptance(items)
  if (problem) throw new Error(problem)

  return items
}

function applyAcceptanceField(item, name, value) {
  if (name === '检查') {
    if (value === '判断型') {
      item.check = { kind: 'judgement' }
      return
    }
    if (value.startsWith('命令 ')) {
      item.check = { kind: 'command', command: value.slice(3).trim(), expectExit: 0, output: '' }
      return
    }
    if (value.startsWith('产物 ')) {
      item.check = { kind: 'artifact', path: value.slice(3).trim(), match: '' }
      return
    }
    throw new Error(
      `验收标准 ${item.id} 的检查写法认不出来：「${value}」—— 写成「命令 …」「产物 …」或「判断型」`,
    )
  }

  if (item.check.kind === 'command') {
    if (name === '期望退出码') {
      const code = Number(value)
      item.check.expectExit = Number.isInteger(code) ? code : NaN
      return
    }
    if (name === '输出匹配') {
      item.check.output = value
      return
    }
    if (name === '允许空输出') {
      item.check.allowEmptyOutput = value === '是'
      return
    }
  }

  if (item.check.kind === 'artifact' && name === '内容匹配') {
    item.check.match = value
    return
  }

  throw new Error(`验收标准 ${item.id} 里出现了不属于这种检查的字段：「${name}」`)
}

function parsePlan(source, evidenceTypes = EVIDENCE_TYPES, acceptance = [], { validate = true, contract = [] } = {}) {
  if (source === null || source === undefined) return []

  const parts = []
  let current = null

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '# 计划') continue

    const heading = PART_HEADING.exec(trimmed)
    if (heading) {
      current = {
        id: heading[1],
        title: heading[2].trim(),
        origin: '',
        dependsOn: [],
        files: [],
        evidence: '',
        covers: [],
      }
      parts.push(current)
      continue
    }

    const field = PLAN_FIELD.exec(trimmed)
    if (field && current) {
      const value = field[2].trim()

      if (field[1] === '依赖') {
        if (value !== '无') current.dependsOn.push(value)
      } else if (field[1] === '证据') {
        if (current.evidence) throw new Error(`部分 ${current.id} 有多行「证据」`)
        current.evidence = value
      } else if (field[1] === '覆盖') {
        if (value !== '无') current.covers.push(value)
      } else if (field[1] === '来源') {
        current.origin = value
      } else if (value !== '无') {
        current.files.push(normalizePath(value))
      }

      continue
    }

    throw new Error(`计划里有一行认不出来：「${trimmed}」`)
  }

  // 读回时只校验格式：来源文件在提交那一刻校验过，之后被删了也只是引用失效。
  // 迁移旧计划时连覆盖校验都要跳过 —— 旧计划根本没有覆盖关系。
  if (validate) {
    const problem = validatePlan({ parts, hasOrigin: () => true, evidenceTypes, acceptance, contract })
    if (problem) throw new Error(problem)
  }

  return parts
}

function sectionBody(source, heading) {
  const marker = `## ${heading}`
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === marker)
  if (start < 0) return ''

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING_LINE.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join('\n').trim()
}
