import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { Message, mockSessions, RunRecord, Session } from './mock'
import { MarkdownMessage } from './MarkdownMessage'
import type {
  McpServerInfo,
  McpServerInput,
  McpServerUpdateInput,
  MemoryItem,
  MemoryUpdateInput,
  SkillInfo,
  TaskChannel,
  TaskCreateInput,
  TaskInfo,
  TaskRemoveInput,
  TaskRepeatMode,
  TaskUpdateInput
} from '../../shared/agent'

type AppView = 'chat' | 'scheduled' | 'skills' | 'mcp' | 'memories'

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
  view: AppView
  taskCount: number
  skillCount: number
  mcpCount: number
  memoryCount: number
  onSelect: (id: string) => void
  onViewChat: () => void
  onViewScheduled: () => void
  onViewSkills: () => void
  onViewMcp: () => void
  onViewMemories: () => void
  onDelete: (id: string) => void
}): JSX.Element {
  const navItems = [
    { key: 'chat', count: props.sessions.length, label: '对话', onClick: props.onViewChat },
    { key: 'scheduled', count: props.taskCount, label: '已安排', onClick: props.onViewScheduled },
    { key: 'skills', count: props.skillCount, label: 'Skills', onClick: props.onViewSkills },
    { key: 'mcp', count: props.mcpCount, label: 'MCP', onClick: props.onViewMcp },
    { key: 'memories', count: props.memoryCount, label: '记忆', onClick: props.onViewMemories }
  ] as const

  return (
    <aside className="workbench-sidebar">
      <header className="workbench-brand">
        <div className="workbench-brand-row">
          <span>ChuangDex</span>
          <small>WORKBENCH</small>
        </div>
        <p>本地优先的 Agent 协作桌面</p>
      </header>

      <nav className="workbench-nav-grid" aria-label="主要功能">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={'workbench-nav-tile' + (props.view === item.key ? ' active' : '')}
            onClick={item.onClick}
          >
            <strong>{String(item.count).padStart(2, '0')}</strong>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="workbench-section-title">
        <span>最近工作</span>
        <span>{props.sessions.length} 个会话</span>
      </div>

      <div className="workbench-session-list">
        {props.sessions.map((session) => {
          const running = isSessionRunning(session)
          return (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              className={'workbench-session' + (session.id === props.activeId && props.view === 'chat' ? ' active' : '')}
              onClick={() => props.onSelect(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onSelect(session.id)
                }
              }}
            >
              <div className="workbench-session-title">
                <span>{session.title}</span>
                {running && <span className="workbench-running-dot" aria-label="正在处理" />}
              </div>
              <div className="workbench-session-preview">{running ? 'Agent 正在处理…' : session.preview}</div>
              <div className="workbench-session-meta">
                <span>{session.updatedAt}</span>
                {session.demo && <span>演示</span>}
              </div>
              <button
                className="workbench-session-delete"
                title="删除会话"
                onClick={(event) => {
                  event.stopPropagation()
                  props.onDelete(session.id)
                }}
              >
                删除
              </button>
            </div>
          )
        })}
      </div>

      <footer className="workbench-sidebar-footer">
        <span className="workbench-avatar">C</span>
        <span><strong>Chuang</strong><small>本地模式</small></span>
      </footer>
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

function selectedSkillForTurn(turn: TurnGroup | undefined): { name: string; description: string } | null {
  if (!turn) return null
  const run = turn.runs.find(
    (item) => item.title.startsWith('决定使用 ') || item.title.startsWith('选择 ')
  )
  if (!run) return null
  return {
    name: run.title.replace(/^决定使用 /, '').replace(/^选择 /, ''),
    description: run.detail.replace(/^用途：/, '') || '本轮已使用该 Skill'
  }
}

function contextCountForTurn(turn: TurnGroup | undefined): string {
  if (!turn) return '—'
  const run = turn.runs.find(
    (item) => item.title.startsWith('已带入 ') || item.title.includes('滚动摘要和')
  )
  if (!run) return '—'
  const count = run.title.match(/(\d+)\s*条/)
  return count ? `${count[1]} 条会话消息` : run.title
}

function ChatPanel(props: {
  session: Session
  turns: TurnGroup[]
  busy: boolean
  memories: MemoryItem[]
  onSend: (text: string) => void
  onRename: (id: string, title: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setEditingTitle(false)
  }, [props.session.id])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [props.session.id, props.session.messages.length, props.session.runs.length])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const next = Math.min(textarea.scrollHeight, 160)
    textarea.style.height = next + 'px'
    textarea.style.overflowY = textarea.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [draft])

  const submit = (): void => {
    const text = draft.trim()
    if (!text || props.busy) return
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

  const latest = useMemo(
    () => [...props.turns].reverse().find((turn) => turn.user || turn.runs.length > 0),
    [props.turns]
  )
  const selectedSkill = useMemo(() => selectedSkillForTurn(latest), [latest])
  const contextCount = useMemo(() => contextCountForTurn(latest), [latest])

  return (
    <main className="workbench-chat-surface">
      <section className="workbench-chat-main">
        <div className="workbench-message-list" ref={listRef}>
          <header className="workbench-document-header">
            <div className="workbench-document-kicker">
              CHAT / {props.session.updatedAt}
              {selectedSkill && <span>{selectedSkill.name}</span>}
              {props.session.demo && <span>演示数据</span>}
            </div>
            {editingTitle ? (
              <div className="workbench-title-edit">
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
                <button onClick={saveRename}>保存</button>
                <button onClick={() => setEditingTitle(false)}>取消</button>
              </div>
            ) : (
              <div className="workbench-document-title-row">
                <h1>{props.session.title}</h1>
                <button onClick={startRename}>重命名</button>
              </div>
            )}
            <p>桌面会话 · 本地处理 · 完整消息与执行记录均保存在当前设备</p>
          </header>

          {props.turns.length === 0 && (
            <div className="workbench-empty-chat">
              <strong>开始一次新的协作</strong>
              <span>从下方输入任务，ChuangDex 会在这里展示回复和真实执行过程。</span>
            </div>
          )}

          {props.turns.map((turn) => (
            <section key={turn.turnId} className="workbench-turn">
              {turn.user && (
                <div className="workbench-request">
                  <div className="workbench-request-label">
                    <strong>你的任务</strong>
                    <span>{turn.user.time}</span>
                  </div>
                  <div className="workbench-request-text">{turn.user.content}</div>
                </div>
              )}

              {(turn.runs.length > 0 || turn.running) && (
                <div className={'workbench-inline-status ' + runState(turn)}>
                  <span>{runStateLabel(turn)}</span>
                  <span>{turn.runs.length} 个步骤</span>
                  <span>{runDuration(turn) ?? (turn.running ? '执行中' : '—')}</span>
                </div>
              )}

              {turn.assistant && (
                <article className="workbench-response">
                  <div className="workbench-response-kicker">CHUANGDEX RESPONSE</div>
                  <div className="workbench-response-content">
                    <MarkdownMessage content={turn.assistant.content} />
                  </div>
                  <div className="workbench-response-time">{turn.assistant.time}</div>
                </article>
              )}
            </section>
          ))}
        </div>

        <form
          className="workbench-composer"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={props.busy ? '当前会话正在处理，请稍候…' : '继续和 ChuangDex 协作…'}
            disabled={props.busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            rows={1}
          />
          <button type="submit" disabled={props.busy}>
            {props.busy ? '处理中…' : '发送'}
          </button>
        </form>
      </section>

      <aside className="workbench-context">
        <header>
          <h2>协作上下文</h2>
          <p>当前会话可由前端确认的能力与信息</p>
        </header>
        <section>
          <div className="workbench-context-label">SELECTED SKILL</div>
          <strong>{selectedSkill?.name ?? '本轮未使用 Skill'}</strong>
          <p>{selectedSkill?.description ?? '当前请求按普通对话处理。'}</p>
        </section>
        <section>
          <div className="workbench-context-label">CONTEXT</div>
          <strong>{contextCount}</strong>
          <p>来自本轮真实执行记录。</p>
        </section>
        <section>
          <div className="workbench-context-label">当前长期记忆</div>
          {props.memories.length > 0 ? (
            <div className="workbench-memory-chips">
              {props.memories.slice(0, 4).map((memory) => (
                <span key={memory.id} title={memory.content}>{memory.content}</span>
              ))}
            </div>
          ) : (
            <p>当前没有长期记忆。</p>
          )}
        </section>
      </aside>
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

function taskRepeatLabel(repeat: TaskRepeatMode): string {
  return repeat === 'daily' ? '每天' : '每个工作日'
}

interface TaskDestination {
  key: string
  chatId: string
  channel: TaskChannel
}

function taskDestinations(tasks: TaskInfo[]): TaskDestination[] {
  const destinations = new Map<string, TaskDestination>()
  for (const task of tasks) {
    const key = `${task.channel}:${task.chatId}`
    destinations.set(key, { key, chatId: task.chatId, channel: task.channel })
  }
  return [...destinations.values()]
}

function taskChannelLabel(channel: TaskChannel): string {
  return channel === 'desktop' ? '桌面会话' : '飞书会话'
}

function TaskEditor(props: {
  task?: TaskInfo
  destinations: TaskDestination[]
  onCreate: (input: TaskCreateInput) => Promise<void>
  onUpdate: (input: TaskUpdateInput) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState(props.task?.text ?? '')
  const [time, setTime] = useState(props.task?.time ?? '09:00')
  const [repeat, setRepeat] = useState<TaskRepeatMode>(props.task?.repeat ?? 'daily')
  const defaultDestination = props.task
    ? `${props.task.channel}:${props.task.chatId}`
    : props.destinations[0]?.key ?? ''
  const [destinationKey, setDestinationKey] = useState(defaultDestination)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEditing = Boolean(props.task)

  const submit = async (): Promise<void> => {
    const trimmedText = text.trim()
    if (!trimmedText) {
      setError('请填写任务内容。')
      return
    }
    if (!time) {
      setError('请选择执行时间。')
      return
    }
    const destination = props.destinations.find((item) => item.key === destinationKey)
    if (!props.task && !destination) {
      setError('请先选择一个已有的投递会话。')
      return
    }

    setError(null)
    setSaving(true)
    try {
      if (props.task) {
        await props.onUpdate({
          id: props.task.id,
          channel: props.task.channel,
          text: trimmedText,
          time,
          repeat
        })
      } else if (destination) {
        await props.onCreate({
          chatId: destination.chatId,
          channel: destination.channel,
          text: trimmedText,
          time,
          repeat
        })
      }
      props.onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="task-editor"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="task-editor-title">{isEditing ? '编辑已安排任务' : '新增已安排任务'}</div>
      <label className="task-field task-field-wide">
        <span>任务内容</span>
        <textarea
          value={text}
          maxLength={500}
          rows={3}
          placeholder="例如：提醒我整理今天的工作"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="task-editor-fields">
        <label className="task-field">
          <span>时间</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
        <label className="task-field">
          <span>重复</span>
          <select value={repeat} onChange={(event) => setRepeat(event.target.value as TaskRepeatMode)}>
            <option value="daily">每天</option>
            <option value="weekdays">每个工作日</option>
          </select>
        </label>
      </div>

      {isEditing ? (
        <div className="task-target-note">
          将继续发送到原来的{taskChannelLabel(props.task?.channel ?? 'desktop')}。
        </div>
      ) : (
        <label className="task-field">
          <span>发送到</span>
          {props.destinations.length === 1 ? (
            <div className="task-target-note">
              {taskChannelLabel(props.destinations[0].channel)}
            </div>
          ) : (
            <select value={destinationKey} onChange={(event) => setDestinationKey(event.target.value)}>
              {props.destinations.map((destination, index) => (
                <option key={destination.key} value={destination.key}>
                  {taskChannelLabel(destination.channel)} {index + 1}
                </option>
              ))}
            </select>
          )}
        </label>
      )}

      {error && <div className="task-form-error">{error}</div>}
      <div className="task-editor-actions">
        <button className="btn" type="button" disabled={saving} onClick={props.onCancel}>取消</button>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}

function ScheduledView(props: {
  tasks: TaskInfo[]
  onCreate: (input: TaskCreateInput) => Promise<void>
  onUpdate: (input: TaskUpdateInput) => Promise<void>
  onRemove: (input: TaskRemoveInput) => Promise<void>
}): JSX.Element {
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; task: TaskInfo } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const destinations = useMemo(() => taskDestinations(props.tasks), [props.tasks])
  const canCreate = destinations.length > 0

  const removeTask = async (task: TaskInfo): Promise<void> => {
    setActionError(null)
    setRemovingId(task.id)
    try {
      await props.onRemove({ id: task.id, channel: task.channel })
      setPendingRemove(null)
      setEditor(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <main className="panel chat data-view">
      <div className="panel-header chat-header">
        <span className="chat-title">已安排</span>
        <button
          className="btn small primary"
          title={canCreate ? '新增定时任务' : '请先从聊天框创建一个任务以确定投递会话'}
          disabled={!canCreate}
          onClick={() => {
            setActionError(null)
            setPendingRemove(null)
            setEditor({ mode: 'create' })
          }}
        >
          新增任务
        </button>
      </div>
      <div className="data-list">
        {editor && (
          <TaskEditor
            key={editor.mode === 'edit' ? editor.task.id : 'new-task'}
            task={editor.mode === 'edit' ? editor.task : undefined}
            destinations={destinations}
            onCreate={props.onCreate}
            onUpdate={props.onUpdate}
            onCancel={() => setEditor(null)}
          />
        )}

        {!canCreate && (
          <div className="task-source-note">
            请先在桌面聊天框或飞书中用自然语言创建一次任务，之后可在这里继续新增和管理。
          </div>
        )}

        {actionError && <div className="task-form-error">{actionError}</div>}

        {props.tasks.length === 0 ? (
          <div className="empty-state">暂无已安排任务</div>
        ) : (
          props.tasks.map((task) => (
            <div key={task.id} className="data-item">
              <div className="data-item-head">
                <div>
                  <div className="data-title">{task.text}</div>
                  <div className="data-meta">
                    {taskChannelLabel(task.channel)} · {taskRepeatLabel(task.repeat)} · {task.time} · 下次 {task.nextRunAt}
                  </div>
                </div>
                <div className="data-actions">
                  <button
                    className="data-action"
                    disabled={removingId === task.id}
                    onClick={() => {
                      setActionError(null)
                      setPendingRemove(null)
                      setEditor({ mode: 'edit', task })
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="data-action danger"
                    disabled={removingId === task.id}
                    onClick={() => {
                      setActionError(null)
                      setEditor(null)
                      setPendingRemove(task.id)
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>

              {pendingRemove === task.id && (
                <div className="task-delete-confirm">
                  <span>确定删除这个任务吗？删除后不会再执行。</span>
                  <div className="data-actions">
                    <button className="data-action" disabled={removingId === task.id} onClick={() => setPendingRemove(null)}>取消</button>
                    <button
                      className="data-action danger"
                      disabled={removingId === task.id}
                      onClick={() => void removeTask(task)}
                    >
                      {removingId === task.id ? '删除中…' : '确认删除'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </main>
  )
}

function SkillsView({ skills }: { skills: SkillInfo[] }): JSX.Element {
  return (
    <main className="panel chat data-view">
      <div className="panel-header chat-header">
        <span className="chat-title">Skills</span>
      </div>
      <div className="data-list">
        {skills.length === 0 ? (
          <div className="empty-state">暂无可用 Skills</div>
        ) : (
          skills.map((skill) => (
            <div key={skill.name} className="data-item">
              <div className="data-title">{skill.name}</div>
              <div className="data-description">{skill.description}</div>
            </div>
          ))
        )}
      </div>
    </main>
  )
}

function mcpStatusLabel(status: McpServerInfo['status']): string {
  if (status === 'connected') return '已连接'
  if (status === 'connecting') return '连接中'
  if (status === 'disabled') return '已停用'
  if (status === 'error') return '连接失败'
  return '已断开'
}

function McpServerEditor(props: {
  server?: McpServerInfo
  onSave: (input: McpServerInput) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(props.server?.name ?? '')
  const [command, setCommand] = useState(props.server?.command ?? '')
  const [argsText, setArgsText] = useState(props.server?.args.join('\n') ?? '')
  const [enabled, setEnabled] = useState(props.server?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    if (!name.trim() || !command.trim()) {
      setError('请填写 Server 名称和启动命令。')
      return
    }
    setSaving(true)
    try {
      await props.onSave({
        name: name.trim(),
        command: command.trim(),
        args: argsText.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean),
        enabled
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="task-editor mcp-editor" onSubmit={(event) => void submit(event)}>
      <div className="task-editor-title">{props.server ? '编辑 MCP Server' : '新增 MCP Server'}</div>
      <div className="task-source-note">
        第一版只支持本地 stdio，不支持环境变量、Token、远程 HTTP 或 OAuth。
        MCP Server 是本机程序，只添加你信任的 Server；每个参数单独占一行。
      </div>
      <div className="task-editor-fields">
        <label className="task-field">
          <span>名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 demo" />
        </label>
        <label className="task-field">
          <span>启动命令</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如 node" />
        </label>
      </div>
      <label className="task-field task-field-wide">
        <span>参数（每行一项）</span>
        <textarea
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
          placeholder={'/完整路径/server.mjs\n--example'}
        />
      </label>
      <label className="mcp-enabled-field">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>启用并连接</span>
      </label>
      {error && <div className="task-form-error">{error}</div>}
      <div className="task-editor-actions">
        <button className="btn" type="button" disabled={saving} onClick={props.onCancel}>取消</button>
        <button className="btn primary" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </form>
  )
}

function McpView(props: {
  servers: McpServerInfo[]
  onCreate: (input: McpServerInput) => Promise<void>
  onUpdate: (input: McpServerUpdateInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onReconnect: (id: string) => Promise<void>
}): JSX.Element {
  const [editor, setEditor] = useState<McpServerInfo | 'create' | null>(null)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runAction = async (id: string, action: () => Promise<void>): Promise<void> => {
    setError(null)
    setBusyId(id)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main className="panel chat data-view">
      <div className="panel-header chat-header">
        <span className="chat-title">MCP</span>
        <button className="btn small primary" onClick={() => { setError(null); setEditor('create') }}>
          新增 Server
        </button>
      </div>
      <div className="data-list">
        {editor && (
          <McpServerEditor
            key={editor === 'create' ? 'new-mcp' : editor.id}
            server={editor === 'create' ? undefined : editor}
            onSave={async (input) => {
              if (editor === 'create') await props.onCreate(input)
              else await props.onUpdate({ id: editor.id, ...input })
              setEditor(null)
            }}
            onCancel={() => setEditor(null)}
          />
        )}

        {error && <div className="task-form-error">{error}</div>}
        {props.servers.length === 0 ? (
          <div className="empty-state">暂无 MCP Server</div>
        ) : (
          props.servers.map((server) => (
            <div key={server.id} className="data-item mcp-server-item">
              <div className="data-item-head">
                <div>
                  <div className="mcp-server-title-row">
                    <span className="data-title">{server.name}</span>
                    <span className={`mcp-status ${server.status}`}>{mcpStatusLabel(server.status)}</span>
                  </div>
                  <div className="data-meta mcp-command">
                    {server.command}{server.args.length > 0 ? ` · ${server.args.join(' · ')}` : ''}
                  </div>
                </div>
                <div className="data-actions">
                  {server.enabled && (
                    <button
                      className="data-action"
                      disabled={busyId === server.id}
                      onClick={() => void runAction(server.id, () => props.onReconnect(server.id))}
                    >
                      {busyId === server.id ? '连接中…' : '重连'}
                    </button>
                  )}
                  <button className="data-action" disabled={busyId === server.id} onClick={() => setEditor(server)}>编辑</button>
                  <button className="data-action danger" disabled={busyId === server.id} onClick={() => setPendingRemove(server.id)}>删除</button>
                </div>
              </div>
              {server.error && <div className="mcp-error">{server.error}</div>}
              <div className="mcp-tools-title">可用工具 {server.tools.length}</div>
              {server.tools.length > 0 ? (
                <div className="mcp-tools">
                  {server.tools.map((tool) => (
                    <div key={tool.name} className="mcp-tool">
                      <span>{tool.name}</span>
                      {tool.description && <small>{tool.description}</small>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="data-description">当前没有发现工具。</div>
              )}
              {pendingRemove === server.id && (
                <div className="task-delete-confirm">
                  <span>删除后会立即断开这个 Server。</span>
                  <div className="data-actions">
                    <button className="data-action" onClick={() => setPendingRemove(null)}>取消</button>
                    <button
                      className="data-action danger"
                      disabled={busyId === server.id}
                      onClick={() => void runAction(server.id, async () => {
                        await props.onRemove(server.id)
                        setPendingRemove(null)
                        if (editor !== 'create' && editor?.id === server.id) setEditor(null)
                      })}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </main>
  )
}

function MemoryView(props: {
  memories: MemoryItem[]
  onUpdate: (input: MemoryUpdateInput) => Promise<void>
  onRemove: (id: string) => Promise<void>
}): JSX.Element {
  const [removing, setRemoving] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const beginEditing = (memory: MemoryItem): void => {
    setEditing(memory.id)
    setDraft(memory.content)
    setError('')
  }

  const cancelEditing = (): void => {
    if (saving) return
    setEditing(null)
    setDraft('')
    setError('')
  }

  const handleUpdate = async (memory: MemoryItem): Promise<void> => {
    const content = draft.trim()
    if (!content) {
      setError('记忆内容不能为空')
      return
    }
    if (content === memory.content) {
      cancelEditing()
      return
    }

    setSaving(true)
    setError('')
    try {
      await props.onUpdate({ id: memory.id, content })
      setEditing(null)
      setDraft('')
    } catch (updateError) {
      const message = updateError instanceof Error ? updateError.message : String(updateError)
      const knownMessage = [
        '记忆内容不能为空',
        '单条记忆不能超过 500 个字符',
        '记忆已达容量上限',
        '相同记忆已经存在',
        '记忆包含敏感信息，已拒绝保存',
        '这条记忆已不存在'
      ].find((candidate) => message.includes(candidate))
      setError(knownMessage ?? '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async (id: string): Promise<void> => {
    setRemoving(id)
    try {
      await props.onRemove(id)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <main className="panel chat data-view">
      <div className="panel-header chat-header">
        <span className="chat-title">记忆</span>
      </div>
      <div className="data-list">
        {props.memories.length === 0 ? (
          <div className="empty-state">暂无长期记忆</div>
        ) : (
          props.memories.map((memory) => (
            <div key={memory.id} className="data-item memory-item">
              {editing === memory.id ? (
                <div className="memory-editor">
                  <label className="memory-editor-label" htmlFor={`memory-${memory.id}`}>
                    编辑记忆
                  </label>
                  <textarea
                    id={`memory-${memory.id}`}
                    autoFocus
                    maxLength={500}
                    value={draft}
                    disabled={saving}
                    onChange={(event) => {
                      setDraft(event.target.value)
                      if (error) setError('')
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') cancelEditing()
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        event.preventDefault()
                        void handleUpdate(memory)
                      }
                    }}
                  />
                  <div className="memory-editor-footer">
                    <span className="memory-character-count">{Array.from(draft).length}/500</span>
                    <div className="data-actions">
                      <button className="data-action" disabled={saving} onClick={cancelEditing}>取消</button>
                      <button
                        className="data-action primary"
                        disabled={saving || !draft.trim() || draft.trim() === memory.content}
                        onClick={() => void handleUpdate(memory)}
                      >
                        {saving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                  {error && <div className="task-form-error" role="alert">{error}</div>}
                </div>
              ) : (
                <div className="data-item-head">
                  <div>
                    <div className="data-title">{memory.content}</div>
                    <div className="data-meta">
                      创建于 {new Date(memory.createdAt).toLocaleString('zh-CN')}
                      {memory.updatedAt > memory.createdAt && (
                        <> · 更新于 {new Date(memory.updatedAt).toLocaleString('zh-CN')}</>
                      )}
                    </div>
                  </div>
                  <div className="data-actions">
                    <button
                      className="data-action"
                      disabled={removing === memory.id}
                      onClick={() => beginEditing(memory)}
                    >
                      编辑
                    </button>
                    <button
                      className="data-action danger"
                      disabled={removing === memory.id}
                      onClick={() => void handleRemove(memory.id)}
                    >
                      {removing === memory.id ? '删除中…' : '删除'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </main>
  )
}

function WorkspaceTabs(props: {
  sessions: Session[]
  openSessionIds: string[]
  activeId: string
  view: AppView
  busy: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewChat: () => void
}): JSX.Element {
  const opened = props.openSessionIds
    .map((id) => props.sessions.find((session) => session.id === id))
    .filter((session): session is Session => Boolean(session))

  return (
    <header className="workbench-tabbar">
      <div className="workbench-tabs" role="tablist" aria-label="已打开的会话">
        {opened.map((session) => (
          <div
            key={session.id}
            className={'workbench-tab' + (props.view === 'chat' && session.id === props.activeId ? ' active' : '')}
          >
            <button
              className="workbench-tab-select"
              role="tab"
              aria-selected={props.view === 'chat' && session.id === props.activeId}
              onClick={() => props.onSelect(session.id)}
            >
              {session.title}
            </button>
            <button
              className="workbench-tab-close"
              title={`关闭「${session.title}」标签`}
              onClick={() => props.onClose(session.id)}
            >
              关闭
            </button>
          </div>
        ))}
        <button className="workbench-tab-new" onClick={props.onNewChat}>新建</button>
      </div>
      <div className={'workbench-agent-state' + (props.busy ? ' busy' : '')}>
        <span className="workbench-agent-dot" />
        {props.busy ? 'Agent 正在执行' : '本地模式'}
      </div>
    </header>
  )
}

function shouldShowRunInTray(run: RunRecord): boolean {
  if (run.status === 'failed') return true

  const duplicatedByContextPanel = [
    /^读取会话历史$/,
    /^已带入 /,
    /^发现 Skills$/,
    /^正在判断是否需要 Skill$/,
    /^决定使用 /,
    /^决定不使用 Skill$/,
    /^选择 /,
    /^未匹配 Skill$/,
    /^正在判断是否需要更新记忆$/,
    /^准备回忆记忆$/,
    /^记忆无需更新$/,
    /^已处理 \d+ 项记忆操作$/
  ]
  if (duplicatedByContextPanel.some((pattern) => pattern.test(run.title))) return false

  const instantBookkeeping = [
    /^收到消息$/,
    /^已收到模型回复$/,
    /^会话已自动命名$/
  ]
  return !instantBookkeeping.some((pattern) => pattern.test(run.title))
}

function RunTray({ turn }: { turn: TurnGroup | undefined }): JSX.Element {
  const stepsRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const visibleRuns = useMemo(
    () => turn?.runs.filter(shouldShowRunInTray) ?? [],
    [turn]
  )
  const completed = visibleRuns.filter((run) => run.status === 'success').length

  useEffect(() => {
    const steps = stepsRef.current
    if (!steps) return

    const updateScrollControls = (): void => {
      setCanScrollLeft(steps.scrollLeft > 2)
      setCanScrollRight(steps.scrollLeft + steps.clientWidth < steps.scrollWidth - 2)
    }

    updateScrollControls()
    steps.addEventListener('scroll', updateScrollControls, { passive: true })
    const resizeObserver = new ResizeObserver(updateScrollControls)
    resizeObserver.observe(steps)

    return () => {
      steps.removeEventListener('scroll', updateScrollControls)
      resizeObserver.disconnect()
    }
  }, [visibleRuns.length])

  useEffect(() => {
    const steps = stepsRef.current
    if (!steps) return
    const runningStep = steps.querySelector<HTMLElement>('[data-run-status="running"]')
    if (!runningStep) return
    const targetLeft = runningStep.offsetLeft - (steps.clientWidth - runningStep.clientWidth) / 2
    steps.scrollTo({ left: Math.max(0, targetLeft), behavior: 'smooth' })
  }, [visibleRuns.map((run) => `${run.id}:${run.status}`).join('|')])

  const scrollPage = (direction: -1 | 1): void => {
    const steps = stepsRef.current
    if (!steps) return
    const distance = Math.max(steps.clientWidth * 0.85, 185)
    steps.scrollBy({ left: direction * distance, behavior: 'smooth' })
  }

  return (
    <section className="workbench-run-tray">
      <div className="workbench-run-summary">
        <div className="workbench-run-label">THIS RUN</div>
        <strong>{turn ? runDuration(turn) ?? (turn.running ? '执行中' : '—') : '—'}</strong>
        <p>
          {turn
            ? `${completed}/${visibleRuns.length} 个关键步骤完成`
            : '当前会话暂无执行记录'}
        </p>
        {turn && <span className={'workbench-run-state ' + runState(turn)}>{runStateLabel(turn)}</span>}
      </div>
      <div className="workbench-run-track">
        <div className="workbench-run-steps" ref={stepsRef}>
          {turn && visibleRuns.length > 0 ? (
            visibleRuns.map((run, index) => (
              <article
                key={run.id}
                className={'workbench-run-step ' + run.status}
                data-run-status={run.status}
                aria-current={run.status === 'running' ? 'step' : undefined}
              >
                <div className="workbench-run-step-head">
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <time>{run.time}</time>
                </div>
                <strong>{run.title}</strong>
                <p>{run.detail}</p>
              </article>
            ))
          ) : (
            <div className="workbench-run-empty">
              {turn?.running
                ? '正在准备需要持续展示的关键步骤…'
                : '本轮没有需要持续展示的关键步骤。'}
            </div>
          )}
        </div>
        {canScrollLeft && (
          <button
            type="button"
            className="workbench-run-page-button left"
            aria-label="向左翻一页"
            onClick={() => scrollPage(-1)}
          >
            <CaretLeft size={18} weight="bold" />
          </button>
        )}
        {canScrollRight && (
          <button
            type="button"
            className="workbench-run-page-button right"
            aria-label="向右翻一页"
            onClick={() => scrollPage(1)}
          >
            <CaretRight size={18} weight="bold" />
          </button>
        )}
      </div>
    </section>
  )
}

function EmptyRunPanel(props: { collapsed: boolean; onToggle: () => void }): JSX.Element {
  if (props.collapsed) {
    return (
      <aside className="panel side-collapsed">
        <button className="icon-btn" title="展开执行面板" onClick={props.onToggle}>«</button>
      </aside>
    )
  }
  return (
    <aside className="panel runs">
      <div className="panel-header">
        <span>本次执行</span>
        <button className="icon-btn" title="收起执行面板" onClick={props.onToggle}>»</button>
      </div>
      <div className="ctx-body">
        <div className="ctx-section">
          <div className="ctx-empty">当前没有正在执行的对话。</div>
        </div>
      </div>
    </aside>
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>(mockSessions)
  const [activeId, setActiveId] = useState<string>(mockSessions[0].id)
  const [openSessionIds, setOpenSessionIds] = useState<string[]>([mockSessions[0].id])
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<AppView>('chat')
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [memories, setMemories] = useState<MemoryItem[]>([])
  /** 仅表示本次应用运行期间真实在途的桌面请求，不持久化到会话存档。 */
  const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(() => new Set())

  const refreshTasks = async (): Promise<void> => {
    const nextTasks = await window.chuangdex.tasks.load()
    setTasks(nextTasks)
  }

  const refreshSkills = async (): Promise<void> => {
    const nextSkills = await window.chuangdex.skills.load()
    setSkills(nextSkills)
  }

  const refreshMcp = async (): Promise<void> => {
    const nextServers = await window.chuangdex.mcp.load()
    setMcpServers(nextServers)
  }

  const refreshMemories = async (): Promise<void> => {
    const nextMemories = await window.chuangdex.memories.load()
    setMemories(nextMemories)
  }

  useEffect(() => {
    let cancelled = false
    window.chuangdex.sessions
      .load()
      .then((result) => {
        if (cancelled) return
        if (result && isValidSessionData(result.sessions)) {
          const restored = result.sessions
          const validIds = new Set(restored.map((session) => session.id))
          const restoredTabs = (result.openSessionIds ?? [result.activeId])
            .filter((id) => validIds.has(id))
          const nextTabs = Array.from(new Set(restoredTabs))
          setSessions(restored)
          const nextActiveId = validIds.has(result.activeId) ? result.activeId : restored[0].id
          setActiveId(nextActiveId)
          setOpenSessionIds(
            nextTabs.length > 0
              ? (nextTabs.includes(nextActiveId) ? nextTabs : [...nextTabs, nextActiveId])
              : [nextActiveId]
          )
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
      .save({ activeId, openSessionIds, sessions })
      .catch((error) => console.error('会话保存失败:', error))
  }, [sessions, activeId, openSessionIds, loaded])

  useEffect(() => {
    window.chuangdex
      .setTheme('light')
      .catch((error) => console.error('同步原生标题栏主题失败：', error))
  }, [])

  useEffect(() => {
    Promise.allSettled([
      refreshTasks(),
      refreshSkills(),
      refreshMcp(),
      refreshMemories()
    ]).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const labels = ['定时任务', 'Skills', 'MCP Server', '记忆']
          console.error(`加载${labels[index]}失败：`, result.reason)
        }
      })
    })
  }, [])

  // 查看“已安排”时，从主进程读取真实定时任务数据
  useEffect(() => {
    if (view !== 'scheduled') return
    refreshTasks().catch((error) => console.error('加载定时任务失败：', error))
  }, [view])

  // 查看“Skills”时，从主进程读取真实 Skills 数据
  useEffect(() => {
    if (view !== 'skills') return
    refreshSkills().catch((error) => console.error('加载 Skills 失败：', error))
  }, [view])

  // MCP 视图只展示本地 stdio Server 的实时状态和工具。
  useEffect(() => {
    if (view !== 'mcp') return
    refreshMcp().catch((error) => console.error('加载 MCP Server 失败：', error))
  }, [view])

  // 查看“记忆”时，从主进程读取真实记忆数据
  useEffect(() => {
    if (view !== 'memories') return
    refreshMemories().catch((error) => console.error('加载记忆失败：', error))
  }, [view])

  const active = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? sessions[0],
    [sessions, activeId]
  )
  const activeTurns = useMemo(() => groupTurns(active), [active])
  const latestTurn = useMemo(
    () => [...activeTurns].reverse().find((turn) => turn.user || turn.runs.length > 0),
    [activeTurns]
  )

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

  useEffect(() => {
    return window.chuangdex.agent.onScheduledDelivery((delivery) => {
      const message: Message = {
        id: delivery.id,
        role: 'assistant',
        content: delivery.content,
        time: delivery.time,
        turnId: delivery.turnId
      }
      const deliveredRuns: RunRecord[] = delivery.runs.map((run) => ({
        id: run.id,
        title: run.title,
        detail: run.detail,
        status: run.status,
        time: run.time,
        ts: run.ts,
        turnId: run.turnId
      }))

      setSessions((previous) => {
        const target = previous.find((session) => session.id === delivery.sessionId)
        if (!target) {
          return [
            {
              id: delivery.sessionId,
              title: '定时任务',
              preview: delivery.content.slice(0, 30),
              updatedAt: delivery.time,
              renamed: true,
              messages: [message],
              runs: deliveredRuns
            },
            ...previous
          ]
        }
        return previous.map((session) => {
          if (session.id !== delivery.sessionId) return session
          const messages = session.messages.some((item) => item.id === delivery.id)
            ? session.messages
            : [...session.messages, message]
          const runs = deliveredRuns.reduce(
            (items, run) => upsertRun(items, run),
            session.runs
          )
          return {
            ...session,
            preview: delivery.content.slice(0, 30),
            updatedAt: delivery.time,
            messages,
            runs
          }
        })
      })

      // 会话保存有 150ms 防抖；稍后确认，确保崩溃时仍可从主进程队列重投。
      window.setTimeout(() => {
        window.chuangdex.agent
          .ackScheduledDelivery(delivery.id)
          .catch((error) => console.error('确认定时任务结果失败：', error))
      }, 500)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return
    window.chuangdex.agent
      .readyForScheduledDeliveries()
      .catch((error) => console.error('启动定时任务结果投递失败：', error))
  }, [loaded])

  const handleNewChat = (): void => {
    const fresh = makeEmptySession(sessions)
    setSessions((previous) => [fresh, ...previous])
    setActiveId(fresh.id)
    setOpenSessionIds((previous) => [...previous, fresh.id])
    setView('chat')
  }

  const handleSelectSession = (id: string): void => {
    setActiveId(id)
    setOpenSessionIds((previous) => previous.includes(id) ? previous : [...previous, id])
    setView('chat')
  }

  const handleViewChat = (): void => setView('chat')
  const handleViewScheduled = (): void => setView('scheduled')
  const handleViewSkills = (): void => {
    setView('skills')
    refreshSkills().catch((error) => console.error('加载 Skills 失败：', error))
  }
  const handleViewMcp = (): void => {
    setView('mcp')
    refreshMcp().catch((error) => console.error('加载 MCP Server 失败：', error))
  }
  const handleViewMemories = (): void => {
    setView('memories')
    refreshMemories().catch((error) => console.error('加载记忆失败：', error))
  }

  const handleRemoveMemory = async (id: string): Promise<void> => {
    await window.chuangdex.memories.remove(id)
    await refreshMemories()
  }

  const handleUpdateMemory = async (input: MemoryUpdateInput): Promise<void> => {
    await window.chuangdex.memories.update(input)
    await refreshMemories()
  }

  const handleCreateTask = async (input: TaskCreateInput): Promise<void> => {
    await window.chuangdex.tasks.create(input)
    await refreshTasks()
  }

  const handleUpdateTask = async (input: TaskUpdateInput): Promise<void> => {
    await window.chuangdex.tasks.update(input)
    await refreshTasks()
  }

  const handleRemoveTask = async (input: TaskRemoveInput): Promise<void> => {
    await window.chuangdex.tasks.remove(input)
    await refreshTasks()
  }

  const handleCreateMcp = async (input: McpServerInput): Promise<void> => {
    await window.chuangdex.mcp.create(input)
    await refreshMcp()
  }

  const handleUpdateMcp = async (input: McpServerUpdateInput): Promise<void> => {
    await window.chuangdex.mcp.update(input)
    await refreshMcp()
  }

  const handleRemoveMcp = async (id: string): Promise<void> => {
    await window.chuangdex.mcp.remove(id)
    await refreshMcp()
  }

  const handleReconnectMcp = async (id: string): Promise<void> => {
    await window.chuangdex.mcp.reconnect(id)
    await refreshMcp()
  }

  const handleRequestDelete = (id: string): void => {
    const target = sessions.find((session) => session.id === id)
    if (target) setPendingDelete(target)
  }

  const handleCloseTab = (id: string): void => {
    const index = openSessionIds.indexOf(id)
    const nextOpenIds = openSessionIds.filter((sessionId) => sessionId !== id)
    if (id === activeId) {
      const fallbackId = nextOpenIds[Math.min(index, nextOpenIds.length - 1)]
        ?? sessions.find((session) => session.id !== id)?.id
      if (fallbackId) {
        if (!nextOpenIds.includes(fallbackId)) nextOpenIds.push(fallbackId)
        setActiveId(fallbackId)
      } else {
        const fresh = makeEmptySession(sessions)
        setSessions([fresh])
        nextOpenIds.push(fresh.id)
        setActiveId(fresh.id)
      }
    }
    setOpenSessionIds(nextOpenIds)
    setView('chat')
  }

  const handleConfirmDelete = (): void => {
    if (!pendingDelete) return
    const index = sessions.findIndex((session) => session.id === pendingDelete.id)
    const remaining = sessions.filter((session) => session.id !== pendingDelete.id)
    const nextOpenIds = openSessionIds.filter((id) => id !== pendingDelete.id)
    if (remaining.length === 0) {
      const fresh = makeEmptySession(remaining)
      setSessions([fresh])
      setActiveId(fresh.id)
      setOpenSessionIds([fresh.id])
    } else {
      setSessions(remaining)
      if (pendingDelete.id === activeId) {
        const nextActive = remaining[Math.min(index, remaining.length - 1)].id
        setActiveId(nextActive)
        if (!nextOpenIds.includes(nextActive)) nextOpenIds.push(nextActive)
      }
      setOpenSessionIds(nextOpenIds)
    }
    setPendingDelete(null)
  }

  const handleRename = (id: string, title: string): void => {
    setSessions((previous) =>
      previous.map((session) => (session.id === id ? { ...session, title, renamed: true } : session))
    )
  }

  const handleSend = (text: string): void => {
    const targetSessionId = activeId
    if (sendingSessionIds.has(targetSessionId)) return
    setSendingSessionIds((previous) => new Set(previous).add(targetSessionId))

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
    const history = active.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      turnId: message.turnId
    }))

    setSessions((previous) =>
      previous.map((session) =>
        session.id === targetSessionId
          ? { ...session, preview: text.slice(0, 30), updatedAt: time, messages: [...session.messages, userMessage] }
          : session
      )
    )

    window.chuangdex.agent
      .sendMessage({
        sessionId: targetSessionId,
        text,
        history,
        shortTermMemory: active.shortTermMemory,
        turnId
      })
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
            session.id === reply.sessionId
              ? {
                  ...session,
                  ...(reply.shortTermMemory ? { shortTermMemory: reply.shortTermMemory } : {}),
                  messages: [...session.messages, assistantMessage]
                }
              : session
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
            session.id === targetSessionId
              ? { ...session, messages: [...session.messages, assistantMessage] }
              : session
          )
        )
      })
      .finally(() => {
        setSendingSessionIds((previous) => {
          const next = new Set(previous)
          next.delete(targetSessionId)
          return next
        })
      })

    if (shouldAutoTitle) {
      window.chuangdex.agent
        .generateTitle({ sessionId: targetSessionId, text })
        .then(({ title }) => {
          if (!title) return
          setSessions((previous) =>
            previous.map((session) =>
              session.id === targetSessionId && !session.renamed ? { ...session, title } : session
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
    <div className="workbench-app">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        view={view}
        taskCount={tasks.length}
        skillCount={skills.length}
        mcpCount={mcpServers.length}
        memoryCount={memories.length}
        onSelect={handleSelectSession}
        onViewChat={handleViewChat}
        onViewScheduled={handleViewScheduled}
        onViewSkills={handleViewSkills}
        onViewMcp={handleViewMcp}
        onViewMemories={handleViewMemories}
        onDelete={handleRequestDelete}
      />

      <section className={'workbench-shell ' + (view === 'chat' ? 'chat-mode' : 'secondary-mode')}>
        <WorkspaceTabs
          sessions={sessions}
          openSessionIds={openSessionIds}
          activeId={activeId}
          view={view}
          busy={sendingSessionIds.size > 0}
          onSelect={handleSelectSession}
          onClose={handleCloseTab}
          onNewChat={handleNewChat}
        />

        {view === 'chat' && (
          <ChatPanel
            session={active}
            turns={activeTurns}
            busy={sendingSessionIds.has(active.id)}
            memories={memories}
            onSend={handleSend}
            onRename={handleRename}
          />
        )}

        {view === 'chat' && <RunTray turn={latestTurn} />}

        {view === 'scheduled' && (
          <div className="workbench-secondary-view">
          <ScheduledView
            tasks={tasks}
            onCreate={handleCreateTask}
            onUpdate={handleUpdateTask}
            onRemove={handleRemoveTask}
          />
          </div>
        )}

        {view === 'skills' && (
          <div className="workbench-secondary-view">
          <SkillsView skills={skills} />
          </div>
        )}

        {view === 'mcp' && (
          <div className="workbench-secondary-view">
          <McpView
            servers={mcpServers}
            onCreate={handleCreateMcp}
            onUpdate={handleUpdateMcp}
            onRemove={handleRemoveMcp}
            onReconnect={handleReconnectMcp}
          />
          </div>
        )}

        {view === 'memories' && (
          <div className="workbench-secondary-view">
          <MemoryView
            memories={memories}
            onUpdate={handleUpdateMemory}
            onRemove={handleRemoveMemory}
          />
          </div>
        )}
      </section>

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
