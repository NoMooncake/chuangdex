import { useEffect, useMemo, useState } from 'react'
import { Message, mockSessions, RunRecord, RunStatus, Session } from './mock'

const statusLabel: Record<RunStatus, string> = {
  success: '成功',
  running: '运行中',
  failed: '失败'
}

function nowTime(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 按 id 追加或原地更新一条运行记录（running → success 的状态翻转靠它实现） */
function upsertRun(runs: RunRecord[], run: RunRecord): RunRecord[] {
  const idx = runs.findIndex((r) => r.id === run.id)
  if (idx === -1) return [...runs, run]
  const next = runs.slice()
  next[idx] = run
  return next
}

let sessionSeq = 0

/** 生成独立会话 ID（时间戳 + 序号，保证不与其他会话重复） */
function newSessionId(): string {
  sessionSeq += 1
  return `s-${Date.now()}-${sessionSeq}`
}

/** 校验主进程返回的存档结构，防止损坏数据进入界面 */
function isValidSessionData(data: unknown): data is Session[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.title === 'string' &&
        Array.isArray(s.messages) &&
        Array.isArray(s.runs)
    )
  )
}

/** “新对话”“新对话 2”“新对话 3”… 跳过已占用的名称 */
function nextSessionTitle(existing: Session[]): string {
  const titles = new Set(existing.map((s) => s.title))
  if (!titles.has('新对话')) return '新对话'
  let n = 2
  while (titles.has(`新对话 ${n}`)) n += 1
  return `新对话 ${n}`
}

/** 创建一个干净的空会话：独立 ID、空消息、空运行记录 */
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
        {props.sessions.map((s) => (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            className={`session-item ${s.id === props.activeId ? 'active' : ''}`}
            onClick={() => props.onSelect(s.id)}
            onKeyDown={(e) => e.key === 'Enter' && props.onSelect(s.id)}
          >
            <div className="session-title">{s.title}</div>
            <div className="session-preview">{s.preview}</div>
            <div className="session-time">{s.updatedAt}</div>
            <button
              className="session-delete"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation()
                props.onDelete(s.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="sidebar-footer">
        <span className="avatar">C</span>
        <span className="footer-name">Chuang</span>
        <span className="footer-status">本地模式</span>
      </div>
    </aside>
  )
}

function MessageBubble({ message }: { message: Message }): JSX.Element {
  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === 'user' ? '你' : 'AI'}</div>
      <div className="message-body">
        <div className="message-content">{message.content}</div>
        <div className="message-time">{message.time}</div>
      </div>
    </div>
  )
}

function ChatPanel(props: {
  session: Session
  onSend: (text: string) => void
  onRename: (id: string, title: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  // 切换会话时退出重命名状态
  useEffect(() => {
    setEditingTitle(false)
  }, [props.session.id])

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
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRename()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
            <button className="btn small" onClick={saveRename}>保存</button>
            <button className="btn small" onClick={() => setEditingTitle(false)}>取消</button>
          </span>
        ) : (
          <>
            <span className="chat-title">{props.session.title}</span>
            <button className="icon-btn title-edit-btn" title="重命名会话" onClick={startRename}>
              ✎
            </button>
          </>
        )}
        {props.session.demo && <span className="badge">演示数据</span>}
      </div>
      <div className="message-list">
        {props.session.messages.length === 0 && (
          <div className="empty-state">全新会话，从下方输入第一条消息开始。</div>
        )}
        {props.session.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
      <div className="composer">
        <textarea
          value={draft}
          placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
        />
        <button className="send-btn" onClick={submit}>发送</button>
      </div>
    </main>
  )
}

