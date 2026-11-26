window.__ModuleLoader__.load({
  id: 'dsh-progress-union',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'progressUnion'
    const API = '/progress-union'
    const STATUS_API = '/dsh-progress/status'
    const PANEL_ID = 'progress-union'
    const RIGHT_TAB_ID = 'dsh-progress-union'
    const RIGHT_TAB_KIND = 'progress-union'
    const PROGRESS_EVENT = 'progress-union:changed'

    function broadcastProgress(sessionId, snapshot) {
      if (typeof window === 'undefined' || !snapshot) return
      window.dispatchEvent(new CustomEvent(PROGRESS_EVENT, { detail: { sessionId, snapshot } }))
    }

    // 辅助 LLM 的配置面不在客户端：宿主设置页（设置 → 插件 → dsh-progress-union）
    // 按插件导出的 Config 逐叶子 .volatile() 自动生成表单，本面板只做只读状态展示。

    /*
     * DeepSeek list prices in CNY per 1M tokens (api-docs.deepseek.com,
     * 2026-11). Peak hours are Beijing time Mon–Fri 09:00–12:00 and
     * 14:00–18:00; everything else (including weekends) is idle, at half the
     * peak price. Public holidays are not tracked, so the estimate can be
     * slightly high on a holiday weekday. The bill remains authoritative.
     */
    const TOKEN_PRICING = {
      fallbackModel: 'deepseek-flash',
      models: {
        'deepseek-flash': {
          name: 'DeepSeek-V4.1-Flash',
          peak: { cacheRead: 0.04, input: 2, output: 8 },
          idle: { cacheRead: 0.02, input: 1, output: 4 },
        },
        'deepseek-v4-pro': {
          name: 'DeepSeek-V4-Pro',
          peak: { cacheRead: 0.3, input: 9, output: 27 },
          idle: { cacheRead: 0.15, input: 4.5, output: 13.5 },
        },
      },
    }

    function isPeakNow(now = new Date()) {
      const china = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60 * 1000)
      const day = china.getDay()
      if (day === 0 || day === 6) return false
      const minutes = china.getHours() * 60 + china.getMinutes()
      return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
    }

    function usageTotals(usage) {
      const input = Number(usage?.uncachedInputTokens) || 0
      const cacheRead = Number(usage?.cacheReadTokens) || 0
      const cacheWrite = Number(usage?.cacheWriteTokens) || 0
      const output = Number(usage?.outputTokens) || 0
      return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output }
    }

    function estimateCost(totals, model, peak) {
      const pricing = TOKEN_PRICING.models[model] || TOKEN_PRICING.models[TOKEN_PRICING.fallbackModel]
      const rate = peak ? pricing.peak : pricing.idle
      // Cache writes are billed at the cache-miss input rate on DeepSeek.
      return (
        (totals.input * rate.input +
          totals.cacheRead * rate.cacheRead +
          totals.cacheWrite * rate.input +
          totals.output * rate.output) /
        1e6
      )
    }

    function usageSummary(state) {
      const usage = state?.usage
      if (!usage) return null
      const totals = usageTotals(usage)
      if (totals.total <= 0) return null
      const model = state.model || TOKEN_PRICING.fallbackModel
      const provider = state.provider || ''
      const pricing = TOKEN_PRICING.models[model] || TOKEN_PRICING.models[TOKEN_PRICING.fallbackModel]
      const peak = isPeakNow()
      // DeepSeek is the only route this table prices; other providers show
      // tokens without a currency figure rather than a wrong one.
      const priced = provider === '' || /deepseek/i.test(provider)
      const cost = priced ? estimateCost(totals, model, peak) : null
      return { ...totals, model, displayName: pricing.name, peak, cost, priced }
    }

    function formatTokens(value) {
      if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`
      return String(value)
    }

    function formatCny(value) {
      if (!Number.isFinite(value) || value <= 0) return '¥0'
      return `¥${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
    }

    function usageLabel(view) {
      if (!view) return ''
      const tokens = `${formatTokens(view.total)} tok`
      return view.cost == null ? tokens : `${tokens} · ≈${formatCny(view.cost)}`
    }

    function usageTooltip(view, t) {
      if (!view) return t('usageHint')
      return `${t('usageHint')}\n${view.displayName} · ${view.peak ? t('usagePeak') : t('usageIdle')} · ${t('usageInput')} ${view.input.toLocaleString()} · ${t('usageCache')} ${view.cacheRead.toLocaleString()} · ${t('usageOutput')} ${view.output.toLocaleString()}`
    }

    function useSessionUsage(sessionId, usageApi) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (!sessionId || !usageApi) {
          setState(null)
          return undefined
        }
        let alive = true
        const read = () => {
          if (!alive) return
          try {
            setState(usageApi.read(sessionId))
          } catch (_error) {
            setState(null)
          }
        }
        read()
        const off = usageApi.subscribe(sessionId, read)
        return () => {
          alive = false
          try {
            off?.()
          } catch (_error) {
            // Projection teardown is best-effort.
          }
        }
      }, [sessionId, usageApi])
      return state
    }

    const zh = {
      nav: '进度板',
      title: '进度板',
      subtitle: '你可以直接修改；Agent 只会在下一步读取你改动的那一部分。',
      live: '实时同步',
      saving: '保存中…',
      loading: '正在读取进度…',
      noSessionTitle: '先打开一个会话',
      noSessionBody: '进度板按会话独立保存。在左侧打开一个会话后，这里会显示它的工作进度。',
      emptyTitle: '进度板还是空的',
      emptyBody: '在下面添加任务，或让 Agent 开始工作时用 progress_update 建立任务清单。',
      addPlaceholder: '添加一个可交付的任务…',
      add: '添加',
      adding: '添加中…',
      retry: '重试',
      refresh: '刷新',
      pending: '待同步改动',
      saved: '已持久化',
      memoryOnly: '仅本次运行',
      lastUpdate: '更新于',
      revision: '版本',
      statusTodo: '未开始',
      statusDoing: '进行中',
      statusDone: '已完成',
      statusBlocked: '等待确认',
      doingTitle: '正在做',
      todoTitle: '尚未开始',
      blockedTitle: '等待你确认',
      doneTitle: '已完成',
      overall: '总进度',
      current: '当前动作',
      next: '下一步',
      approach: '当前思路与实现',
      approachPh: '为什么这样做、当前实现路径…',
      note: '备注',
      addNote: '添加备注',
      hideNote: '收起备注',
      titlePh: '任务标题',
      currentPh: '现在在做什么',
      nextPh: '下一步做什么',
      notePh: '假设、阻塞原因、补充说明…',
      delete: '删除',
      confirmDelete: '确认删除',
      moveUp: '上移',
      moveDown: '下移',
      agent: 'Agent',
      you: '你',
      blockedHint: '这些任务在等你确认。Agent 应在对话中提出选项化的问题；你回答后它会恢复。',
      emptyDoing: '当前没有标记为进行中的任务。',
      emptyTodo: '没有待办任务。',
      emptyBlocked: '没有等待确认的任务。',
      readError: '读取进度失败：',
      saveError: '保存失败：',
      storageWarn: '进度存储不可用，当前改动只保存在本次运行中。',
      footerHint: '约每 3 秒同步一次；输入框失焦后自动保存。',
      editHint: '标题、当前动作、下一步和备注都可以直接编辑。',
      doneCount: '项已完成',
      taskCount: '项任务',
      allDone: '全部完成',
      noDoing: '当前没有进行中的任务。',
      blockedCount: '项等待确认',
      percent: '进度',
      dockHint: '点击打开完整进度板',
      dockExpand: '展开',
      dockCollapse: '收起',
      dockEdit: '编辑',
      dockOpenFull: '打开完整进度板',
      dockAllDone: '全部完成',
      llmTitle: '进度辅助 LLM（审查/槽位/轮次）',
      llmOn: '已启用',
      llmOff: '未启用：观察者为规则版（零 LLM 费用）。启用后由辅助模型管理任务槽位、产出续轮建议。',
      llmAuto: '，自动落地',
      llmHint: '配置在「设置 → 插件 → dsh-progress-union」：mode 选 registered 复用 Settings→模型 里的 provider/model（走宿主，免密钥），或 direct 直连自建 OpenAI 兼容端点。仅滞后时触发，每回合至多一次。助手可增删改槽位并产出轮次草案（仅供参考），判断权归主模型。',
      llmSettingsHint: '在设置页修改',
      setTitle: '进度板',
      setLlmGroup: '辅助 LLM（监控/审查）',
      setLlmHint: '选「已注册」复用 Settings→模型 里的 provider/model（走宿主 llm.stream，免密钥）；「直连」打自建 OpenAI 兼容端点。仅在进度板滞后时触发，每回合至多一次。',
      setObserverGroup: '观察者（监控）',
      setObserverHint: '板滞后到什么程度才催办/审查；关掉自动同步后只做提醒，不改 current。',
      setApiGroup: 'API（只读）',
      setApiHint: '同一 builder 双平面出口：进程内 service + HTTP，供压缩类插件只读消费。',
      setMode: '模式',
      setModeOff: '关闭',
      setModeRegistered: '已注册 provider',
      setModeDirect: '直连端点',
      setProvider: '提供方',
      setProviderHint: 'Settings→模型 里的 provider 名（registered 必填）',
      setModel: '模型',
      setBaseUrl: '端点地址',
      setApiKey: 'API 密钥',
      setApiKeyHint: '只写不回显；保存后快照只回布尔 hasApiKey',
      setAuthority: '助手权限',
      setAuthorityBoth: '槽位 + 轮次草案',
      setAuthoritySlots: '只管理槽位',
      setAuthorityRounds: '只产轮次草案',
      setInterval: '最小间隔（毫秒）',
      setIntervalHint: '两次审查之间的最小间隔，默认 90000',
      setAutoApply: '自动落地槽位',
      setObserverEnabled: '启用观察者',
      setMaxIdleSteps: '滞后步数阈值',
      setMaxIdleMs: '滞后时长阈值（毫秒）',
      setAutoSyncCurrent: '自动同步 current',
      setAutoSyncThrottleMs: '自动同步节流（毫秒）',
      setMaxItems: '清单条目上限',
      setSaved: '已保存',
      setFailed: '保存失败',
      setReadOnly: '当前 config 不可写',
      setNoScope: '此宿主未提供设置写入面（configForms），只能从 profile 的 cordis.patch.yml 改配置。',
      setApiService: 'service',
      setApiAnchor: 'HTTP',
      setApiSnapshot: '快照',
      setApiStatus: '迷你条状态',
      etaLeft: '预计剩',
      etaOver: '已超预估',
      staleTag: '中断',
      dockNext: '下一步',
      dockPending: '待同步',
      autoOn: 'Agent 更新：开',
      autoOff: 'Agent 更新：关',
      autoWarn: 'Agent 自动更新已关闭；你在主界面发消息时进度板不会自动更新。',
      autoEnable: '开启自动更新',
      autoHint: '关闭后 Agent 不再加载进度工具；手动编辑仍会保存。',
      usageTotal: '本会话用量',
      usageHint: '本会话累计 token 与按 DeepSeek 公开单价估算的人民币费用；高峰/空闲时段按当前北京时间判断，实际以账单为准。',
      usagePeak: '高峰',
      usageIdle: '空闲',
      usageInput: '输入',
      usageCache: '缓存命中',
      usageOutput: '输出',
      sideCompleted: '已完成的任务',
      sideLatest: '最新完成',
      sideDetails: '详情',
      sideCurrentTask: '当前任务',
      sidePending: '待完成',
      sideCollapse: '收起',
      sideFull: '全面展开',
      lastSync: '同步于',
      syncFailed: '同步失败',
      sideHalf: '恢复半开',
      sideOpenFull: '完整面板',
      sideEditable: '可直接修改',
      sideEmptyDone: '还没有完成的任务',
      sideEmptyPending: '没有待完成的任务',
      sideApproachEmpty: '还没有记录实现思路',
      sideProgress: '进度',
      sideDone: '完成',
      sideAllDone: '其他已完成',
    }

    const en = {
      nav: 'Progress board',
      title: 'Progress board',
      subtitle: 'Edit anything directly; the agent reads only the changed part at its next step.',
      live: 'Live sync',
      saving: 'Saving…',
      loading: 'Loading progress…',
      noSessionTitle: 'Open a session first',
      noSessionBody: 'The board is stored per session. Open a session from the sidebar and its progress will appear here.',
      emptyTitle: 'The board is empty',
      emptyBody: 'Add a task below, or let the agent create the list with progress_update when work starts.',
      addPlaceholder: 'Add a deliverable task…',
      add: 'Add',
      adding: 'Adding…',
      retry: 'Retry',
      refresh: 'Refresh',
      pending: 'Pending edits',
      saved: 'Saved',
      memoryOnly: 'This run only',
      lastUpdate: 'Updated',
      revision: 'Revision',
      statusTodo: 'Not started',
      statusDoing: 'In progress',
      statusDone: 'Done',
      statusBlocked: 'Needs you',
      doingTitle: 'In progress',
      todoTitle: 'Not started',
      blockedTitle: 'Waiting for you',
      doneTitle: 'Done',
      overall: 'Overall',
      current: 'Current',
      next: 'Next',
      approach: 'Approach',
      approachPh: 'Why this way, current implementation path…',
      note: 'Note',
      addNote: 'Add note',
      hideNote: 'Hide note',
      titlePh: 'Task title',
      currentPh: 'What is happening now',
      nextPh: 'What happens next',
      notePh: 'Assumptions, blockers, context…',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      moveUp: 'Move up',
      moveDown: 'Move down',
      agent: 'Agent',
      you: 'You',
      blockedHint: 'These tasks wait for you. The agent should ask an option-based question in chat and resume after your answer.',
      emptyDoing: 'No task is marked in progress.',
      emptyTodo: 'No pending tasks.',
      emptyBlocked: 'Nothing is waiting for you.',
      readError: 'Could not read progress: ',
      saveError: 'Could not save: ',
      storageWarn: 'Progress storage is unavailable; edits live only in this run.',
      footerHint: 'Syncs about every 3 s; edits save when the field loses focus.',
      editHint: 'Title, current, next, and note are directly editable.',
      doneCount: 'done',
      taskCount: 'tasks',
      allDone: 'All done',
      noDoing: 'Nothing is in progress right now.',
      blockedCount: 'waiting for you',
      percent: 'Progress',
      dockHint: 'Open the full progress board',
      dockExpand: 'Expand',
      dockCollapse: 'Collapse',
      dockEdit: 'Edit',
      dockOpenFull: 'Open full board',
      dockAllDone: 'All done',
      llmTitle: 'Progress assistant LLM (audit/slots/rounds)',
      llmOn: 'Enabled',
      llmOff: 'Disabled: the observer is rule-based (zero LLM cost). When enabled, the assistant manages task slots and produces round suggestions.',
      llmAuto: ', auto-applied',
      llmHint: 'Configure in Settings → Plugins → dsh-progress-union: set mode=registered to reuse a provider/model from Settings → Models (via host, no API key), or mode=direct for a self-hosted OpenAI-compatible endpoint. Triggered only while overdue, at most once per turn. The assistant may add/edit/remove slots and emit round suggestions (advice only); the main model decides.',
      llmSettingsHint: 'Change in Settings',
      setTitle: 'Progress board',
      setLlmGroup: 'Assistant LLM (monitor/audit)',
      setLlmHint: 'Pick "Registered" to reuse a provider/model from Settings → Models (via host llm.stream, no API key), or "Direct" for a self-hosted OpenAI-compatible endpoint. Runs only while the board is overdue, at most once per turn.',
      setObserverGroup: 'Observer (monitoring)',
      setObserverHint: 'How overdue the board must be before nudging/auditing; once auto-sync is off the observer only reminds and never edits current.',
      setApiGroup: 'API (read-only)',
      setApiHint: 'One builder, two planes: in-process service plus HTTP, consumed read-only by compaction plugins.',
      setMode: 'Mode',
      setModeOff: 'Off',
      setModeRegistered: 'Registered provider',
      setModeDirect: 'Direct endpoint',
      setProvider: 'Provider',
      setProviderHint: 'Provider name under Settings → Models (required for registered)',
      setModel: 'Model',
      setBaseUrl: 'Endpoint URL',
      setApiKey: 'API key',
      setApiKeyHint: 'Write-only; the snapshot only reports hasApiKey',
      setAuthority: 'Assistant authority',
      setAuthorityBoth: 'Slots + round draft',
      setAuthoritySlots: 'Slots only',
      setAuthorityRounds: 'Round draft only',
      setInterval: 'Min interval (ms)',
      setIntervalHint: 'Minimum gap between two audits, default 90000',
      setAutoApply: 'Auto-apply slot changes',
      setObserverEnabled: 'Enable observer',
      setMaxIdleSteps: 'Overdue step threshold',
      setMaxIdleMs: 'Overdue time threshold (ms)',
      setAutoSyncCurrent: 'Auto-sync current',
      setAutoSyncThrottleMs: 'Auto-sync throttle (ms)',
      setMaxItems: 'Checklist item cap',
      setSaved: 'Saved',
      setFailed: 'Save failed',
      setReadOnly: 'Current config is not writable',
      setNoScope: 'This host exposes no settings write surface (configForms); edit the profile cordis.patch.yml instead.',
      setApiService: 'service',
      setApiAnchor: 'HTTP',
      setApiSnapshot: 'Snapshot',
      setApiStatus: 'Dock status',
      etaLeft: '~',
      etaOver: 'over by',
      staleTag: 'idle',
      dockNext: 'Next',
      dockPending: 'pending',
      autoOn: 'Agent updates: on',
      autoOff: 'Agent updates: off',
      autoWarn: 'Agent auto-update is off; messages sent from the main composer will not refresh the board.',
      autoEnable: 'Turn on auto-update',
      autoHint: 'While off, the agent does not load the progress tool. Manual edits are still saved.',
      usageTotal: 'Session usage',
      usageHint: 'Cumulative session tokens and an RMB estimate at DeepSeek list prices; peak/idle is based on the current Beijing time. The bill is authoritative.',
      usagePeak: 'peak',
      usageIdle: 'idle',
      usageInput: 'input',
      usageCache: 'cache hit',
      usageOutput: 'output',
      sideCompleted: 'Completed',
      sideLatest: 'Latest completed',
      sideDetails: 'Details',
      sideCurrentTask: 'Current task',
      sidePending: 'Pending',
      sideCollapse: 'Collapse',
      sideFull: 'Fullscreen',
      lastSync: 'Synced',
      syncFailed: 'Sync failed',
      sideHalf: 'Half width',
      sideOpenFull: 'Full board',
      sideEditable: 'Editable',
      sideEmptyDone: 'Nothing completed yet',
      sideEmptyPending: 'Nothing pending',
      sideApproachEmpty: 'No approach recorded yet',
      sideProgress: 'Progress',
      sideDone: 'Done',
      sideAllDone: 'Other completed',
    }

    const STATUS_KEYS = ['todo', 'doing', 'done', 'blocked']
    const STATUS_LABEL = {
      todo: 'statusTodo',
      doing: 'statusDoing',
      done: 'statusDone',
      blocked: 'statusBlocked',
    }

    const CSS = `
      .pb-root {
        box-sizing: border-box;
        height: 100%;
        min-height: 100%;
        overflow: auto;
        padding: 28px 32px 56px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5;
      }
      .pb-inner { width: 100%; max-width: 1040px; margin: 0 auto; }
      .pb-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
      .pb-title { margin: 0; font-size: 22px; line-height: 1.25; font-weight: 650; letter-spacing: -.01em; }
      .pb-sub { margin: 6px 0 0; max-width: 680px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .pb-head-right { display: flex; align-items: center; gap: 10px; flex: none; padding-top: 3px; }
      .pb-usage {
        display: flex; align-items: center; gap: 6px; min-width: 0;
        color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4;
      }
      .pb-usage b { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .pb-usage-label { color: var(--dsw-alias-label-tertiary); }
      .pb-usage-cost { color: var(--dsw-alias-brand-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
      .pb-usage-inline {
        flex: none; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 999px; background: var(--dsw-alias-bg-layer-1);
      }
      .pb-side > .pb-usage {
        margin: -4px 0 12px; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1);
      }
      .pb-live { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
      .pb-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }
      .pb-saving { color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .pb-btn {
        appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
        padding: 5px 10px; font: inherit; font-size: 12px; line-height: 1.4; cursor: pointer;
      }
      .pb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
      .pb-btn:disabled { opacity: .42; cursor: not-allowed; }
      .pb-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
      .pb-btn-danger { color: var(--dsw-alias-state-error-primary); }
      .pb-icon-btn { min-width: 28px; padding: 4px 7px; }
      .pb-overview {
        position: relative; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
        background: var(--dsw-alias-bg-layer-1); padding: 18px 20px; margin-bottom: 22px;
      }
      .pb-overview-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
      .pb-big { font-size: 34px; line-height: 1; font-weight: 680; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
      .pb-big small { margin-left: 3px; font-size: 15px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
      .pb-counts { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
      .pb-chip { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); padding: 3px 9px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
      .pb-chip strong { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
      .pb-bar { height: 8px; margin: 15px 0 0; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
      .pb-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
      .pb-focus { display: flex; align-items: center; gap: 9px; margin-top: 13px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .pb-focus b { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .pb-badge-pending { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; font-size: 11px; color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
      .pb-warn {
        margin: 0 0 18px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l1));
        border-radius: 10px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, var(--dsw-alias-bg-layer-1));
        padding: 10px 12px; color: var(--dsw-alias-label-primary); font-size: 12px;
      }
      .pb-warn-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1)); }
      .pb-section { margin-top: 22px; }
      .pb-section-head { display: flex; align-items: baseline; gap: 9px; margin: 0 0 9px; }
      .pb-section-title { margin: 0; font-size: 13px; font-weight: 650; letter-spacing: .01em; }
      .pb-section-count { color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
      .pb-list { display: flex; flex-direction: column; gap: 8px; }
      .pb-item {
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px;
        background: var(--dsw-alias-bg-layer-1); padding: 11px 13px 10px;
      }
      .pb-item.pb-doing { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 38%, var(--dsw-alias-border-l1)); }
      .pb-item.pb-blocked { border-left: 3px solid var(--dsw-alias-state-warn-primary); }
      .pb-item.pb-done { opacity: .72; }
      .pb-item-head { display: grid; grid-template-columns: 98px minmax(0, 1fr) 70px auto; align-items: center; gap: 8px; }
      .pb-status {
        width: 100%; appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        padding: 5px 7px; font: inherit; font-size: 12px; line-height: 1.35;
      }
      .pb-status:focus, .pb-input:focus, .pb-note:focus, .pb-percent input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
      .pb-status.pb-s-doing { color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .pb-status.pb-s-done { color: var(--dsw-alias-state-success-primary); }
      .pb-status.pb-s-blocked { color: var(--dsw-alias-state-warn-primary); }
      .pb-input {
        box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid transparent; border-radius: 7px;
        background: transparent; color: var(--dsw-alias-label-primary); padding: 5px 7px; font: inherit; line-height: 1.4;
      }
      .pb-input:hover { border-color: var(--dsw-alias-border-l1); }
      .pb-input.pb-title-input { font-weight: 600; }
      .pb-input::placeholder, .pb-note::placeholder { color: var(--dsw-alias-label-secondary); opacity: .72; }
      .pb-percent { display: flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .pb-percent input {
        width: 44px; box-sizing: border-box; border: 1px solid transparent; border-radius: 6px;
        background: transparent; color: var(--dsw-alias-label-primary); padding: 3px 2px; font: inherit; font-size: 12px; text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .pb-percent input:hover { border-color: var(--dsw-alias-border-l1); }
      .pb-actions { display: flex; align-items: center; gap: 2px; opacity: .55; transition: opacity .15s; }
      .pb-item:hover .pb-actions, .pb-actions:focus-within { opacity: 1; }
      .pb-subgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin: 5px 0 0 98px; }
      .pb-field-label { display: block; margin: 0 0 1px; color: var(--dsw-alias-label-secondary); font-size: 10px; letter-spacing: .03em; text-transform: uppercase; }
      .pb-approach {
        box-sizing: border-box; width: calc(100% - 98px); min-height: 38px; resize: vertical;
        margin: 6px 0 0 98px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        padding: 6px 8px; font: inherit; font-size: 12px; line-height: 1.45;
      }
      .pb-approach-label { margin: 7px 0 0 98px; }
      .pb-note {
        box-sizing: border-box; width: calc(100% - 98px); min-height: 44px; resize: vertical;
        margin: 6px 0 0 98px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        padding: 6px 8px; font: inherit; font-size: 12px; line-height: 1.45;
      }
      .pb-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 7px 0 0 98px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .pb-meta-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
      .pb-by { border-radius: 999px; background: var(--dsw-alias-bg-layer-2); padding: 1px 6px; }
      .pb-note-toggle { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 1px 0; font: inherit; font-size: 11px; cursor: pointer; }
      .pb-note-toggle:hover { color: var(--dsw-alias-label-primary); }
      .pb-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 22px 18px; text-align: center; background: var(--dsw-alias-bg-layer-1); }
      .pb-empty h2 { margin: 0 0 5px; font-size: 15px; }
      .pb-empty p { margin: 0 auto; max-width: 540px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .pb-add { display: flex; gap: 8px; margin-top: 20px; }
      .pb-add .pb-input { flex: 1; min-width: 0; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); padding: 9px 11px; }
      .pb-add .pb-btn { flex: none; white-space: nowrap; padding: 8px 14px; font-size: 13px; }
      .pb-done-box { margin-top: 22px; }
      .pb-done-box > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 0; user-select: none; }
      .pb-done-box > summary:hover { color: var(--dsw-alias-label-primary); }
      .pb-done-box .pb-list { margin-top: 8px; }
      .pb-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .pb-footer span { white-space: nowrap; }
      .pb-sep { opacity: .45; }
      .pb-blocked-hint { margin: 0 0 8px; color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
      .pb-llm { margin: 10px 0 0; padding: 10px 12px; border: 1px solid rgba(217,119,6,.35); border-left: 3px solid #d97706; border-radius: 8px; background: rgba(217,119,6,.06); }
      .pb-llm-off { opacity: .92; }
      .pb-llm-title { font-size: 12px; font-weight: 650; }
      .pb-llm-line { margin-top: 4px; font-size: 12px; line-height: 1.5; }
      .pb-llm-hint { margin-top: 4px; font-size: 11px; line-height: 1.5; opacity: .75; }
      .pb-set { display: grid; gap: 14px; font-size: 12px; }
      .pb-set-group { display: grid; gap: 8px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; }
      .pb-set-group-title { font-size: 13px; font-weight: 650; }
      .pb-set-group-hint { font-size: 11px; line-height: 1.5; opacity: .68; }
      .pb-set-row { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 4px 12px; align-items: center; }
      .pb-set-label { opacity: .85; }
      .pb-set-control { min-width: 0; display: flex; gap: 6px; align-items: center; }
      .pb-set-control > input[type="text"], .pb-set-control > input[type="password"], .pb-set-control > input[type="number"], .pb-set-control > select { flex: 1; min-width: 0; padding: 5px 8px; font: inherit; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: inherit; }
      .pb-set-control > input[type="checkbox"] { width: 15px; height: 15px; }
      .pb-set-hint { grid-column: 2; font-size: 11px; line-height: 1.5; opacity: .65; }
      .pb-set-banner { padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(217,119,6,.35); background: rgba(217,119,6,.08); font-size: 12px; line-height: 1.5; }
      .pb-set-status { font-size: 12px; opacity: .75; }
      .pb-set-api { display: grid; gap: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: .85; word-break: break-all; }
      .pb-set-api b { font-weight: 600; opacity: .8; margin-right: 6px; }
      .pb-header-btn {
        display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
        border: 1px solid transparent; border-radius: 6px; background: transparent;
        color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 0;
      }
      .pb-header-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .pb-dock-wrap { display: flex; justify-content: center; width: 100%; }
      .pb-dock {
        box-sizing: border-box; width: calc(100% + var(--dsh-composer-dock-inset, 8px) + var(--dsh-composer-dock-inset, 8px) + var(--dsh-composer-dock-inset, 8px) + var(--dsh-composer-dock-inset, 8px));
        max-width: var(--dsh-composer-card-max-width, none);
        flex: none;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 7px 9px;
        color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px;
      }
      .pb-dock-row { display: flex; align-items: center; gap: 9px; }
      .pb-dock-main {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px;
        border: 0; background: transparent; color: inherit; font: inherit; padding: 0;
        cursor: pointer; text-align: left;
      }
      .pb-dock-main:hover .pb-dock-title { color: var(--dsw-alias-brand-primary); }
      .pb-dock-percent { flex: none; min-width: 34px; font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .pb-dock-bar { flex: none; width: 64px; height: 5px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
      .pb-dock-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
      .pb-dock-body { flex: 1; min-width: 0; line-height: 1.3; }
      .pb-dock-title { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; font-weight: 600; transition: color .15s; }
      .pb-dock-sub { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .pb-dock-actions { flex: none; display: flex; align-items: center; gap: 4px; }
      .pb-dock-btn {
        appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary);
        padding: 2px 7px; font: inherit; font-size: 11px; line-height: 1.4; cursor: pointer;
      }
      .pb-dock-btn:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
      .pb-dock-expanded {
        display: flex; flex-direction: column; gap: 3px; margin-top: 7px; padding-top: 7px;
        border-top: 1px solid var(--dsw-alias-border-l1); max-height: 180px; overflow: auto;
      }
      .pb-dock-item { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 3px 1px; }
      .pb-dock-dot { flex: none; width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-state-idle-primary); }
      .pb-dock-dot.doing { background: var(--dsw-alias-brand-primary); }
      .pb-dock-dot.done { background: var(--dsw-alias-state-success-primary); }
      .pb-dock-dot.blocked { background: var(--dsw-alias-state-warn-primary); }
      .pb-dock-item-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
      .pb-dock-item-meta { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
      .pb-dock-more { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); padding: 4px 1px; font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
      .pb-side {
        box-sizing: border-box; height: 100%; overflow: auto; padding: 14px 14px 28px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
        font-family: inherit; font-size: 13px; line-height: 1.45;
      }
      .pb-side-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
      .pb-side-head-actions { display: flex; align-items: center; gap: 4px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
      .pb-side-title { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
      .pb-side-sub { margin: 3px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.4; }
      .pb-side-section { margin-top: 15px; }
      .pb-side-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--dsw-alias-label-secondary); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
      .pb-side-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); padding: 9px 10px; }
      .pb-side-card + .pb-side-card { margin-top: 6px; }
      .pb-side-done-card { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, var(--dsw-alias-border-l1)); }
      .pb-side-check { color: var(--dsw-alias-state-success-primary); font-weight: 700; }
      .pb-side-done-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; font-weight: 600; }
      .pb-side-meta { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
      .pb-side-note { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
      .pb-side-bar { height: 5px; margin-top: 7px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); }
      .pb-side-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
      .pb-side-task-head { display: flex; align-items: center; gap: 5px; }
      .pb-side-task-head .pb-status { flex: none; width: 88px; }
      .pb-side-task-head .pb-input { flex: 1; font-weight: 600; }
      .pb-side-task-head .pb-percent { flex: none; }
      .pb-side-field { display: block; margin-top: 6px; }
      .pb-side-field .pb-field-label { margin-bottom: 2px; }
      .pb-side-input, .pb-side-textarea {
        box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        padding: 5px 7px; font: inherit; font-size: 12px; line-height: 1.45;
      }
      .pb-side-textarea { min-height: 48px; resize: vertical; }
      .pb-side-input:focus, .pb-side-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
      .pb-side-done-all { margin-top: 6px; }
      .pb-side-done-all > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11px; padding: 4px 0; user-select: none; }
      .pb-side-done-all > summary:hover { color: var(--dsw-alias-label-primary); }
      .pb-side-done-item { border-top: 1px solid var(--dsw-alias-border-l1); padding: 5px 0; }
      .pb-side-done-item > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; }
      .pb-side-done-item > summary::-webkit-details-marker { display: none; }
      .pb-side-done-item .pb-side-done-title { font-weight: 500; font-size: 11px; }
      .pb-side-done-item .pb-side-detail-line, .pb-side-done-item .pb-side-note { margin-left: 12px; }
      .pb-side-detail-line { margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
      .pb-side-detail-line b { color: var(--dsw-alias-label-primary); font-weight: 600; }
      .pb-side-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 9px; padding: 12px 10px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .pb-side-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 16px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .pb-side-link { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); padding: 0; font: inherit; font-size: 11px; cursor: pointer; }
      .pb-side-error { margin-bottom: 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1)); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1)); padding: 7px 8px; color: var(--dsw-alias-label-primary); font-size: 11px; }
      .pb-loading { padding: 46px 0; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
      @media (max-width: 760px) {
        .pb-dock-bar { display: none; }
        .pb-dock-sub { max-width: 42vw; }
        .pb-root { padding: 20px 16px 44px; }
        .pb-head { flex-direction: column; gap: 10px; }
        .pb-overview-top { align-items: flex-start; flex-direction: column; gap: 10px; }
        .pb-counts { justify-content: flex-start; }
        .pb-item-head { grid-template-columns: 92px minmax(0, 1fr) 64px; }
        .pb-actions { grid-column: 1 / -1; justify-content: flex-end; }
        .pb-subgrid { grid-template-columns: 1fr; margin-left: 0; }
        .pb-approach { width: 100%; margin-left: 0; }
        .pb-approach-label { margin-left: 0; }
        .pb-note { width: 100%; margin-left: 0; }
        .pb-meta { margin-left: 0; }
        .pb-side { padding: 12px 10px 24px; }
        .pb-side-task-head { flex-wrap: wrap; }
        .pb-side-task-head .pb-status { width: 100%; }
      }
    `

    function makeT(props) {
      return (key) => {
        try {
          const value = props.t ? props.t(key) : undefined
          if (typeof value === 'string' && value) return value
        } catch (_error) {
          // Fall through to the built-in Chinese dictionary.
        }
        return zh[key] || key
      }
    }

    function statusLabel(t, status) {
      return t(STATUS_LABEL[status] || status)
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function postChanges(sessionId, expectedRevision, changes) {
      const response = await fetch(`${API}/action`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, expectedRevision, changes }),
      })
      const body = await response.json().catch(() => null)
      return { response, body }
    }

    async function setPanelActive(sessionId, active, source = 'panel') {
      try {
        const response = await fetch(`${API}/active`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, active, source }),
        })
        return await response.json().catch(() => null)
      } catch (_error) {
        // The board still works; only automatic Agent updates are unavailable.
        return null
      }
    }

    /** Persist "the agent should keep this board up to date" for one session. */
    async function setAgentEnabled(sessionId, enabled) {
      const body = await setPanelActive(sessionId, enabled, 'user')
      return body && body.ok === true ? body : null
    }

    function ProgressNavIcon({ size = 20 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M4 7.2h8.2M4 12h11.2M4 16.8h6.2',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 18.1, cy: 7.2, r: 2.25, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', {
          d: 'M17.2 7.2l.7.7 1.4-1.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 18.1, cy: 16.8, r: 2.25, stroke: 'currentColor', strokeWidth: 1.7 }),
      )
    }

    function ProgressHeaderButton(props) {
      const t = makeT(props)
      return h(
        'button',
        {
          type: 'button',
          className: 'pb-header-btn',
          title: t('nav'),
          'aria-label': t('nav'),
          onClick: () => {
            try {
              props.openPanel?.()
            } catch (_error) {
              // The mini bar and sidebar remain available.
            }
          },
        },
        h(ProgressNavIcon, { size: 17 }),
      )
    }

    function EditableText({ value, placeholder, onCommit, multiline, className, disabled, ariaLabel }) {
      const [draft, setDraft] = useState(value || '')
      const [focused, setFocused] = useState(false)
      useEffect(() => {
        if (!focused) setDraft(value || '')
      }, [value, focused])

      const commit = () => {
        setFocused(false)
        const next = draft.trim()
        setDraft(next)
        if (next !== (value || '')) onCommit(next)
      }

      const shared = {
        value: draft,
        placeholder,
        disabled,
        className,
        'aria-label': ariaLabel || placeholder,
        onFocus: () => setFocused(true),
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
      }

      if (multiline) {
        return h('textarea', {
          ...shared,
          rows: 2,
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              setDraft(value || '')
              event.currentTarget.blur()
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              event.currentTarget.blur()
            }
          },
        })
      }

      return h('input', {
        ...shared,
        type: 'text',
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            setDraft(value || '')
            event.currentTarget.blur()
          }
        },
      })
    }

    function PercentEditor({ value, onCommit, disabled, label }) {
      const [draft, setDraft] = useState(String(value))
      const [focused, setFocused] = useState(false)
      useEffect(() => {
        if (!focused) setDraft(String(value))
      }, [value, focused])

      const commit = () => {
        setFocused(false)
        const number = Number(draft)
        if (!Number.isFinite(number)) {
          setDraft(String(value))
          return
        }
        const next = Math.max(0, Math.min(100, Math.round(number)))
        setDraft(String(next))
        if (next !== value) onCommit(next)
      }

      return h(
        'label',
        { className: 'pb-percent', title: label },
        h('input', {
          type: 'number',
          min: 0,
          max: 100,
          step: 1,
          value: draft,
          disabled,
          'aria-label': label,
          onFocus: () => setFocused(true),
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          },
        }),
        h('span', null, '%'),
      )
    }

    function ItemCard({ item, t, disabled, canMoveUp, canMoveDown, onPatch, onRemove, onMove }) {
      const [showNote, setShowNote] = useState(Boolean(item.note))
      const [confirmDelete, setConfirmDelete] = useState(false)
      useEffect(() => {
        if (item.note) setShowNote(true)
      }, [item.note])
      useEffect(() => {
        setConfirmDelete(false)
      }, [item.status, item.title])

      return h(
        'article',
        { className: `pb-item pb-${item.status}` },
        h(
          'div',
          { className: 'pb-item-head' },
          h(
            'select',
            {
              className: `pb-status pb-s-${item.status}`,
              value: item.status,
              disabled,
              'aria-label': t('statusTodo'),
              onChange: (event) => onPatch({ status: event.target.value }),
            },
            STATUS_KEYS.map((status) =>
              h('option', { key: status, value: status }, statusLabel(t, status)),
            ),
          ),
          h(EditableText, {
            value: item.title,
            placeholder: t('titlePh'),
            disabled,
            className: 'pb-input pb-title-input',
            ariaLabel: t('titlePh'),
            onCommit: (value) => onPatch({ title: value }),
          }),
          h(PercentEditor, {
            value: item.percent,
            disabled,
            label: t('percent'),
            onCommit: (value) => onPatch({ percent: value }),
          }),
          h(
            'div',
            { className: 'pb-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn pb-icon-btn',
                title: t('moveUp'),
                'aria-label': t('moveUp'),
                disabled: disabled || !canMoveUp,
                onClick: () => onMove(-1),
              },
              '↑',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn pb-icon-btn',
                title: t('moveDown'),
                'aria-label': t('moveDown'),
                disabled: disabled || !canMoveDown,
                onClick: () => onMove(1),
              },
              '↓',
            ),
            h(
              'button',
              {
                type: 'button',
                className: `pb-btn pb-icon-btn ${confirmDelete ? 'pb-btn-danger' : ''}`,
                title: confirmDelete ? t('confirmDelete') : t('delete'),
                'aria-label': confirmDelete ? t('confirmDelete') : t('delete'),
                disabled,
                onClick: () => {
                  if (confirmDelete) {
                    setConfirmDelete(false)
                    onRemove()
                  } else {
                    setConfirmDelete(true)
                  }
                },
              },
              confirmDelete ? '!' : '×',
            ),
          ),
        ),
        h(
          'div',
          { className: 'pb-subgrid' },
          h(
            'label',
            null,
            h('span', { className: 'pb-field-label' }, t('current')),
            h(EditableText, {
              value: item.current,
              placeholder: t('currentPh'),
              disabled,
              className: 'pb-input',
              ariaLabel: t('current'),
              onCommit: (value) => onPatch({ current: value }),
            }),
          ),
          h(
            'label',
            null,
            h('span', { className: 'pb-field-label' }, t('next')),
            h(EditableText, {
              value: item.next,
              placeholder: t('nextPh'),
              disabled,
              className: 'pb-input',
              ariaLabel: t('next'),
              onCommit: (value) => onPatch({ next: value }),
            }),
          ),
        ),
        h(
          'label',
          { className: 'pb-approach-label' },
          h('span', { className: 'pb-field-label' }, t('approach')),
          h(EditableText, {
            value: item.approach || '',
            placeholder: t('approachPh'),
            disabled,
            multiline: true,
            className: 'pb-approach',
            ariaLabel: t('approach'),
            onCommit: (value) => onPatch({ approach: value }),
          }),
        ),
        showNote
          ? h(EditableText, {
              value: item.note,
              placeholder: t('notePh'),
              disabled,
              multiline: true,
              className: 'pb-note',
              ariaLabel: t('note'),
              onCommit: (value) => onPatch({ note: value }),
            })
          : null,
        h(
          'div',
          { className: 'pb-meta' },
          h(
            'div',
            { className: 'pb-meta-left' },
            h('span', { className: 'pb-by' }, item.updatedBy === 'user' ? t('you') : t('agent')),
            h('span', null, new Date(item.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-note-toggle',
                onClick: () => setShowNote((visible) => !visible),
              },
              showNote ? t('hideNote') : t('addNote'),
            ),
          ),
          h('span', null, `${item.percent}%`),
        ),
      )
    }

    function AddTask({ t, disabled, onAdd }) {
      const [title, setTitle] = useState('')
      const [adding, setAdding] = useState(false)

      const submit = async (event) => {
        event.preventDefault()
        const next = title.trim()
        if (!next || adding) return
        setAdding(true)
        try {
          const ok = await onAdd(next)
          if (ok) setTitle('')
        } finally {
          setAdding(false)
        }
      }

      return h(
        'form',
        { className: 'pb-add', onSubmit: submit },
        h('input', {
          className: 'pb-input',
          type: 'text',
          value: title,
          placeholder: t('addPlaceholder'),
          disabled: disabled || adding,
          'aria-label': t('addPlaceholder'),
          onChange: (event) => setTitle(event.target.value),
        }),
        h(
          'button',
          { className: 'pb-btn pb-btn-primary', type: 'submit', disabled: disabled || adding || !title.trim() },
          adding ? t('adding') : t('add'),
        ),
      )
    }

    function Section({ title, count, hint, children }) {
      return h(
        'section',
        { className: 'pb-section' },
        h(
          'div',
          { className: 'pb-section-head' },
          h('h2', { className: 'pb-section-title' }, title),
          h('span', { className: 'pb-section-count' }, String(count)),
        ),
        hint ? h('p', { className: 'pb-blocked-hint' }, hint) : null,
        h('div', { className: 'pb-list' }, children),
      )
    }

    function useProgressData(sessionId) {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [lastSyncAt, setLastSyncAt] = useState(0)
      const [refreshTick, setRefreshTick] = useState(0)
      const sessionRef = useRef(sessionId)

      useEffect(() => {
        if (!sessionId) {
          sessionRef.current = undefined
          setSnapshot(null)
          setError('')
          setLastSyncAt(0)
          return undefined
        }

        const sessionChanged = sessionRef.current !== sessionId
        sessionRef.current = sessionId
        if (sessionChanged) {
          setSnapshot(null)
          setLastSyncAt(0)
        }
        setError('')

        let active = true
        let controller

        const load = async () => {
          if (controller) controller.abort()
          const ownController = (controller = new AbortController())
          try {
            const response = await fetch(
              `${API}/snapshot?sessionId=${encodeURIComponent(sessionId)}`,
              { credentials: 'same-origin', cache: 'no-store', signal: ownController.signal },
            )
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            if (!active) return
            setSnapshot(next)
            setError('')
            setLastSyncAt(Date.now())
          } catch (caught) {
            if (!active || caught?.name === 'AbortError') return
            setError(errorText(caught))
          }
        }

        const onProgressChange = (event) => {
          const detail = event.detail
          if (!detail || detail.sessionId !== sessionId || !detail.snapshot) return
          setSnapshot(detail.snapshot)
          setError('')
          setLastSyncAt(Date.now())
        }
        window.addEventListener(PROGRESS_EVENT, onProgressChange)

        load()
        const interval = window.setInterval(load, 3000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
          active = false
          window.clearInterval(interval)
          controller?.abort()
          window.removeEventListener(PROGRESS_EVENT, onProgressChange)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, refreshTick])

      return {
        snapshot,
        setSnapshot,
        error,
        lastSyncAt,
        refresh: () => setRefreshTick((value) => value + 1),
      }
    }

    /*
     * 鲸程时间面：轮询 /dsh-progress/status 取本会话活跃任务的 etaMin/overMin/
     * staleMin——板给语义（到哪一步），时间层给还要多久。失败静默（只少一行）。
     */
    function useUnionTiming(sessionId) {
      const [timing, setTiming] = useState(null)
      useEffect(() => {
        if (!sessionId) {
          setTiming(null)
          return undefined
        }
        let active = true
        const load = async () => {
          try {
            const response = await fetch(STATUS_API, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!active) return
            const list = Array.isArray(body.tasks) ? body.tasks : []
            const mine = list.find((x) => x && String(x.id) === String(sessionId)) || (body.task && body.task.id ? body.task : list[0])
            setTiming(mine ? { steps: mine.steps || 0, etaMin: mine.etaMin || 0, overMin: mine.overMin || 0, staleMin: mine.staleMin || 0, etaBasis: mine.etaBasis || 'prior', elapsedSec: mine.elapsedSec || 0 } : null)
          } catch (_caught) {
            // 时间面缺席不影响板本体（capability absence 降级）
          }
        }
        load()
        const interval = window.setInterval(load, 3000)
        return () => {
          active = false
          window.clearInterval(interval)
        }
      }, [sessionId])
      return timing
    }

    function ProgressDock(props) {
      const t = makeT(props)
      const { sessionId } = props
      const { snapshot, error: readError, refresh } = useProgressData(sessionId)
      const timing = useUnionTiming(sessionId)
      const usageView = usageSummary(useSessionUsage(sessionId, props.usage))
      const [expanded, setExpanded] = useState(false)

      useEffect(() => {
        setExpanded(false)
      }, [sessionId])

      if (!sessionId || !snapshot || !snapshot.items || snapshot.items.length === 0) return null

      const summary = snapshot.summary || { total: 0, done: 0, doing: 0, todo: 0, blocked: 0, percent: 0 }
      const items = snapshot.items
      const doing = items.find((item) => item.status === 'doing')
      const blocked = items.find((item) => item.status === 'blocked')
      const todo = items.find((item) => item.status === "todo")

      let focusLine = t('dockAllDone')
      if (doing) focusLine = `${t('doingTitle')}：${doing.title}`
      else if (blocked) focusLine = `${t('blockedTitle')}：${blocked.title}`
      else if (todo) focusLine = `${t('dockNext')}：${todo.title}`

      const sub = [`${summary.done}/${summary.total} ${t('doneCount')}`]
      if (summary.blocked) sub.push(`${summary.blocked} ${t('blockedCount')}`)
      if (timing && timing.overMin > 0) sub.push(`${t('etaOver')} ${timing.overMin} min`)
      else if (timing && timing.staleMin > 0) sub.push(`${t('staleTag')} ${timing.staleMin} min`)
      else if (timing && timing.etaMin > 0) sub.push(`${t('etaLeft')} ${timing.etaMin} min`)
      if (snapshot.pendingUserChanges) sub.push(`${snapshot.pendingUserChanges} ${t('dockPending')}`)
      if (snapshot.enabled === false) sub.push(t('autoOff'))
      if (usageView) sub.splice(1, 0, usageLabel(usageView))
      if (readError) sub.push(t('syncFailed'))
      sub.push(t('dockHint'))

      const enableAuto = async () => {
        await setAgentEnabled(sessionId, true)
        refresh()
      }

      const openPanel = () => {
        try {
          props.openPanel?.()
        } catch (_error) {
          // The full panel remains reachable from the sidebar.
        }
      }

      const togglePanel = () => {
        try {
          props.togglePanel?.()
        } catch (_error) {
          // The right sidebar chrome remains available.
        }
      }

      const priority = { doing: 0, blocked: 1, todo: 2, done: 3 }
      const ordered = items
        .slice()
        .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || a.order - b.order)
        .slice(0, 8)

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'div',
          { className: 'pb-dock-wrap' },
          h(
            'div',
            { className: 'pb-dock' },
            h(
              'div',
              { className: 'pb-dock-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'pb-dock-main',
                title: t('dockHint'),
                onClick: togglePanel,
              },
              h('span', { className: 'pb-dock-percent' }, `${summary.percent}%`),
              h('span', { className: 'pb-dock-bar' }, h('i', { style: { width: `${summary.percent}%` } })),
              h(
                'span',
                { className: 'pb-dock-body' },
                h('span', { className: 'pb-dock-title' }, focusLine),
                h('span', { className: 'pb-dock-sub', title: usageView ? usageTooltip(usageView, t) : undefined }, sub.join(' · ')),
              ),
            ),
            h(
              'div',
              { className: 'pb-dock-actions' },
              readError
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'pb-dock-btn',
                      title: t('refresh'),
                      'aria-label': t('refresh'),
                      onClick: refresh,
                    },
                    '↻',
                  )
                : null,
              snapshot.enabled === false
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'pb-dock-btn pb-dock-enable',
                      title: t('autoHint'),
                      onClick: enableAuto,
                    },
                    t('autoEnable'),
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'pb-dock-btn',
                  onClick: () => setExpanded((value) => !value),
                },
                expanded ? t('dockCollapse') : t('dockExpand'),
              ),
              h(
                'button',
                { type: 'button', className: 'pb-dock-btn', onClick: openPanel },
                t('dockEdit'),
              ),
            ),
          ),
          expanded
            ? h(
                'div',
                { className: 'pb-dock-expanded' },
                ordered.map((item) =>
                  h(
                    'div',
                    { key: item.id, className: 'pb-dock-item' },
                    h('i', { className: `pb-dock-dot ${item.status}` }),
                    h('span', { className: 'pb-dock-item-title' }, item.title),
                    h('span', { className: 'pb-dock-item-meta' }, `${item.percent}%`),
                  ),
                ),
                h(
                  'button',
                  { type: 'button', className: 'pb-dock-more', onClick: openPanel },
                  t('dockOpenFull'),
                ),
              )
            : null,
          ),
        ),
      )
    }

    function SideTaskEditor({ item, t, disabled, onPatch }) {
      const [showNote, setShowNote] = useState(Boolean(item.note))
      useEffect(() => {
        if (item.note) setShowNote(true)
      }, [item.note])

      return h(
        'div',
        { className: 'pb-side-card' },
        h(
          'div',
          { className: 'pb-side-task-head' },
          h(
            'select',
            {
              className: `pb-status pb-s-${item.status}`,
              value: item.status,
              disabled,
              'aria-label': t('statusTodo'),
              onChange: (event) => onPatch({ status: event.target.value }),
            },
            STATUS_KEYS.map((status) => h('option', { key: status, value: status }, statusLabel(t, status))),
          ),
          h(EditableText, {
            value: item.title,
            placeholder: t('titlePh'),
            disabled,
            className: 'pb-side-input',
            ariaLabel: t('titlePh'),
            onCommit: (value) => onPatch({ title: value }),
          }),
          h(PercentEditor, {
            value: item.percent,
            disabled,
            label: t('percent'),
            onCommit: (value) => onPatch({ percent: value }),
          }),
        ),
        h('div', { className: 'pb-side-bar' }, h('i', { style: { width: `${item.percent}%` } })),
        h(
          'label',
          { className: 'pb-side-field' },
          h('span', { className: 'pb-field-label' }, t('current')),
          h(EditableText, {
            value: item.current,
            placeholder: t('currentPh'),
            disabled,
            className: 'pb-side-input',
            ariaLabel: t('current'),
            onCommit: (value) => onPatch({ current: value }),
          }),
        ),
        h(
          'label',
          { className: 'pb-side-field' },
          h('span', { className: 'pb-field-label' }, t('approach')),
          h(EditableText, {
            value: item.approach || '',
            placeholder: t('approachPh'),
            disabled,
            multiline: true,
            className: 'pb-side-textarea',
            ariaLabel: t('approach'),
            onCommit: (value) => onPatch({ approach: value }),
          }),
        ),
        h(
          'label',
          { className: 'pb-side-field' },
          h('span', { className: 'pb-field-label' }, t('next')),
          h(EditableText, {
            value: item.next,
            placeholder: t('nextPh'),
            disabled,
            className: 'pb-side-input',
            ariaLabel: t('next'),
            onCommit: (value) => onPatch({ next: value }),
          }),
        ),
        showNote
          ? h(EditableText, {
              value: item.note,
              placeholder: t('notePh'),
              disabled,
              multiline: true,
              className: 'pb-side-textarea',
              ariaLabel: t('note'),
              onCommit: (value) => onPatch({ note: value }),
            })
          : h(
              'button',
              {
                type: 'button',
                className: 'pb-side-link',
                style: { marginTop: '6px' },
                onClick: () => setShowNote(true),
              },
              t('addNote'),
            ),
      )
    }

    // 只读状态行：配置面归宿主设置页（设置 → 插件 → dsh-progress-union），
    // 侧边栏不再放编辑表单（避免两处写同一命名空间）。
    function LlmAssistNotice(props) {
      const t = makeT(props)
      const a = props.assistant
      if (!a) return null
      const on = a.enabled === true
      const every = Math.max(1, Math.round((a.minIntervalMs || 0) / 60000))
      const line = on
        ? (a.mode === 'registered'
            ? `${t('llmOn')}：${a.provider} · ${a.model}（≤${every} min/次${a.autoApply ? t('llmAuto') : ''}）`
            : `${t('llmOn')}：${a.baseUrl} · ${a.model}（≤${every} min/次${a.autoApply ? t('llmAuto') : ''}）`)
        : t('llmOff')
      return h(
        'div',
        { className: on ? 'pb-llm' : 'pb-llm pb-llm-off' },
        h('div', { className: 'pb-llm-title' }, t('llmTitle')),
        h('div', { className: 'pb-llm-line' }, line),
        h('div', { className: 'pb-llm-hint' }, t('llmHint')),
      )
    }

    // ── 设置分节（顶层 settings.section，与 dsh-browser-cdp 同式）─────────────
    // 宿主不会凭导出的 Config 自动生成表单：设置面必须由客户端注册到
    // `settings.section` 槽，数据臂走宿主原生 `configForms` 句柄
    // （get(entryId) → subscribe/getSnapshot/set），写值带 revision、改完即生效。
    function unionFormsScope(ctx) {
      let forms
      try {
        forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
      } catch (_error) {
        forms = undefined
      }
      if (!forms || typeof forms.get !== 'function') return undefined
      // entry id 在 cordis.patch.yml 里是 `progress-union`，包名是 `dsh-progress-union`，两个都试。
      for (const id of ['progress-union', 'dsh-progress-union']) {
        let scope
        try {
          scope = forms.get(id)
        } catch (_error) {
          scope = undefined
        }
        if (scope && typeof scope.getSnapshot === 'function' && typeof scope.subscribe === 'function' && typeof scope.set === 'function') return scope
      }
      return undefined
    }

    function SettingsRow(props) {
      return h(
        'label',
        { className: 'pb-set-row' },
        h('span', { className: 'pb-set-label' }, props.label),
        h('span', { className: 'pb-set-control' }, props.children),
        props.hint ? h('span', { className: 'pb-set-hint' }, props.hint) : null,
      )
    }

    function SettingsGroup(props) {
      return h(
        'section',
        { className: 'pb-set-group' },
        h('div', { className: 'pb-set-group-title' }, props.title),
        props.hint ? h('div', { className: 'pb-set-group-hint' }, props.hint) : null,
        props.children,
      )
    }

    function ProgressUnionSettings(props) {
      const t = makeT(props)
      const scope = props.scope
      const [snap, setSnap] = useState(null)
      const [status, setStatus] = useState('')
      useEffect(() => {
        if (!scope) return undefined
        let alive = true
        const read = () => {
          if (!alive) return
          try {
            setSnap(scope.getSnapshot())
          } catch (_error) {
            // 句柄随时会随 entry 重载重建；读失败就保持上一帧
          }
        }
        read()
        let off
        try {
          off = scope.subscribe(read)
        } catch (_error) {
          off = undefined
        }
        return () => {
          alive = false
          if (typeof off === 'function') {
            try {
              off()
            } catch (_error) {
              // 卸载期失败无关紧要
            }
          }
        }
      }, [scope])

      const value = (snap && snap.value) || {}
      const writable = Boolean(scope) && (!snap || snap.writable !== false)
      const assistant = value.assistant && typeof value.assistant === 'object' ? value.assistant : {}
      const observer = value.observer && typeof value.observer === 'object' ? value.observer : {}

      const write = async (field, next) => {
        if (!scope) {
          setStatus(t('setNoScope'))
          return
        }
        if (!writable) {
          setStatus(t('setReadOnly'))
          return
        }
        try {
          const ok = await scope.set(field, next)
          setStatus(ok === false ? t('setFailed') : t('setSaved'))
        } catch (_error) {
          setStatus(t('setFailed'))
        }
      }
      const putAssistant = (key, v) => void write('assistant', { ...assistant, [key]: v })
      const putObserver = (key, v) => void write('observer', { ...observer, [key]: v })

      const textOf = (v) => (v === undefined || v === null ? '' : String(v))
      const inputText = (v, onChange) => h('input', { type: 'text', value: textOf(v), onChange: (e) => onChange(e.target.value) })
      const inputSecret = (v, placeholder, onChange) => h('input', { type: 'password', value: textOf(v), placeholder, onChange: (e) => onChange(e.target.value) })
      const inputNum = (v, step, onChange) => h('input', { type: 'number', step, value: Number.isFinite(Number(v)) ? Number(v) : 0, onChange: (e) => onChange(Number(e.target.value)) })
      const inputBool = (v, fallback, onChange) => h('input', { type: 'checkbox', checked: v === undefined ? fallback : v !== false, onChange: (e) => onChange(e.target.checked) })
      const inputSelect = (v, options, onChange) =>
        h(
          'select',
          { value: textOf(v), onChange: (e) => onChange(e.target.value) },
          options.map((opt) => h('option', { key: opt[0], value: opt[0] }, opt[1])),
        )

      return h(
        'div',
        { className: 'pb-set' },
        scope ? null : h('div', { className: 'pb-set-banner' }, t('setNoScope')),
        h(
          SettingsGroup,
          { title: t('setLlmGroup'), hint: t('setLlmHint') },
          h(SettingsRow, { label: t('setMode') },
            inputSelect(assistant.mode || '', [['', t('setModeOff')], ['registered', t('setModeRegistered')], ['direct', t('setModeDirect')]], (v) => putAssistant('mode', v))),
          h(SettingsRow, { label: t('setProvider'), hint: t('setProviderHint') },
            inputText(assistant.provider || '', (v) => putAssistant('provider', v))),
          h(SettingsRow, { label: t('setModel') },
            inputText(assistant.model || '', (v) => putAssistant('model', v))),
          h(SettingsRow, { label: t('setBaseUrl') },
            inputText(assistant.baseUrl || '', (v) => putAssistant('baseUrl', v))),
          h(SettingsRow, { label: t('setApiKey'), hint: t('setApiKeyHint') },
            inputSecret('', assistant.hasApiKey ? '••••••' : '', (v) => putAssistant('apiKey', v))),
          h(SettingsRow, { label: t('setAuthority') },
            inputSelect(assistant.authority || 'both', [['both', t('setAuthorityBoth')], ['slots', t('setAuthoritySlots')], ['rounds', t('setAuthorityRounds')]], (v) => putAssistant('authority', v))),
          h(SettingsRow, { label: t('setInterval'), hint: t('setIntervalHint') },
            inputNum(assistant.minIntervalMs === undefined ? 90000 : assistant.minIntervalMs, 1000, (v) => putAssistant('minIntervalMs', v))),
          h(SettingsRow, { label: t('setAutoApply') },
            inputBool(assistant.autoApply, true, (v) => putAssistant('autoApply', v))),
        ),
        h(
          SettingsGroup,
          { title: t('setObserverGroup'), hint: t('setObserverHint') },
          h(SettingsRow, { label: t('setObserverEnabled') },
            inputBool(observer.enabled, true, (v) => putObserver('enabled', v))),
          h(SettingsRow, { label: t('setMaxIdleSteps') },
            inputNum(observer.maxIdleSteps === undefined ? 6 : observer.maxIdleSteps, 1, (v) => putObserver('maxIdleSteps', v))),
          h(SettingsRow, { label: t('setMaxIdleMs') },
            inputNum(observer.maxIdleMs === undefined ? 180000 : observer.maxIdleMs, 1000, (v) => putObserver('maxIdleMs', v))),
          h(SettingsRow, { label: t('setAutoSyncCurrent') },
            inputBool(observer.autoSyncCurrent, true, (v) => putObserver('autoSyncCurrent', v))),
          h(SettingsRow, { label: t('setAutoSyncThrottleMs') },
            inputNum(observer.autoSyncThrottleMs === undefined ? 60000 : observer.autoSyncThrottleMs, 1000, (v) => putObserver('autoSyncThrottleMs', v))),
          h(SettingsRow, { label: t('setMaxItems') },
            inputNum(observer.maxItems === undefined ? 12 : observer.maxItems, 1, (v) => putObserver('maxItems', v))),
        ),
        h(
          SettingsGroup,
          { title: t('setApiGroup'), hint: t('setApiHint') },
          h('div', { className: 'pb-set-api' },
            h('div', null, h('b', null, t('setApiService')), 'ctx.get(\'progressAnchor\').get(sessionId) / .list()'),
            h('div', null, h('b', null, t('setApiAnchor')), 'GET /progress-union/anchor?sessionId=<id>'),
            h('div', null, h('b', null, t('setApiSnapshot')), 'GET /progress-union/snapshot?sessionId=<id>'),
            h('div', null, h('b', null, t('setApiStatus')), 'GET /dsh-progress/status?sessionId=<id>'),
          ),
        ),
        status ? h('div', { className: 'pb-set-status' }, status) : null,
      )
    }

    function ProgressSidePanel(props) {
      const t = makeT(props)
      const { sessionId } = props
      const useTabInfo = props.useTabInfo
      const tabInfo = useTabInfo ? useTabInfo() : undefined
      const { snapshot, setSnapshot, error: readError, lastSyncAt, refresh } = useProgressData(sessionId)
      const usageView = usageSummary(useSessionUsage(sessionId, props.usage))
      const [saving, setSaving] = useState(false)
      const [actionError, setActionError] = useState('')
      const revisionRef = useRef(0)

      useEffect(() => {
        if (!sessionId) return undefined
        // Opening the board enables agent updates for this session. There is
        // deliberately no cleanup: collapsing the sidebar, switching tabs or
        // opening the full main panel must not silently disable the tool.
        setPanelActive(sessionId, true)
        return undefined
      }, [sessionId])

      const enableAuto = async () => {
        await setAgentEnabled(sessionId, true)
        refresh()
      }

      useEffect(() => {
        revisionRef.current = snapshot?.revision ?? 0
      }, [snapshot?.revision])

      const mutate = useCallback(
        async (changes) => {
          if (!sessionId) return false
          setSaving(true)
          setActionError('')
          try {
            let result = await postChanges(sessionId, revisionRef.current, changes)
            if (result.response.status === 409 && result.body?.snapshot) {
              revisionRef.current = result.body.snapshot.revision
              setSnapshot(result.body.snapshot)
              result = await postChanges(sessionId, revisionRef.current, changes)
            }
            const { response, body } = result
            if (!response.ok || !body || body.ok === false) {
              if (body?.snapshot) {
                revisionRef.current = body.snapshot.revision
                setSnapshot(body.snapshot)
              }
              throw new Error(body?.error || `HTTP ${response.status}`)
            }
            revisionRef.current = body.revision
            setSnapshot(body)
            broadcastProgress(sessionId, body)
            const addedTitles = (Array.isArray(changes) ? changes : [])
              .filter((change) => change && !change.id && !change.remove && typeof change.title === 'string')
              .map((change) => change.title.trim())
              .filter(Boolean)
            if (addedTitles.length > 0) {
              props.wakeAgent?.(
                sessionId,
                `我在进度板新增了任务。请按新任务推进。`,
              )
            }
            return true
          } catch (caught) {
            setActionError(errorText(caught))
            return false
          } finally {
            setSaving(false)
          }
        },
        [sessionId, setSnapshot],
      )

      const collapse = () => {
        try {
          props.collapse?.()
        } catch (_error) {
          // The chrome control remains available.
        }
      }

      const openFull = () => {
        try {
          props.openFullPanel?.()
        } catch (_error) {
          // The sidebar icon remains available.
        }
      }

      const items = snapshot?.items || []
      const latestDone = items
        .filter((item) => item.status === 'done')
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const otherDone = items
        .filter((item) => item.status === 'done' && item.id !== latestDone?.id)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const current = items.find((item) => item.status === 'doing') || items.find((item) => item.status === 'blocked')
      const pending = items.filter(
        (item) => (item.status === 'todo' || item.status === 'blocked') && item.id !== current?.id,
      )

      if (!sessionId) {
        return h(
          'div',
          { className: 'pb-side' },
          h('style', null, CSS),
          h('div', { className: 'pb-side-empty' }, t('noSessionBody')),
        )
      }

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'div',
          { className: 'pb-side' },
          h(
            'div',
            { className: 'pb-side-head' },
            h(
              'div',
              null,
              h('h2', { className: 'pb-side-title' }, t('nav')),
              h('p', { className: 'pb-side-sub' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'pb-side-head-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: snapshot?.enabled === false ? 'pb-btn pb-btn-primary' : 'pb-btn',
                  title: t('autoHint'),
                  onClick: async () => {
                    await setAgentEnabled(sessionId, snapshot?.enabled === false)
                    refresh()
                  },
                },
                snapshot?.enabled === false ? t('autoOff') : t('autoOn'),
              ),
              h(
                'button',
                { type: 'button', className: 'pb-btn', onClick: () => props.toggleFullscreen?.() },
                tabInfo?.sidebar?.fullscreen ? t('sideHalf') : t('sideFull'),
              ),
              h('button', { type: 'button', className: 'pb-btn', onClick: collapse }, t('sideCollapse')),
            ),
          ),
          readError ? h('div', { className: 'pb-side-error' }, `${t('readError')}${readError}`) : null,
          h(LlmAssistNotice, { assistant: snapshot?.assistant, t: props.t }),
          actionError ? h('div', { className: 'pb-side-error' }, `${t('saveError')}${actionError}`) : null,
          usageView
            ? h(
                'div',
                { className: 'pb-usage', title: usageTooltip(usageView, t) },
                h('span', { className: 'pb-usage-label' }, t('usageTotal')),
                h('b', null, `${formatTokens(usageView.total)} tok`),
                usageView.cost == null
                  ? null
                  : h('span', { className: 'pb-usage-cost' }, `≈ ${formatCny(usageView.cost)}`),
              )
            : null,
          snapshot?.enabled === false
            ? h(
                'div',
                { className: 'pb-side-error' },
                `${t('autoWarn')} `,
                h('button', { type: 'button', className: 'pb-side-link', onClick: enableAuto }, t('autoEnable')),
              )
            : null,
          !snapshot
            ? h('div', { className: 'pb-loading' }, t('loading'))
            : h(
                React.Fragment,
                null,
                h(
                  'section',
                  { className: 'pb-side-section' },
                  h(
                    'div',
                    { className: 'pb-side-label' },
                    h('span', null, t('sideCompleted')),
                    h('span', null, `${items.filter((item) => item.status === 'done').length}`),
                  ),
                  latestDone
                    ? h(
                        'div',
                        { className: 'pb-side-card pb-side-done-card' },
                        h(
                          'div',
                          { className: 'pb-side-task-head' },
                          h('span', { className: 'pb-side-check' }, '✓'),
                          h('span', { className: 'pb-side-done-title' }, latestDone.title),
                          h('span', { className: 'pb-side-meta' }, '100%'),
                        ),
                        latestDone.approach
                          ? h(
                              'div',
                              { className: 'pb-side-detail-line' },
                              h('b', null, t('approach')),
                              `：${latestDone.approach}`,
                            )
                          : null,
                        latestDone.note ? h('p', { className: 'pb-side-note' }, latestDone.note) : null,
                        h(
                          'div',
                          { className: 'pb-side-detail-line' },
                          `${t('lastUpdate')} ${new Date(latestDone.updatedAt).toLocaleString()}`,
                        ),
                      )
                    : h('div', { className: 'pb-side-empty' }, t('sideEmptyDone')),
                  otherDone.length
                    ? h(
                        'details',
                        { className: 'pb-side-done-all' },
                        h('summary', null, `${t('sideAllDone')} (${otherDone.length})`),
                        otherDone.map((item) =>
                          h(
                            'details',
                            { key: item.id, className: 'pb-side-done-item' },
                            h(
                              'summary',
                              null,
                              h('span', { className: 'pb-side-check' }, '✓'),
                              h('span', { className: 'pb-side-done-title' }, item.title),
                              h('span', { className: 'pb-side-meta' }, '100%'),
                            ),
                            item.approach
                              ? h(
                                  'div',
                                  { className: 'pb-side-detail-line' },
                                  h('b', null, t('approach')),
                                  `：${item.approach}`,
                                )
                              : null,
                            item.note ? h('p', { className: 'pb-side-note' }, item.note) : null,
                            h(
                              'div',
                              { className: 'pb-side-detail-line' },
                              `${t('lastUpdate')} ${new Date(item.updatedAt).toLocaleString()}`,
                            ),
                          ),
                        ),
                      )
                    : null,
                ),
                h(
                  'section',
                  { className: 'pb-side-section' },
                  h(
                    'div',
                    { className: 'pb-side-label' },
                    h('span', null, t('sideDetails')),
                    current ? h('span', null, `${current.percent}%`) : null,
                  ),
                  current
                    ? h(SideTaskEditor, {
                        key: current.id,
                        item: current,
                        t,
                        disabled: saving,
                        onPatch: (fields) => mutate([{ id: current.id, ...fields }]),
                      })
                    : h('div', { className: 'pb-side-empty' }, t('noDoing')),
                ),
                h(
                  'section',
                  { className: 'pb-side-section' },
                  h(
                    'div',
                    { className: 'pb-side-label' },
                    h('span', null, t('sidePending')),
                    h('span', null, `${pending.length}`),
                  ),
                  pending.length
                    ? pending.map((item) =>
                        h(SideTaskEditor, {
                          key: item.id,
                          item,
                          t,
                          disabled: saving,
                          onPatch: (fields) => mutate([{ id: item.id, ...fields }]),
                        }),
                      )
                    : h('div', { className: 'pb-side-empty' }, t('sideEmptyPending')),
                ),
                h(AddTask, {
                  t,
                  disabled: saving,
                  onAdd: (title) =>
                    mutate([{ title, status: 'todo', percent: 0, current: '', next: '', approach: '', note: '' }]),
                }),
                h(
                  'footer',
                  { className: 'pb-side-footer' },
                  h('button', { type: 'button', className: 'pb-side-link', onClick: openFull }, t('sideOpenFull')),
                  h('button', { type: 'button', className: 'pb-side-link', onClick: refresh }, t('refresh')),
                  h('span', null, `${t('revision')} ${snapshot.revision}`),
                  h(
                    'span',
                    null,
                    `${t('lastSync')} ${
                      lastSyncAt
                        ? new Date(lastSyncAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : '—'
                    }`,
                  ),
                  h('span', null, snapshot.persistent ? t('saved') : t('memoryOnly')),
                ),
              ),
        ),
      )
    }

    function ProgressPanel(props) {
      const t = makeT(props)
      const sessionId = props.useSessions
        ? props.useSessions((state) => {
            const rows = Object.values(state.byId || {})
            const current = rows.find((row) => (row.retainedBy?.mainView ?? 0) > 0)
            return current?.id
          })
        : undefined

      const [snapshot, setSnapshot] = useState(null)
      const usageView = usageSummary(useSessionUsage(sessionId, props.usage))
      const [loading, setLoading] = useState(true)
      const [saving, setSaving] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [actionError, setActionError] = useState('')
      const [tick, setTick] = useState(0)
      const revisionRef = useRef(0)

      useEffect(() => {
        revisionRef.current = snapshot?.revision ?? 0
      }, [snapshot?.revision])

      useEffect(() => {
        if (!sessionId) return undefined
        // The full main panel keeps agent updates on just like the sidebar
        // body; there is no cleanup, so leaving the panel does not disable it.
        setPanelActive(sessionId, true)
        return undefined
      }, [sessionId])

      const enableAuto = async () => {
        if (!sessionId) return
        await setAgentEnabled(sessionId, true)
        setTick((value) => value + 1)
      }

      useEffect(() => {
        if (!sessionId) {
          setSnapshot(null)
          setLoading(false)
          return undefined
        }

        let active = true
        let controller
        setLoading(true)

        const load = async () => {
          if (controller) controller.abort()
          const ownController = (controller = new AbortController())
          try {
            const response = await fetch(
              `${API}/snapshot?sessionId=${encodeURIComponent(sessionId)}`,
              { credentials: 'same-origin', cache: 'no-store', signal: ownController.signal },
            )
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            if (!active) return
            revisionRef.current = next.revision
            setSnapshot(next)
            setLoadError('')
            setLoading(false)
          } catch (error) {
            if (!active || error?.name === 'AbortError') return
            setLoadError(errorText(error))
            setLoading(false)
          }
        }

        load()
        const interval = window.setInterval(load, 3000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load()
        }
        document.addEventListener('visibilitychange', onVisibility)

        return () => {
          active = false
          window.clearInterval(interval)
          controller?.abort()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, tick])

      const mutate = useCallback(
        async (changes) => {
          if (!sessionId) return false
          setSaving(true)
          setActionError('')
          try {
            let result = await postChanges(sessionId, revisionRef.current, changes)
            if (result.response.status === 409 && result.body?.snapshot) {
              revisionRef.current = result.body.snapshot.revision
              setSnapshot(result.body.snapshot)
              result = await postChanges(sessionId, revisionRef.current, changes)
            }
            const { response, body } = result
            if (!response.ok || !body || body.ok === false) {
              if (body?.snapshot) {
                revisionRef.current = body.snapshot.revision
                setSnapshot(body.snapshot)
              }
              throw new Error(body?.error || `HTTP ${response.status}`)
            }
            revisionRef.current = body.revision
            setSnapshot(body)
            broadcastProgress(sessionId, body)
            const addedTitles = (Array.isArray(changes) ? changes : [])
              .filter((change) => change && !change.id && !change.remove && typeof change.title === 'string')
              .map((change) => change.title.trim())
              .filter(Boolean)
            if (addedTitles.length > 0) {
              props.wakeAgent?.(
                sessionId,
                `我在进度板新增了任务${addedTitles.map((title) => `「${title}」`).join('、')}。请按新任务推进。`,
              )
            }
            return true
          } catch (error) {
            setActionError(errorText(error))
            return false
          } finally {
            setSaving(false)
          }
        },
        [sessionId],
      )

      const patch = useCallback(
        (item, fields) => mutate([{ id: item.id, ...fields }]),
        [mutate],
      )

      const items = snapshot?.items || []
      const summary = snapshot?.summary || { total: 0, done: 0, doing: 0, todo: 0, blocked: 0, percent: 0 }
      const doing = items.filter((item) => item.status === 'doing')
      const todo = items.filter((item) => item.status === 'todo')
      const blocked = items.filter((item) => item.status === 'blocked')
      const done = items.filter((item) => item.status === 'done')

      const move = (item, direction) => {
        const index = items.findIndex((candidate) => candidate.id === item.id)
        const neighbor = items[index + direction]
        if (!neighbor) return
        mutate([
          { id: item.id, order: neighbor.order },
          { id: neighbor.id, order: item.order },
        ])
      }

      const renderItem = (item) => {
        const index = items.findIndex((candidate) => candidate.id === item.id)
        return h(ItemCard, {
          key: item.id,
          item,
          t,
          disabled: saving,
          canMoveUp: index > 0,
          canMoveDown: index >= 0 && index < items.length - 1,
          onPatch: (fields) => patch(item, fields),
          onRemove: () => mutate([{ id: item.id, remove: true }]),
          onMove: (direction) => move(item, direction),
        })
      }

      if (!sessionId) {
        return h(
          'div',
          { className: 'pb-root' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'pb-inner' },
            h(
              'header',
              { className: 'pb-head' },
              h(
                'div',
                null,
                h('h1', { className: 'pb-title' }, t('title')),
                h('p', { className: 'pb-sub' }, t('subtitle')),
              ),
            ),
            h(
              'div',
              { className: 'pb-empty' },
              h('h2', null, t('noSessionTitle')),
              h('p', null, t('noSessionBody')),
            ),
          ),
        )
      }

      const focus = doing[0] || null
      const updated = snapshot ? new Date(snapshot.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

      return h(
        'div',
        { className: 'pb-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'pb-inner' },
          h(
            'header',
            { className: 'pb-head' },
            h(
              'div',
              null,
              h('h1', { className: 'pb-title' }, t('title')),
              h('p', { className: 'pb-sub' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'pb-head-right' },
              saving ? h('span', { className: 'pb-saving' }, t('saving')) : null,
              snapshot?.pendingUserChanges
                ? h('span', { className: 'pb-badge-pending' }, `${t('pending')} · ${snapshot.pendingUserChanges}`)
                : null,
              usageView
                ? h(
                    'span',
                    { className: 'pb-usage pb-usage-inline', title: usageTooltip(usageView, t) },
                    `${formatTokens(usageView.total)} tok${
                      usageView.cost == null ? '' : ` · ≈${formatCny(usageView.cost)}`
                    }`,
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: snapshot?.enabled === false ? 'pb-btn pb-btn-primary' : 'pb-btn',
                  title: t('autoHint'),
                  onClick: async () => {
                    if (!sessionId) return
                    await setAgentEnabled(sessionId, snapshot?.enabled === false)
                    setTick((value) => value + 1)
                  },
                },
                snapshot?.enabled === false ? t('autoOff') : t('autoOn'),
              ),
              h(
                'span',
                { className: 'pb-live', title: t('footerHint') },
                h('i', { className: 'pb-dot' }),
                t('live'),
              ),
            ),
          ),
          h(LlmAssistNotice, { assistant: snapshot?.assistant, t: props.t }),
          snapshot?.enabled === false
            ? h(
                'div',
                { className: 'pb-warn' },
                `${t('autoWarn')} `,
                h(
                  'button',
                  { type: 'button', className: 'pb-btn', onClick: enableAuto },
                  t('autoEnable'),
                ),
              )
            : null,
          loadError
            ? h(
                'div',
                { className: 'pb-warn pb-warn-error' },
                `${t('readError')}${loadError} `,
                h(
                  'button',
                  { type: 'button', className: 'pb-btn', onClick: () => setTick((value) => value + 1) },
                  t('retry'),
                ),
              )
            : null,
          actionError
            ? h(
                'div',
                { className: 'pb-warn pb-warn-error' },
                `${t('saveError')}${actionError}`,
              )
            : null,
          snapshot?.storageError
            ? h('div', { className: 'pb-warn' }, `${t('storageWarn')} ${snapshot.storageError}`)
            : null,
          loading && !snapshot
            ? h('div', { className: 'pb-loading' }, t('loading'))
            : h(
                React.Fragment,
                null,
                h(
                  'section',
                  { className: 'pb-overview' },
                  h(
                    'div',
                    { className: 'pb-overview-top' },
                    h(
                      'div',
                      { className: 'pb-big' },
                      String(summary.percent),
                      h('small', null, '%'),
                    ),
                    h(
                      'div',
                      { className: 'pb-counts' },
                      h('span', { className: 'pb-chip' }, t('statusDone'), h('strong', null, summary.done)),
                      h('span', { className: 'pb-chip' }, t('statusDoing'), h('strong', null, summary.doing)),
                      h('span', { className: 'pb-chip' }, t('statusTodo'), h('strong', null, summary.todo)),
                      h('span', { className: 'pb-chip' }, t('statusBlocked'), h('strong', null, summary.blocked)),
                    ),
                  ),
                  h('div', { className: 'pb-bar' }, h('i', { style: { width: `${summary.percent}%` } })),
                  h(
                    'div',
                    { className: 'pb-focus' },
                    focus
                      ? h(
                          React.Fragment,
                          null,
                          h('span', null, `${t('doingTitle')}：`),
                          h('b', null, focus.title),
                          focus.current ? h('span', null, ` · ${focus.current}`) : null,
                        )
                      : h('span', null, summary.total > 0 && summary.done === summary.total ? t('allDone') : t('noDoing')),
                    summary.blocked > 0 ? h('span', { className: 'pb-badge-pending' }, `${summary.blocked} ${t('blockedCount')}`) : null,
                  ),
                ),
                snapshot?.items?.length === 0
                  ? h(
                      'div',
                      { className: 'pb-empty' },
                      h('h2', null, t('emptyTitle')),
                      h('p', null, t('emptyBody')),
                    )
                  : h(
                      React.Fragment,
                      null,
                      doing.length
                        ? h(Section, { title: t('doingTitle'), count: doing.length }, doing.map(renderItem))
                        : h(
                            'section',
                            { className: 'pb-section' },
                            h('p', { className: 'pb-loading', style: { padding: '14px 0' } }, t('emptyDoing')),
                          ),
                      todo.length
                        ? h(Section, { title: t('todoTitle'), count: todo.length }, todo.map(renderItem))
                        : null,
                      blocked.length
                        ? h(
                            Section,
                            { title: t('blockedTitle'), count: blocked.length, hint: t('blockedHint') },
                            blocked.map(renderItem),
                          )
                        : null,
                      done.length
                        ? h(
                            'details',
                            { className: 'pb-done-box' },
                            h('summary', null, `${t('doneTitle')} · ${done.length} ${t('doneCount')}`),
                            h('div', { className: 'pb-list' }, done.map(renderItem)),
                          )
                        : null,
                    ),
                h(AddTask, {
                  t,
                  disabled: saving,
                  onAdd: (title) =>
                    mutate([{ title, status: 'todo', percent: 0, current: '', next: '', approach: '', note: '' }]),
                }),
                h(
                  'footer',
                  { className: 'pb-footer' },
                  h('span', null, `${t('editHint')}`),
                  h('span', { className: 'pb-sep' }, '·'),
                  h('span', null, `${t('footerHint')}`),
                  h('span', { className: 'pb-sep' }, '·'),
                  h('span', null, `${t('lastUpdate')} ${updated}`),
                  h('span', null, `${t('revision')} ${snapshot?.revision ?? 0}`),
                  h('span', null, snapshot?.persistent ? t('saved') : t('memoryOnly')),
                ),
              ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs', 'sessions'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'progress-union: locale',
        )

        const t = ctx.locale.bind(NS)

        // 独立设置分节：顶层 `settings.section`（与记忆/模型/插件并列）。
        // order 215 接在宿主内置分节之后；旧宿主没声明该槽时 inject 空转，
        // 面板与迷你条不受影响（不靠版本号判断，只靠槽位存在性）。
        const settingsScope = unionFormsScope(ctx)
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'dsh-progress-union',
                  order: 215,
                  locale: NS,
                  label: () => t('setTitle'),
                  inject: () => ({ scope: settingsScope }),
                },
                ProgressUnionSettings,
              ),
            ),
          'progress-union: settings section',
        )

        const wakeAgent = (sessionId, text) => {
          try {
            const binding = ctx.sessions.binding(sessionId)
            if (!binding) return
            binding.session.prompt([{ type: 'text', text }], 'queue').catch(() => {})
          } catch (_error) {
            // The task is saved; waking is best-effort.
          }
        }
        const openPanel = () => ctx.sidebarRight.openTab(RIGHT_TAB_KIND)

        /*
         * Live token accounting for one Session. The token-meter unit publishes
         * `tokenUsage` as a host-computed Session projection, and model
         * selection is a second projection; reading both faces keeps the
         * figure current without adding it to the board's 3s HTTP poll.
         */
        const usageApi = {
          read(sessionId) {
            try {
              const projectionStore = ctx.sessions.binding(sessionId)?.session?.projections
              if (!projectionStore?.faceOf) return null
              const usage = projectionStore.faceOf('tokenUsage')?.getSnapshot?.() ?? null
              const selection = projectionStore.faceOf('modelSelection')?.getSnapshot?.() ?? null
              return {
                usage,
                model: selection?.lastUsed?.model || selection?.next?.model || null,
                provider: selection?.lastUsed?.provider || selection?.next?.provider || null,
              }
            } catch (_error) {
              return null
            }
          },
          subscribe(sessionId, listener) {
            try {
              const projectionStore = ctx.sessions.binding(sessionId)?.session?.projections
              if (!projectionStore?.faceOf) return () => {}
              const offs = []
              for (const key of ['tokenUsage', 'modelSelection']) {
                const face = projectionStore.faceOf(key)
                if (face?.subscribe) offs.push(face.subscribe(listener))
              }
              return () => {
                for (const off of offs) {
                  try {
                    off?.()
                  } catch (_error) {
                    // Projection faces are torn down with the Session.
                  }
                }
              }
            } catch (_error) {
              return () => {}
            }
          },
        }

        const togglePanel = () => {
          const active = ctx.sidebarRight.active()
          if (ctx.sidebarRight.isExpanded() && active?.kind === RIGHT_TAB_KIND) {
            ctx.sidebarRight.toggleExpanded()
            return
          }
          ctx.sidebarRight.openTab(RIGHT_TAB_KIND)
        }
        const openFullPanel = () => ctx.layout.selectPanel(PANEL_ID)
        const toggleFullscreen = () => {
          const target = ctx.sidebarRight.focusedTarget() ?? ctx.sidebarRight.commandTarget()
          if (target) ctx.sidebarRight.toggleFullscreen(target)
        }

        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: RIGHT_TAB_ID,
              kind: RIGHT_TAB_KIND,
              priority: 'extension',
              title: () => t('nav'),
            }),
          'progress-union: right sidebar type',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: RIGHT_TAB_ID,
                  locale: NS,
                  inject: () => ({
                    collapse: () => ctx.sidebarRight.toggleExpanded(),
                    toggleFullscreen,
                    openFullPanel,
                    wakeAgent,
                    usage: usageApi,
                  }),
                },
                ProgressSidePanel,
              ),
            ),
          'progress-union: right sidebar body',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,
                  inject: () => ({ wakeAgent, usage: usageApi }),
                },
                ProgressPanel,
              ),
            ),
          'progress-union: full panel',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.session.header.utilities', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.utilities',
                  id: 'progress-union-header',
                  order: 12,
                  locale: NS,
                  inject: () => ({ openPanel: togglePanel }),
                },
                ProgressHeaderButton,
              ),
            ),
          'progress-union: header button',
        )

        ctx.effect(
          () =>
            ctx.slots.inject('conversation.input.dock', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'progress-union-dock',
                  order: 5,
                  locale: NS,
                  inject: () => ({ openPanel, togglePanel, usage: usageApi }),
                },
                ProgressDock,
              ),
            ),
          'progress-union: composer dock',
        )
      },
    }
  },
})
