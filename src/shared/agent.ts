// 主进程与渲染进程共享的 Agent 通信契约。
// 渲染进程只能通过 preload 暴露的 window.chuangdex.agent 间接使用这些类型。

export type RunStatus = 'success' | 'running' | 'failed'

/** 一条运行记录（右侧面板展示的数据单元） */
export interface AgentRunEvent {
  id: string
  sessionId: string
  title: string
  detail: string
  status: RunStatus
  time: string
  /** 真实时间戳（epoch ms），用于计算耗时 */
  ts?: number
  /** 界面分组标记：同一轮对话（用户消息→回复）的记录共享一个 turnId；
   *  自动命名等后台调用不带 turnId，界面据此分开归组 */
  turnId?: string
}

/** Agent 服务处理完成后的最终回复 */
export interface AgentReply {
  sessionId: string
  content: string
}

/** 自动命名结果：title 为 null 表示未生成（调用失败或未配置），界面保持原标题 */
export interface AgentTitleReply {
  sessionId: string
  title: string | null
}

/** 一条历史消息（多轮上下文用）：只含角色和内容，不含时间戳等界面数据 */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 渲染进程发给 Agent 服务的消息 */
export interface AgentSendPayload {
  sessionId: string
  text: string
  /** 当前会话的最近历史消息（按时间正序）；Agent 服务会再做过滤和截断 */
  history?: HistoryMessage[]
  /** 界面生成的轮次标记，Agent 服务原样贴到本轮所有运行记录上 */
  turnId?: string
}

/** IPC 通道名，集中在这一处定义，避免两端写错 */
export const AGENT_CHANNELS = {
  sendMessage: 'agent:send-message',
  generateTitle: 'agent:generate-title',
  runEvent: 'agent:run-event'
} as const

/** Skill 的桌面展示信息（不含工作说明正文） */
export interface SkillInfo {
  name: string
  description: string
}

export type TaskRepeatMode = 'daily' | 'weekdays'

/** 定时任务的桌面展示信息。chatId 仅用于在界面内选择已有投递会话，不直接展示。 */
export interface TaskInfo {
  id: string
  text: string
  repeat: TaskRepeatMode
  time: string
  nextRunAt: string
  chatId: string
}

/** 从桌面端新建定时任务时提交的最小信息。 */
export interface TaskCreateInput {
  chatId: string
  text: string
  time: string
  repeat: TaskRepeatMode
}

/** 桌面端可编辑的任务字段；投递会话保持不变。 */
export interface TaskUpdateInput {
  id: string
  text: string
  time: string
  repeat: TaskRepeatMode
}

export const SKILL_CHANNELS = {
  load: 'skills:load'
} as const

export const TASK_CHANNELS = {
  load: 'tasks:load',
  create: 'tasks:create',
  update: 'tasks:update',
  remove: 'tasks:remove'
} as const

/** 会话持久化载荷：主进程把 sessions 当作不透明 JSON 存取，不解析内容 */
export interface SessionsSavePayload {
  activeId: string
  sessions: unknown[]
}

/** 启动时恢复的结果；null 表示没有可用存档（文件缺失或损坏） */
export type SessionsLoadResult = SessionsSavePayload | null

export const SESSION_CHANNELS = {
  load: 'sessions:load',
  save: 'sessions:save'
} as const

/** 渲染进程点击外部链接时使用 */
export const APP_OPEN_EXTERNAL = 'app:open-external' as const
