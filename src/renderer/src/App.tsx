import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Message, mockSessions, RunRecord, Session } from './mock'

function nowTime(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function upsertRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const index = runs.findIndex((item) => item.id === run.id)
  if (index === -1) return [...runs, run]
  const next = runs.slice()
  next[index] = run
  return next
}

let sessionSeq = 0
let turnSeq = 0

function newSessionId(): string {
  sessionSeq += 1
  return 's-' + Date.now() + '-' + sessionSeq
}

function newTurnId(): string {
  turnSeq += 1
  return 'turn-' + Date.now() + '-' + turnSeq
}

function nextSessionTitle(existing: Session[]): string {
  const titles = new Set(existing.map((session) => session.title))
  if (!titles.has('新对话')) return '新对话'
  let number = 2
  while (titles.has('新对话 ' + number)) number += 1
  return '新对话 ' + number
}

function makeEmptySession(existing: Session[]): Session {
  return {
    id: newSessionId(),
    title: nextSessionTitle(existing),
    preview: '暂无消息',
    updatedAt: nowTime(),
    messages: [],
    runs: []
  }
}

function isValidSessionData(data: unknown): data is Session[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (session) =>
        session &&
        typeof session.id === 'string' &&
        typeof session.title === 'string' &&
        Array.isArray(session.messages) &&
        Array.isArray(session.runs)
    )
  )
}

interface TurnGroup {
  turnId: string
  user?: Message
  assistant?: Message
  runs: RunRecord[]
  running: boolean
  failed: boolean
}

function groupTurns(session: Session): TurnGroup[] {
  const byId = new Map<string, TurnGroup>()
  const order: TurnGroup[] = []
  const getTurn = (id: string): TurnGroup => {
    let turn = byId.get(id)
    if (!turn) {
      turn = { turnId: id, runs: [], running: false, failed: false }
      byId.set(id, turn)
      order.push(turn)
    }
    return turn
  }

  let legacy: TurnGroup | null = null
  for (const message of session.messages) {
    if (message.turnId) {
      const turn = getTurn(message.turnId)
      if (message.role === 'user') turn.user = message
      else turn.assistant = message
      legacy = null
    } else {
      if (message.role === 'user' || !legacy) legacy = getTurn('legacy-' + message.id)
      if (message.role === 'user') legacy.user = message
      else legacy.assistant = message
    }
  }

  for (const run of session.runs) {
    if (run.turnId && byId.has(run.turnId)) byId.get(run.turnId)!.runs.push(run)
  }

  for (const turn of order) {
    turn.running = Boolean(turn.user) && !turn.assistant
    turn.failed = turn.runs.some((run) => run.status === 'failed')
  }
  return order
}

function isSessionRunning(session: Session): boolean {
  return session.messages.length > 0 && session.messages[session.messages.length - 1].role === 'user'
}

function runState(turn: TurnGroup): 'success' | 'running' | 'failed' {
  if (turn.running) return 'running'
  if (turn.failed) return 'failed'
  return 'success'
}

function runStateLabel(turn: TurnGroup): string {
  const state = runState(turn)
  if (state === 'running') return '运行中'
  if (state === 'failed') return '有失败'
  return '已完成'
}

function runDuration(turn: TurnGroup): string | null {
  const timestamps = turn.runs.map((run) => run.ts).filter((time): time is number => typeof time === 'number')
  if (timestamps.length < 2) return null
  const elapsed = Math.max(...timestamps) - Math.min(...timestamps)
  if (elapsed < 1000) return '不到 1 秒'
  return (elapsed / 1000).toFixed(1) + ' 秒'
}