function RunPanel({ runs }: { runs: RunRecord[] }): JSX.Element {
  return (
    <aside className="panel runs">
      <div className="panel-header">
        <span>运行记录</span>
        <span className="badge">{runs.length} 条</span>
      </div>
      <div className="run-list">
        {runs.length === 0 && <div className="empty-state">暂无运行记录。</div>}
        {runs.map((r) => (
          <div key={r.id} className="run-item">
            <span className={`status-dot ${r.status}`} />
            <div className="run-info">
              <div className="run-title">{r.title}</div>
              <div className="run-detail">{r.detail}</div>
            </div>
            <div className="run-meta">
              <span className={`status-tag ${r.status}`}>{statusLabel[r.status]}</span>
              <span className="run-time">{r.time}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}

export default function App(): JSX.Element {
  const [sessions, setSessions] = useState<Session[]>(mockSessions)
  const [activeId, setActiveId] = useState<string>(mockSessions[0].id)
  /** 待确认删除的会话（非 null 时显示确认弹窗） */
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)
  /** 启动存档是否已加载（加载完成前不渲染主界面、不触发保存） */
  const [loaded, setLoaded] = useState(false)

  // 启动：从主进程恢复上次保存的会话列表和正在查看的会话；失败则保留演示会话
  useEffect(() => {
    let cancelled = false
    window.chuangdex.sessions
      .load()
      .then((result) => {
        if (cancelled) return
        if (result && isValidSessionData(result.sessions)) {
          const restored = result.sessions
          setSessions(restored)
          const exists = restored.some((s) => s.id === result.activeId)
          setActiveId(exists ? result.activeId : restored[0].id)
        }
        setLoaded(true)
      })
      .catch((err) => {
        console.error('会话存档加载失败，使用初始会话:', err)
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 持久化：会话数据或激活会话有任何变化（新建/删除/改名/自动命名/消息/运行记录）
  // 都把最新状态交给主进程落盘
  useEffect(() => {
    if (!loaded) return
    window.chuangdex.sessions
      .save({ activeId, sessions })
      .catch((err) => console.error('会话保存失败:', err))
  }, [sessions, activeId, loaded])

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId]
  )

  // 新建会话：创建干净的空会话并立即切换过去
  const handleCreate = (): void => {
    const fresh = makeEmptySession(sessions)
    setSessions((prev) => [fresh, ...prev])
    setActiveId(fresh.id)
  }

  // 点击删除入口：先弹出确认，不直接删
  const handleRequestDelete = (id: string): void => {
    const target = sessions.find((s) => s.id === id)
    if (target) setPendingDelete(target)
  }

  // 确认删除：优先切到被删会话的相邻会话；全部删光时自动新建一个空会话
  const handleConfirmDelete = (): void => {
    if (!pendingDelete) return
    const idx = sessions.findIndex((s) => s.id === pendingDelete.id)
    const remaining = sessions.filter((s) => s.id !== pendingDelete.id)

    if (remaining.length === 0) {
      const fresh = makeEmptySession(remaining)
      setSessions([fresh])
      setActiveId(fresh.id)
    } else {
      setSessions(remaining)
      if (pendingDelete.id === activeId) {
        setActiveId(remaining[Math.min(idx, remaining.length - 1)].id)
      }
    }
    setPendingDelete(null)
  }

  // 订阅 Agent 服务从主进程推回来的运行记录，实时追加/更新到右侧面板
  useEffect(() => {
    const unsubscribe = window.chuangdex.agent.onRunEvent((event) => {
      const record: RunRecord = {
        id: event.id,
        title: event.title,
        detail: event.detail,
        status: event.status,
        time: event.time
      }
      setSessions((prev) =>
        prev.map((s) =>
          s.id === event.sessionId ? { ...s, runs: upsertRun(s.runs, record) } : s
        )
      )
    })
    return unsubscribe
  }, [])

  // 手动重命名：打上 renamed 标记，此后自动命名不会再覆盖
  const handleRename = (id: string, title: string): void => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title, renamed: true } : s)))
  }

  // 消息流向：界面 → preload 安全桥 → 主进程 Agent 服务 →（运行记录实时回流）→ 最终回复
  const handleSend = (text: string): void => {
    const t = nowTime()
    const userMsg: Message = { id: `m-${Date.now()}-u`, role: 'user', content: text, time: t }

    // 是否“新会话的第一条消息”：是则稍后触发自动命名（手动命名过的会话不触发）
    const shouldAutoTitle = active.messages.length === 0 && !active.renamed

    // 多轮上下文：只取当前会话最近 12 条消息（仅角色+内容，不含运行记录等界面数据）
    const history = active.messages.slice(-12).map((m) => ({ role: m.role, content: m.content }))

    // 先在本地展示用户消息
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId
          ? { ...s, preview: text.slice(0, 30), updatedAt: t, messages: [...s.messages, userMsg] }
          : s
      )
    )

    // 通过 Electron 安全通信通道交给 Agent 服务；回复到达后追加到对话区
    window.chuangdex.agent
      .sendMessage({ sessionId: activeId, text, history })
      .then((reply) => {
        const assistantMsg: Message = {
          id: `m-${Date.now()}-a`,
          role: 'assistant',
          content: reply.content,
          time: nowTime()
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === reply.sessionId ? { ...s, messages: [...s.messages, assistantMsg] } : s
          )
        )
      })
      .catch((err) => console.error('Agent 服务调用失败:', err))

    // 独立的自动命名调用：与上面的聊天回复并行进行，失败不影响对话
    if (shouldAutoTitle) {
      window.chuangdex.agent
        .generateTitle({ sessionId: activeId, text })
        .then(({ title }) => {
          if (!title) return // 命名失败：保留“新对话”
          setSessions((prev) =>
            prev.map((s) =>
              // 落名前再次检查 renamed：等待模型期间用户可能已手动改名
              s.id === activeId && !s.renamed ? { ...s, title } : s
            )
          )
        })
        .catch((err) => console.error('自动命名失败（不影响对话）:', err))
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
    <div className="app">
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onCreate={handleCreate}
        onDelete={handleRequestDelete}
      />
      <ChatPanel session={active} onSend={handleSend} onRename={handleRename} />
      <RunPanel runs={active.runs} />

      {pendingDelete && (
        <div className="modal-overlay" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
