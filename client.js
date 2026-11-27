/**
 * 项目面板的浏览器半 —— 手写、零构建，由 DSH 的模块加载器注册。
 *
 * 只做「摊开状态」与「替用户提交三处裁决」：数据与裁决都走宿主半的同源路由，
 * 这里不判定任何项目状态、不直接读文件系统。
 *
 * 样式走组件内注入的 <style> 而不是逐处内联：DSH 宿主对 <button>/<select>
 * 有一套自己的表单控件规则，内联边框会被它盖住（表现为深色硬边），
 * 类名 + !important 才能稳定收口，也才能在 :hover/:focus-visible 上做区分。
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-manager-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'project-panel'
    const NS = 'projectPanel'
    const API = '/manager-panel'
    const POLL_MS = 2000

    // 阶段文案与宿主半 format.js 同一套说法。
    const PHASES = {
      planning: '规划',
      'awaiting-approval': '待批准',
      executing: '执行',
      acceptance: '待收尾验收',
      abandoned: '已放弃',
    }

    const CSS = `
      .pp-page{height:100%;overflow-y:auto;box-sizing:border-box;padding:28px 32px 48px;
        color:var(--dsw-alias-label-primary,inherit);font:inherit}
      .pp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
      .pp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
      .pp-intro{margin:6px 0 0;font-size:13px;line-height:1.6;max-width:56em;
        color:var(--dsw-alias-label-secondary,inherit)}
      .pp-controls{display:flex;align-items:center;gap:8px;flex-shrink:0}
      .pp-label{display:flex;align-items:center;gap:8px;font-size:12px;
        color:var(--dsw-alias-label-secondary,inherit)}
      .pp-picker{position:relative}
      .pp-select{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:12px;max-width:260px;cursor:pointer;
        padding:5px 14px;border-radius:999px !important;
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 50%,transparent) !important;
        background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}
      .pp-select:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 38%,transparent) !important}
      .pp-select-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-caret{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.55}
      .pp-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;min-width:220px;max-width:360px;max-height:320px;overflow:auto;
        padding:6px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 55%,transparent);
        box-shadow:0 10px 28px rgba(0,0,0,.16)}
      .pp-menu-item{display:block;width:100%;text-align:left;font:inherit;font-size:12px;cursor:pointer;
        padding:7px 10px;border:none !important;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit)}
      .pp-menu-item:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent)}
      .pp-menu-item.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent)}
      .pp-menu-path{display:block;margin-top:2px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--dsw-alias-label-secondary,inherit)}
      .pp-select:focus,.pp-btn:focus,.pp-row:focus,.pp-menu-item:focus{outline:none}
      .pp-select:focus-visible,.pp-btn:focus-visible,.pp-menu-item:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent);outline-offset:2px}
      .pp-btn{font:inherit;font-size:12px;cursor:pointer;padding:4px 12px;border-radius:999px !important;
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 55%,transparent) !important;
        background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}
      .pp-btn:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 40%,transparent) !important}
      .pp-btn:disabled{opacity:.55;cursor:default}
      .pp-btn-primary{color:#fff;border-color:transparent !important;
        background:var(--dsw-alias-brand-primary,#4d6bfe)}
      .pp-btn-danger{color:var(--dsw-alias-state-error-primary,#c0392b)}
      .pp-body{display:flex;align-items:flex-start;gap:24px;max-width:1080px}
      .pp-list{width:240px;flex-shrink:0}
      .pp-detail{flex:1;min-width:0}
      .pp-row{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;
        padding:8px 12px;margin-bottom:6px;border-radius:10px;
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 55%,transparent) !important;
        background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);
        transition:border-color .12s ease,background .12s ease}
      .pp-row:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 40%,transparent) !important}
      .pp-row.is-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 70%,transparent) !important;
        background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 7%,var(--dsw-alias-bg-layer-1,transparent))}
      .pp-row:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 45%,transparent);outline-offset:2px}
      .pp-row-name{font-size:13px;font-weight:600}
      .pp-row-meta{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
      .pp-card{border-radius:10px;padding:12px 14px;margin-bottom:10px;
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 55%,transparent);
        background:var(--dsw-alias-bg-layer-1,transparent)}
      .pp-card.pp-gate{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent)}
      .pp-line{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
      .pp-name{font-size:14px;font-weight:600}
      .pp-meta{font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
      .pp-text{margin:6px 0 0;font-size:13px;line-height:1.7;white-space:pre-wrap}
      .pp-problem{margin:4px 0 0;font-size:12px;line-height:1.6;white-space:pre-wrap;
        color:var(--dsw-alias-state-error-primary,#c0392b)}
      .pp-warn{margin:4px 0 0;font-size:12px;line-height:1.6;white-space:pre-wrap;
        color:var(--dsw-alias-state-warn-primary,#a86400)}
      .pp-quiet{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}
      .pp-section{margin:20px 0 8px;font-size:13px;font-weight:600;
        color:var(--dsw-alias-label-secondary,inherit)}
      .pp-evidence{margin:6px 0 0;padding-left:10px;font-size:12px;line-height:1.6;white-space:pre-wrap;
        color:var(--dsw-alias-label-secondary,inherit);
        border-left:2px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 70%,transparent)}
      .pp-actions{display:flex;align-items:center;gap:8px;margin-top:10px}
      .pp-reason{width:100%;box-sizing:border-box;margin-top:8px;padding:8px 10px;border-radius:8px;
        font:inherit;font-size:12px;resize:vertical;min-height:56px;
        color:var(--dsw-alias-label-primary,inherit);
        background:var(--dsw-alias-bg-layer-2,transparent);
        border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1,rgba(128,128,128,.3)) 55%,transparent) !important}
      .pp-reason:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent) !important}
      .pp-result{margin-top:8px;font-size:12px;line-height:1.6}
      .pp-dot{position:absolute;top:-2px;right:-3px;width:6px;height:6px;border-radius:50%;
        background:var(--dsw-alias-brand-primary,#4d6bfe);
        box-shadow:0 0 0 2px var(--dsw-alias-bg-base,transparent)}
      details > summary{cursor:pointer}
    `

    /**
     * 侧栏提示点与面板里的「待你确认」来自同一次读取：共享一个极小的状态。
     * 面板没打开时不会轮询，提示点停留在最后一次读到的结果。
     */
    const attention = { value: false, listeners: new Set() }

    function setAttention(next) {
      if (attention.value === next) return
      attention.value = next
      attention.listeners.forEach(function (listener) {
        listener()
      })
    }

    function useAttention() {
      const [value, setValue] = React.useState(attention.value)
      React.useEffect(function () {
        const listener = function () {
          setValue(attention.value)
        }
        attention.listeners.add(listener)
        listener()
        return function () {
          attention.listeners.delete(listener)
        }
      }, [])
      return value
    }

    function messageOf(error) {
      if (error && typeof error.message === 'string') return error.message
      return String(error)
    }

    function newestFirst(items) {
      return items.slice().sort(function (left, right) {
        const a = left.updatedAt || ''
        const b = right.updatedAt || ''
        if (a === b) return 0
        return a < b ? 1 : -1
      })
    }

    function formatTime(value) {
      if (!value) return '—'
      try {
        return new Date(value).toLocaleString()
      } catch (error) {
        return value
      }
    }

    function evidenceLines(evidence) {
      if (!evidence || evidence.length === 0) return null
      return h(
        'div',
        null,
        evidence.map(function (text, index) {
          return h('p', { key: index, className: 'pp-evidence' }, text)
        }),
      )
    }

    function pendingTitle(item) {
      return item.kind === 'acceptance' ? '收尾验收' : item.partId + '「' + item.title + '」'
    }

    function renderPending(pending) {
      return h(
        'div',
        null,
        h('h2', { className: 'pp-section', style: { marginTop: 0 } }, '待你确认'),
        pending.map(function (item, index) {
          return h(
            'div',
            { key: item.partId + '-' + index, className: 'pp-card' },
            h('div', { className: 'pp-line' }, h('span', { className: 'pp-name' }, pendingTitle(item))),
            item.summary ? h('p', { className: 'pp-text' }, item.summary) : null,
            evidenceLines(item.evidence),
          )
        }),
      )
    }

    function renderCriteria(criteria, retiredCriteria) {
      if (criteria.length === 0) return h('p', { className: 'pp-quiet' }, '还没有验收标准。')
      return h(
        'div',
        null,
        h('h2', { className: 'pp-section' }, '验收标准'),
        criteria.map(function (item) {
          const covering = item.covering.length > 0 ? item.covering.join('、') : '无'
          return h(
            'div',
            { key: item.id, className: 'pp-card' },
            h(
              'div',
              { className: 'pp-line' },
              h('span', { className: 'pp-name' }, item.id),
              h('span', { className: 'pp-meta' }, item.text),
            ),
            h('div', { className: 'pp-meta', style: { marginTop: 4 } }, '检查：' + item.check + ' · 覆盖：' + covering),
            item.pendingApproval
              ? h('div', { className: 'pp-problem' }, '这条的检查改过，还没被批准：派分与验收都会被挡住。')
              : null,
          )
        }),
        retiredCriteria.length > 0
          ? h('p', { className: 'pp-quiet', style: { marginTop: 8 } },
              '已退役的编号（不再使用，也不会被复用）：' + retiredCriteria.join('、'))
          : null,
      )
    }

    function renderParts(parts) {
      if (parts.length === 0) return h('p', { className: 'pp-quiet' }, '还没有计划。')
      return h(
        'div',
        null,
        h('h2', { className: 'pp-section' }, '部分'),
        parts.map(function (part) {
          const dependsOn = part.dependsOn.length > 0 ? part.dependsOn.join('、') : '无'
          return h(
            'div',
            { key: part.id, className: 'pp-card' },
            h(
              'div',
              { className: 'pp-line' },
              h('span', { className: 'pp-name' }, part.id),
              h('span', { className: 'pp-meta' }, part.title),
              h('span', { className: 'pp-meta' }, part.statusLabel),
              h('span', { className: 'pp-meta' }, '重试 ' + part.attempts + ' 次'),
            ),
            h(
              'div',
              { className: 'pp-meta', style: { marginTop: 4 } },
              '证据 ' + part.evidence + ' · 依赖 ' + dependsOn + ' · 文件 ' + (part.files.join('、') || '无'),
            ),
            part.stray.length > 0
              ? h(
                  'div',
                  { className: 'pp-warn' },
                  '越界改动：' + part.stray.join('、') + (part.strayUnreliable ? '（并行期间不可靠，仅供参考）' : ''),
                )
              : null,
          )
        }),
      )
    }

    function renderApprovals(approvals) {
      if (approvals.length === 0) return null
      return h(
        'details',
        { style: { marginTop: 20 } },
        h('summary', { className: 'pp-section', style: { margin: 0 } }, '审批历史（' + approvals.length + '）'),
        h(
          'div',
          { style: { marginTop: 8 } },
          approvals.map(function (record, index) {
            return h(
              'div',
              { key: index, className: 'pp-meta', style: { marginBottom: 4 } },
              formatTime(record.at) + ' · ' + record.kindLabel + (record.note ? '：' + record.note : ''),
            )
          }),
        ),
      )
    }

    function renderFinal(final) {
      const lines = {
        none: '还没到收尾验收：全部部分通过之后才是这一步。',
        'needs-run': '所有部分都验收通过了，但项目还没交付 —— 现在真的跑一遍验收标准（用 manager_accept 记录结果）。',
        'pending-confirmation': '跑过了，结果在等你确认。',
        returned: '上一轮被打回了' + (final.reason ? '：' + final.reason : '。'),
        done: '已确认 —— 项目完成。',
      }
      return h(
        'div',
        { style: { marginTop: 20 } },
        h('h2', { className: 'pp-section' }, '收尾验收'),
        h(
          'div',
          { className: 'pp-card' },
          h('p', { className: 'pp-text' }, lines[final.state] || lines.none),
          final.summary ? h('p', { className: 'pp-text' }, '摘要：' + final.summary) : null,
          evidenceLines(final.evidence),
        ),
      )
    }

    function renderProblems(problems) {
      const keys = Object.keys(problems || {})
      if (keys.length === 0) return null
      return h(
        'div',
        { style: { marginBottom: 12 } },
        keys.map(function (key) {
          return h('p', { key: key, className: 'pp-problem' }, problems[key])
        }),
      )
    }

    /** 当前该出现的裁决：计划审批 / 判断型部分确认 / 收尾验收确认，共用一张卡片。 */
    function gateSpec(detail) {
      if (detail.project.phase === 'awaiting-approval') {
        return {
          title: '等你批准计划',
          text:
            '这份计划包含 ' + detail.parts.length + ' 个部分，覆盖 ' + detail.criteria.length +
            ' 条验收标准。批准之后就会开始派分；打回需要写理由。',
          evidence: [],
          yesLabel: '同意，开始执行',
          noLabel: '打回',
          yes: 'approve',
          no: 'reject',
        }
      }

      const part = (detail.pending || []).find(function (item) {
        return item.kind === 'part'
      })
      if (part) {
        return {
          title: '等你确认：' + part.partId + '「' + part.title + '」',
          text: part.summary || '这个部分已产出材料，等你亲眼确认。',
          evidence: part.evidence,
          yesLabel: '确认完成',
          noLabel: '打回',
          yes: 'confirm',
          no: 'decline',
        }
      }

      if (detail.final && detail.final.state === 'pending-confirmation') {
        return {
          title: '等你确认收尾验收',
          text: detail.final.summary || '整体验收跑过了，等你点头。',
          evidence: detail.final.evidence,
          yesLabel: '确认，项目完成',
          noLabel: '打回',
          yes: 'accept',
          no: 'decline',
        }
      }

      return null
    }

    function renderGate(detail, gate) {
      const spec = gateSpec(detail)
      if (spec === null) return null

      const rejecting = gate.mode === 'reject'

      return h(
        'div',
        { className: 'pp-card pp-gate' },
        h('h2', { className: 'pp-section', style: { marginTop: 0 } }, spec.title),
        h('p', { className: 'pp-text' }, spec.text),
        evidenceLines(spec.evidence),
        rejecting
          ? h(
              'div',
              null,
              h('textarea', {
                className: 'pp-reason',
                placeholder: '打回理由（必填）：哪里不对、要怎么改',
                value: gate.reason,
                onChange: function (event) {
                  gate.setReason(event.target.value)
                },
              }),
              h(
                'div',
                { className: 'pp-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pp-btn pp-btn-danger',
                    disabled: gate.busy || gate.reason.trim() === '',
                    onClick: function () {
                      gate.submit(spec.no)
                    },
                  },
                  '提交打回',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'pp-btn',
                    disabled: gate.busy,
                    onClick: function () {
                      gate.setMode('idle')
                    },
                  },
                  '取消',
                ),
              ),
            )
          : h(
              'div',
              { className: 'pp-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'pp-btn pp-btn-primary',
                  disabled: gate.busy,
                  onClick: function () {
                    gate.submit(spec.yes)
                  },
                },
                gate.busy ? '提交中…' : spec.yesLabel,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pp-btn',
                  disabled: gate.busy,
                  onClick: function () {
                    gate.setMode('reject')
                  },
                },
                spec.noLabel,
              ),
            ),
        gate.result
          ? h(
              'p',
              { className: gate.result.ok ? 'pp-result' : 'pp-result pp-problem' },
              gate.result.ok ? gate.result.text : gate.result.problem,
            )
          : null,
      )
    }

    function renderDetail(detail, gate) {
      return h(
        'div',
        { className: 'pp-detail' },
        renderProblems(detail.problems),
        h(
          'div',
          { className: 'pp-card' },
          h(
            'div',
            { className: 'pp-line' },
            h('span', { className: 'pp-name', style: { fontSize: 16 } }, detail.project.name),
            h('span', { className: 'pp-meta' }, detail.project.phaseLabel),
            h('span', { className: 'pp-meta' }, '最后更新 ' + formatTime(detail.updatedAt)),
          ),
          detail.project.goal ? h('p', { className: 'pp-text' }, detail.project.goal) : null,
        ),
        renderGate(detail, gate),
        // 裁决卡片已经替用户摊开了这一处，列表里就不重复同一件事。
        detail.pending.length > 0 && gateSpec(detail) === null ? renderPending(detail.pending) : null,
        renderCriteria(detail.criteria, detail.retiredCriteria),
        renderParts(detail.parts),
        renderApprovals(detail.approvals),
        renderFinal(detail.final),
      )
    }

    /** 自绘工作区下拉：原生 <select> 的弹出层是浏览器/系统画的，CSS 改不了。 */
    function WorkspacePicker(props) {
      const [open, setOpen] = React.useState(false)
      const boxRef = React.useRef(null)

      React.useEffect(
        function () {
          if (!open) return undefined
          function onPointer(event) {
            if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
          }
          function onKey(event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onPointer)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
          }
        },
        [open],
      )

      const current = props.workspaces.find(function (item) {
        return item.path === props.chosen
      })

      return h(
        'div',
        { className: 'pp-picker', ref: boxRef },
        h(
          'button',
          {
            type: 'button',
            className: 'pp-select',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: function () {
              setOpen(function (value) {
                return !value
              })
            },
          },
          h('span', { className: 'pp-select-label' }, current ? current.title || current.path : '选择工作区'),
          h('span', { className: 'pp-caret', 'aria-hidden': true }),
        ),
        open
          ? h(
              'div',
              { className: 'pp-menu', role: 'listbox' },
              props.workspaces.map(function (item) {
                const active = item.path === props.chosen
                return h(
                  'button',
                  {
                    key: item.workspaceId,
                    type: 'button',
                    role: 'option',
                    'aria-selected': active,
                    className: active ? 'pp-menu-item is-active' : 'pp-menu-item',
                    title: item.path,
                    onClick: function () {
                      props.onPick(item.path)
                      setOpen(false)
                    },
                  },
                  item.title || item.path,
                  h('span', { className: 'pp-menu-path' }, item.path),
                )
              }),
            )
          : null,
      )
    }

    function Panel(props) {
      // 工作区列表来自宿主：面板不猜路径，也不读文件系统。
      const workspaces = props.useWorkspaces(function (snapshot) {
        return snapshot.items
      })

      const [chosen, setChosen] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const [projects, setProjects] = React.useState({ status: 'idle' })
      const [selected, setSelected] = React.useState(null)
      const [detail, setDetail] = React.useState({ status: 'idle' })

      const [gateMode, setGateMode] = React.useState('idle')
      const [gateReason, setGateReason] = React.useState('')
      const [gateBusy, setGateBusy] = React.useState(false)
      const [gateResult, setGateResult] = React.useState(null)

      const refreshNow = React.useCallback(function () {
        setTick(function (value) {
          return value + 1
        })
      }, [])

      // 默认选最近有活动的那个工作区；用户选过之后就不再改它。
      React.useEffect(
        function () {
          if (chosen !== null || workspaces.length === 0) return
          setChosen(newestFirst(workspaces)[0].path)
        },
        [chosen, workspaces],
      )

      // 轮询 + 窗口聚焦即刷 + 手动刷新，都走同一个 tick。
      React.useEffect(function () {
        const id = setInterval(refreshNow, POLL_MS)
        return function () {
          clearInterval(id)
        }
      }, [refreshNow])

      React.useEffect(function () {
        function onFocus() {
          refreshNow()
        }
        window.addEventListener('focus', onFocus)
        return function () {
          window.removeEventListener('focus', onFocus)
        }
      }, [refreshNow])

      React.useEffect(
        function () {
          if (chosen === null) return undefined
          let alive = true
          fetch(API + '/projects?workspace=' + encodeURIComponent(chosen), {
            headers: { accept: 'application/json' },
          })
            .then(function (response) {
              return response.json()
            })
            .then(function (payload) {
              if (!alive) return
              setProjects({ status: 'ready', payload: payload })
              setSelected(function (current) {
                const items = (payload && payload.projects) || []
                if (current !== null && items.some(function (item) { return item.slug === current })) return current
                return items.length > 0 ? items[0].slug : null
              })
            })
            .catch(function (error) {
              if (!alive) return
              setProjects(function (current) {
                // 刷新失败不清空上一次读到的内容，只标成可能过期。
                if (current.status === 'ready' && current.payload) {
                  return { status: 'ready', payload: current.payload, stale: true, problem: messageOf(error) }
                }
                return { status: 'error', problem: messageOf(error) }
              })
            })
          return function () {
            alive = false
          }
        },
        [chosen, tick],
      )

      React.useEffect(
        function () {
          if (chosen === null || selected === null) {
            setDetail({ status: 'idle' })
            return undefined
          }
          let alive = true
          fetch(
            API + '/project?workspace=' + encodeURIComponent(chosen) + '&name=' + encodeURIComponent(selected),
            { headers: { accept: 'application/json' } },
          )
            .then(function (response) {
              return response.json()
            })
            .then(function (payload) {
              if (alive) setDetail({ status: 'ready', payload: payload })
            })
            .catch(function (error) {
              if (!alive) return
              setDetail(function (current) {
                if (current.status === 'ready' && current.payload) {
                  return { status: 'ready', payload: current.payload, stale: true, problem: messageOf(error) }
                }
                return { status: 'error', problem: messageOf(error) }
              })
            })
          return function () {
            alive = false
          }
        },
        [chosen, selected, tick],
      )

      // 侧栏提示点：与面板内「待你确认」判据完全一致，来自同一次读取。
      React.useEffect(
        function () {
          if (detail.status !== 'ready' || !detail.payload || detail.payload.ok !== true) return
          const payload = detail.payload
          const waiting =
            payload.project.phase === 'awaiting-approval' ||
            (payload.pending && payload.pending.length > 0) ||
            (payload.final && payload.final.state === 'pending-confirmation')
          setAttention(waiting === true)
        },
        [detail],
      )

      // 换项目时清掉上一个项目的裁决草稿与结果。
      React.useEffect(
        function () {
          setGateMode('idle')
          setGateReason('')
          setGateResult(null)
        },
        [chosen, selected],
      )

      const submit = React.useCallback(
        function (gate) {
          if (chosen === null || selected === null) return
          setGateBusy(true)
          setGateResult(null)
          fetch(API + '/gate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspace: chosen,
              name: selected,
              gate: gate,
              reason: gateReason.trim(),
            }),
          })
            .then(function (response) {
              return response.json()
            })
            .then(function (payload) {
              setGateBusy(false)
              if (payload && payload.ok === true) {
                setGateMode('idle')
                setGateReason('')
                setGateResult({ ok: true, text: payload.text || '已提交' })
                refreshNow()
              } else {
                setGateResult({ ok: false, problem: (payload && payload.problem) || '提交失败' })
              }
            })
            .catch(function (error) {
              setGateBusy(false)
              setGateResult({ ok: false, problem: messageOf(error) })
            })
        },
        [chosen, selected, gateReason, refreshNow],
      )

      const current = workspaces.find(function (item) {
        return item.path === chosen
      })

      const gate = {
        mode: gateMode,
        reason: gateReason,
        busy: gateBusy,
        result: gateResult,
        setMode: setGateMode,
        setReason: setGateReason,
        submit: submit,
      }

      return h(
        'div',
        { className: 'pp-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'pp-head' },
          h(
            'div',
            null,
            h('h1', { className: 'pp-title' }, '项目面板'),
            h('p', { className: 'pp-intro' }, '一次项目的状态都摊在这里。判定仍归插件，这里只如实显示。'),
          ),
          h(
            'div',
            { className: 'pp-controls' },
            workspaces.length === 0
              ? null
              : h(
                  'label',
                  { className: 'pp-label' },
                  '工作区',
                  h(WorkspacePicker, {
                    workspaces: workspaces,
                    chosen: chosen,
                    onPick: function (path) {
                      setChosen(path)
                      setSelected(null)
                    },
                  }),
                ),
            h('button', { type: 'button', className: 'pp-btn', onClick: refreshNow }, '刷新'),
          ),
        ),
        renderBody({ workspaces, current, projects, selected, setSelected, detail, gate, onRetry: refreshNow }),
      )
    }

    function renderBody(context) {
      if (context.workspaces.length === 0) {
        return h('p', { className: 'pp-quiet' }, '还没有工作区。先在 DSH 里打开一个目录。')
      }
      if (context.projects.status === 'idle' || context.projects.status === 'loading') {
        return h('p', { className: 'pp-quiet' }, '正在读取…')
      }
      if (context.projects.status === 'error') {
        return h(
          'div',
          null,
          h('p', { className: 'pp-problem' }, '读取失败：' + context.projects.problem),
          h('button', { type: 'button', className: 'pp-btn', onClick: context.onRetry }, '重试'),
        )
      }

      const payload = context.projects.payload
      if (!payload || payload.ok !== true) {
        return h('p', { className: 'pp-problem' }, payload && payload.problem ? payload.problem : '读取失败：返回结果读不懂')
      }

      const items = payload.projects || []
      if (items.length === 0) {
        return h(
          'div',
          null,
          h('p', { className: 'pp-meta' }, '工作区：' + (context.current ? context.current.path : '')),
          h('p', { className: 'pp-quiet' }, '这个工作区还没有项目。先在对话里启动一个。'),
        )
      }

      return h(
        'div',
        { className: 'pp-body' },
        h(
          'div',
          { className: 'pp-list' },
          context.projects.stale
            ? h('p', { className: 'pp-warn' }, '最近一次刷新失败，显示的是上一次读到的内容（可能已过期）：' + context.projects.problem)
            : null,
          items.map(function (item) {
            const active = item.slug === context.selected
            return h(
              'button',
              {
                key: item.slug,
                type: 'button',
                className: active ? 'pp-row is-active' : 'pp-row',
                onClick: function () {
                  context.setSelected(item.slug)
                },
              },
              h('div', { className: 'pp-row-name' }, item.ok ? item.name : item.slug),
              h('div', { className: 'pp-row-meta' }, item.ok ? (PHASES[item.phase] || item.phase) : '读不出来'),
              item.ok ? null : h('div', { className: 'pp-problem' }, item.problem),
            )
          }),
        ),
        context.detail.status === 'idle' || context.detail.status === 'loading'
          ? h('div', { className: 'pp-detail' }, h('p', { className: 'pp-quiet' }, '正在读取详情…'))
          : context.detail.status === 'error'
            ? h(
                'div',
                { className: 'pp-detail' },
                h('p', { className: 'pp-problem' }, '读取失败：' + context.detail.problem),
                h('button', { type: 'button', className: 'pp-btn', onClick: context.onRetry }, '重试'),
              )
            : context.detail.payload.ok !== true
              ? h(
                  'div',
                  { className: 'pp-detail' },
                  h('p', { className: 'pp-problem' }, context.detail.payload.problem || '读取失败：返回结果读不懂'),
                  h('button', { type: 'button', className: 'pp-btn', onClick: context.onRetry }, '重试'),
                )
              : h(
                  'div',
                  { className: 'pp-detail' },
                  context.detail.stale
                    ? h('p', { className: 'pp-warn' }, '最近一次刷新失败，显示的是上一次读到的内容（可能已过期）')
                    : null,
                  renderDetail(context.detail.payload, context.gate),
                ),
      )
    }

    function PanelIcon() {
      const waiting = useAttention()
      return h(
        'span',
        { style: { position: 'relative', display: 'block' } },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
          h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M1.5 6h13', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M5.5 6v7.5', stroke: 'currentColor', strokeWidth: 1.2 }),
        ),
        waiting ? h('span', { className: 'pp-dot', 'aria-hidden': true }) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          function () {
            return ctx.locale.register(NS, { zh: { panel: '项目面板' } })
          },
          'project_manager: panel dictionaries',
        )

        const t = ctx.locale.bind(NS)

        // 面板与侧栏条目共用一个 id：点条目就切到这一页。
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Panel)
        })

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: function () {
                return t('panel')
              },
              locale: NS,
            },
            PanelIcon,
          )
        })
      },
    }
  },
})