function SessionList(props: {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
}): JSX.Element {
  return (
    <aside className="panel sidebar">
      <div className="panel-header">
        <span className="logo">◆ ChuangDex</span>
        <button className="icon-btn" title="新建会话" onClick={props.onCreate}>＋</button>
      </div>
      <div className="session-list">
        {props.sessions.map((session) => {
          const running = isSessionRunning(session)
          return (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              className={'session-item' + (session.id === props.activeId ? ' active' : '')}
              onClick={() => props.onSelect(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onSelect(session.id)
                }
              }}
            >
              <div className="session-title-row">
                <span className={'s-dot' + (running ? ' running' : '')} aria-hidden="true" />
                <span className="session-title">{session.title}</span>
              </div>
              <div className="session-preview">{running ? '处理中…' : session.preview}</div>
              <div className="session-time">{session.updatedAt}</div>
              <button
                className="session-delete"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onDelete(session.id)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <span className="avatar">C</span>
        <span className="footer-name">Chuang</span>
        <span className="footer-status">本地模式</span>
      </div>
    </aside>
  )
}

function RunSteps({ runs, compact = false }: { runs: RunRecord[]; compact?: boolean }): JSX.Element {
  return (
    <ol className={'exec-steps' + (compact ? ' ctx-steps' : '')}>
      {runs.map((run) => (
        <li key={run.id} className="exec-step">
          <span className={'status-dot ' + run.status} aria-hidden="true" />
          <div className="step-main">
            <div className="step-title">{run.title}</div>
            <div className="step-detail">{run.detail}</div>
          </div>
          <span className="step-time">{run.time}</span>
        </li>
      ))}
    </ol>
  )
}

function summarizeTurn(turn: TurnGroup): {
  text: string
  context: string | null
  skill: string | null
  error: string | null
  running: boolean
} {
  const timestamps = turn.runs
    .map((run) => run.ts)
    .filter((time): time is number => typeof time === 'number')
  const duration = timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : null
  const running = turn.running

  let text: string
  if (running) text = '正在工作…'
  else if (duration !== null) text = duration < 1000 ? '已工作 不到 1 秒' : `已工作 ${(duration / 1000).toFixed(1)} 秒`
  else text = '已响应'

  const contextRun = turn.runs.find((run) => run.title.includes('条上下文消息'))
  const context = contextRun ? contextRun.title.replace(/^已带入 /, '').replace(/ 条上下文消息$/, '') + ' 条' : null

  const skillRun = turn.runs.find((run) => run.title.startsWith('选择 '))
  const noSkillRun = turn.runs.find((run) => run.title === '未匹配 Skill')
  const skill = skillRun ? skillRun.title.slice(3) : (noSkillRun ? '未使用' : null)

  const failedRun = turn.runs.find((run) => run.status === 'failed')
  const error = failedRun
    ? failedRun.detail
      ? `${failedRun.title}：${failedRun.detail}`
      : failedRun.title
    : null

  return { text, context, skill, error, running }
}

function TurnSummary({ turn }: { turn: TurnGroup }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => summarizeTurn(turn), [turn])

  return (
    <div className="turn-summary">
      <button className="turn-summary-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={'chev' + (open ? ' open' : '')} aria-hidden="true">▶</span>
        <span>{summary.text}</span>
      </button>
      {open && (
        <div className="turn-summary-detail">
          {summary.context !== null && (
            <span className="summary-chip">上下文：{summary.context}</span>
          )}
          {summary.skill !== null && (
            <span className="summary-chip">Skill：{summary.skill}</span>
          )}
          {summary.error && (
            <span className="summary-chip error">{summary.error}</span>
          )}
        </div>
      )}
    </div>
  )
}

function ReplyDivider(): JSX.Element {
  return <div className="reply-divider" />
}

function ChatPanel(props: {
  session: Session
  turns: TurnGroup[]
  onSend: (text: string) => void
  onRename: (id: string, title: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEditingTitle(false)
  }, [props.session.id])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [props.session.id, props.session.messages.length, props.session.runs.length])

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    props.onSend(text)
    setDraft('')
  }

  const startRename = (): void => {
    setTitleDraft(props.session.title)
    setEditingTitle(true)
  }

  const saveRename = (): void => {
    const title = titleDraft.trim()
    if (title) props.onRename(props.session.id, title)
    setEditingTitle(false)
  }

  return (
    <main className="panel chat">
      <div className="panel-header chat-header">
        {editingTitle ? (
          <span className="title-edit">
            <input
              value={titleDraft}
              autoFocus
              maxLength={30}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveRename()
                if (event.key === 'Escape') setEditingTitle(false)
              }}
            />
            <button className="btn small" onClick={saveRename}>保存</button>
            <button className="btn small" onClick={() => setEditingTitle(false)}>取消</button>
          </span>
        ) : (
          <>
            <span className="chat-title">{props.session.title}</span>
            <button className="icon-btn title-edit-btn" title="重命名会话" onClick={startRename}>✎</button>
          </>
        )}
        {props.session.demo && <span className="badge">演示数据</span>}
      </div>

      <div className="message-list" ref={listRef}>
        {props.turns.length === 0 && (
          <div className="empty-state">全新会话，从下方输入第一条消息开始。</div>
        )}

        {props.turns.map((turn) => (
          <section key={turn.turnId} className="turn">
            {turn.user && (
              <div className="message-row user">
                <div className="message-body">
                  <div className="message-content">{turn.user.content}</div>
                  <div className="message-time">{turn.user.time}</div>
                </div>
              </div>
            )}

            {(turn.runs.length > 0 || turn.running) && (
              <>
                <TurnSummary turn={turn} />
                <ReplyDivider />
              </>
            )}

            {turn.assistant && (
              <div className="message-row assistant">
                <div className="message-body">
                  <div className="message-content">{turn.assistant.content}</div>
                  <div className="message-time">{turn.assistant.time}</div>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          value={draft}
          placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={1}
        />
        <button className="send-btn" type="submit">发送</button>
      </form>
    </main>
  )
}

function CtxSection(props: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen !== false)
  return (
    <section className="ctx-section">
      <button className="ctx-title" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={'chev' + (open ? ' open' : '')} aria-hidden="true">▶</span>
        <span>{props.title}</span>
        {props.count !== undefined && <span className="ctx-count">{props.count}</span>}
      </button>
      {open && props.children}
    </section>
  )
}

function SidePanel(props: {
  session: Session
  turns: TurnGroup[]
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  if (props.collapsed) {
    return (
      <aside className="panel side-collapsed">
        <button className="icon-btn" title="展开执行面板" onClick={props.onToggle}>«</button>
      </aside>
    )
  }

  const latest = [...props.turns].reverse().find((turn) => turn.user || turn.runs.length > 0)
  const background = props.session.runs.filter((run) => !run.turnId)
  const completed = latest?.runs.filter((run) => run.status === 'success').length ?? 0

  return (
    <aside className="panel runs">
      <div className="panel-header">
        <span>本次执行</span>
        <button className="icon-btn" title="收起执行面板" onClick={props.onToggle}>»</button>
      </div>
      <div className="ctx-body">
        <CtxSection title="本轮进度">
          {latest ? (
            <div className="summary">
              <div className="summary-top">
                <span className={'status-tag ' + runState(latest)}>{runStateLabel(latest)}</span>
                <span>{latest.runs.length} 个真实步骤</span>
              </div>
              <div className="summary-grid">
                <span>完成 <strong>{completed}/{latest.runs.length}</strong></span>
                <span>耗时 <strong>{runDuration(latest) ?? '—'}</strong></span>
              </div>
            </div>
          ) : (
            <div className="ctx-empty">本会话还没有执行记录。</div>
          )}
        </CtxSection>

        <CtxSection title="运行步骤" count={latest?.runs.length ?? 0}>
          {latest && latest.runs.length > 0 ? <RunSteps runs={latest.runs} compact /> : <div className="ctx-empty">暂无步骤。</div>}
        </CtxSection>

        <CtxSection title="后台记录" count={background.length} defaultOpen={false}>
          {background.length > 0 ? <RunSteps runs={background} compact /> : <div className="ctx-empty">暂无后台记录。</div>}
        </CtxSection>

        <CtxSection title="公开计划" defaultOpen={false}>
          <div className="ctx-empty">暂无 —— 当前版本不生成计划数据。</div>
        </CtxSection>

        <CtxSection title="变更文件" defaultOpen={false}>
          <div className="ctx-empty">暂无 —— 当前版本不涉及文件读取或修改。</div>
        </CtxSection>
      </div>
    </aside>
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>(mockSessions)
  const [activeId, setActiveId] = useState<string>(mockSessions[0].id)
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sideCollapsed, setSideCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.chuangdex.sessions
      .load()
      .then((result) => {
        if (cancelled) return
        if (result && isValidSessionData(result.sessions)) {
          const restored = result.sessions
          setSessions(restored)
          setActiveId(restored.some((session) => session.id === result.activeId) ? result.activeId : restored[0].id)
        }
        setLoaded(true)
      })
      .catch((error) => {
        console.error('会话存档加载失败，使用初始会话:', error)
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loaded) return
    window.chuangdex.sessions
      .save({ activeId, sessions })
      .catch((error) => console.error('会话保存失败:', error))
  }, [sessions, activeId, loaded])

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? sessions[0],
    [sessions, activeId]
  )
  const activeTurns = useMemo(() => groupTurns(active), [active])

  useEffect(() => {
    const unsubscribe = window.chuangdex.agent.onRunEvent((event) => {
      const record: RunRecord = {
        id: event.id,
        title: event.title,
        detail: event.detail,
        status: event.status,
        time: event.time,
        ts: event.ts,
        turnId: event.turnId
      }
      setSessions((previous) =>
        previous.map((session) =>
          session.id === event.sessionId ? { ...session, runs: upsertRun(session.runs, record) } : session
        )
      )
    })
    return unsubscribe
  }, [])

  const handleCreate = (): void => {
    const fresh = makeEmptySession(sessions)
    setSessions((previous) => [fresh, ...previous])
    setActiveId(fresh.id)
  }

  const handleRequestDelete = (id: string): void => {
    const target = sessions.find((session) => session.id === id)
    if (target) setPendingDelete(target)
  }

  const handleConfirmDelete = (): void => {
    if (!pendingDelete) return
    const index = sessions.findIndex((session) => session.id === pendingDelete.id)
    const remaining = sessions.filter((session) => session.id !== pendingDelete.id)
    if (remaining.length === 0) {
      const fresh = makeEmptySession(remaining)
      setSessions([fresh])
      setActiveId(fresh.id)
    } else {
      setSessions(remaining)
      if (pendingDelete.id === activeId) setActiveId(remaining[Math.min(index, remaining.length - 1)].id)
    }
    setPendingDelete(null)
  }

  const handleRename = (id: string, title: string): void => {
    setSessions((previous) =>
      previous.map((session) => (session.id === id ? { ...session, title, renamed: true } : session))
    )
  }

  const handleSend = (text: string): void => {
    const time = nowTime()
    const turnId = newTurnId()
    const userMessage: Message = {
      id: 'm-' + Date.now() + '-u',
      role: 'user',
      content: text,
      time,
      turnId
    }
    const shouldAutoTitle = active.messages.length === 0 && !active.renamed
    const history = active.messages.slice(-12).map((message) => ({ role: message.role, content: message.content }))

    setSessions((previous) =>
      previous.map((session) =>
        session.id === activeId
          ? { ...session, preview: text.slice(0, 30), updatedAt: time, messages: [...session.messages, userMessage] }
          : session
      )
    )

    window.chuangdex.agent
      .sendMessage({ sessionId: activeId, text, history, turnId })
      .then((reply) => {
        const assistantMessage: Message = {
          id: 'm-' + Date.now() + '-a',
          role: 'assistant',
          content: reply.content,
          time: nowTime(),
          turnId
        }
        setSessions((previous) =>
          previous.map((session) =>
            session.id === reply.sessionId ? { ...session, messages: [...session.messages, assistantMessage] } : session
          )
        )
      })
      .catch((error) => {
        const assistantMessage: Message = {
          id: 'm-' + Date.now() + '-e',
          role: 'assistant',
          content: '发送失败：' + (error instanceof Error ? error.message : String(error)) + '。请重试。',
          time: nowTime(),
          turnId
        }
        setSessions((previous) =>
          previous.map((session) =>
            session.id === activeId ? { ...session, messages: [...session.messages, assistantMessage] } : session
          )
        )
      })

    if (shouldAutoTitle) {
      window.chuangdex.agent
        .generateTitle({ sessionId: activeId, text })
        .then(({ title }) => {
          if (!title) return
          setSessions((previous) =>
            previous.map((session) =>
              session.id === activeId && !session.renamed ? { ...session, title } : session
            )
          )
        })
        .catch((error) => console.error('自动命名失败（不影响对话）:', error))
    }
  }

  if (!loaded) {
    return (
      <div className="app loading-screen">
        <span className="empty-state">正在加载会话…</span>
      </div>
    )
  }

  return (
    <div
      className="app"
      style={{ gridTemplateColumns: sideCollapsed ? '260px minmax(0, 1fr) 46px' : '260px minmax(0, 1fr) 330px' }}
    >
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onDelete={handleRequestDelete}
      />
      <ChatPanel session={active} turns={activeTurns} onSend={handleSend} onRename={handleRename} />
      <SidePanel
        session={active}
        turns={activeTurns}
        collapsed={sideCollapsed}
        onToggle={() => setSideCollapsed((value) => !value)}
      />

      {pendingDelete && (
        <div className="modal-overlay" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">删除会话</div>
            <div className="modal-body">
              确定删除「{pendingDelete.title}」吗？其中的消息和运行记录将一并删除，此操作不可恢复。
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="btn danger" onClick={handleConfirmDelete}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
