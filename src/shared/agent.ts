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
  /** 本轮如果压缩了早期对话，返回新的会话级短期记忆供界面持久化 */
  shortTermMemory?: ShortTermMemoryState
}

/** 自动命名结果：title 为 null 表示未生成（调用失败或未配置），界面保持原标题 */
export interface AgentTitleReply {
  sessionId: string
  title: string | null
}

/** 一条历史消息（多轮上下文用）：只含角色和内容，不含时间戳等界面数据 */
export interface HistoryMessage {
  /** 桌面会话使用稳定 ID 记录摘要已覆盖到哪条消息；飞书可以不传 */
  id?: string
  role: 'user' | 'assistant'
  content: string
  /** 用于按完整 user/assistant 轮次切分压缩边界 */
  turnId?: string
}

/** 某个桌面会话的滚动摘要；完整原始消息仍保留在 Session 中 */
export interface ShortTermMemoryState {
  version: 1
  summary: string
  summarizedThroughMessageId: string
  updatedAt: number
}

/** 渲染进程发给 Agent 服务的消息 */
export interface AgentSendPayload {
  sessionId: string
  text: string
  /** 当前会话历史（按时间正序）；桌面端传全量，由 Agent 组装短期上下文 */
  history?: HistoryMessage[]
  /** 上一次持久化的会话滚动摘要；仅桌面会话使用 */
  shortTermMemory?: ShortTermMemoryState
  /** 界面生成的轮次标记，Agent 服务原样贴到本轮所有运行记录上 */
  turnId?: string
}

/** 后台桌面定时任务执行完成后，主进程投递回对应会话的完整结果。 */
export interface ScheduledAgentDelivery {
  id: string
  taskId: string
  taskText: string
  sessionId: string
  turnId: string
  content: string
  time: string
  runs: AgentRunEvent[]
}

/** IPC 通道名，集中在这一处定义，避免两端写错 */
export const AGENT_CHANNELS = {
  sendMessage: 'agent:send-message',
  generateTitle: 'agent:generate-title',
  runEvent: 'agent:run-event',
  scheduledDelivery: 'agent:scheduled-delivery',
  scheduledReady: 'agent:scheduled-ready',
  scheduledAck: 'agent:scheduled-ack'
} as const

/** Skill 的桌面展示信息（不含工作说明正文） */
export interface SkillInfo {
  name: string
  description: string
}

export type TaskRepeatMode = 'daily' | 'weekdays'
export type TaskChannel = 'desktop' | 'feishu'

/** 定时任务的桌面展示信息。chatId 仅用于在界面内选择已有投递会话，不直接展示。 */
export interface TaskInfo {
  id: string
  text: string
  repeat: TaskRepeatMode
  time: string
  cron?: string
  timezone?: string
  nextRunAt: string
  chatId: string
  channel: TaskChannel
}

/** 从桌面端新建定时任务时提交的最小信息。 */
export interface TaskCreateInput {
  chatId: string
  channel: TaskChannel
  text: string
  time: string
  repeat: TaskRepeatMode
  cron?: string
  timezone?: string
}

/** 桌面端可编辑的任务字段；投递会话保持不变。 */
export interface TaskUpdateInput {
  id: string
  channel: TaskChannel
  text: string
  time: string
  repeat: TaskRepeatMode
  cron?: string
  timezone?: string
}

export interface TaskRemoveInput {
  id: string
  channel: TaskChannel
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
  /** 工作台中当前打开的会话标签，顺序即界面顺序；旧存档可以没有此字段。 */
  openSessionIds?: string[]
  sessions: unknown[]
}

/** 启动时恢复的结果；null 表示没有可用存档（文件缺失或损坏） */
export type SessionsLoadResult = SessionsSavePayload | null

export const SESSION_CHANNELS = {
  load: 'sessions:load',
  save: 'sessions:save'
} as const

/** 一条长期记忆 */
export interface MemoryItem {
  id: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface MemoryUpdateInput {
  id: string
  content: string
}

export const MEMORY_CHANNELS = {
  load: 'memories:load',
  update: 'memories:update',
  remove: 'memories:remove'
} as const

export type McpServerStatus = 'disabled' | 'connecting' | 'connected' | 'error' | 'disconnected'

export interface McpToolInfo {
  name: string
  description: string
}

/** 桌面端展示的 MCP Server 信息；第一版不支持环境变量或远程鉴权。 */
export interface McpServerInfo {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  status: McpServerStatus
  error?: string
  tools: McpToolInfo[]
}

export interface McpServerInput {
  name: string
  command: string
  args: string[]
  enabled: boolean
}

export interface McpServerUpdateInput extends McpServerInput {
  id: string
}

export const MCP_CHANNELS = {
  load: 'mcp:load',
  create: 'mcp:create',
  update: 'mcp:update',
  remove: 'mcp:remove',
  reconnect: 'mcp:reconnect'
} as const

/** 渲染进程点击外部链接时使用 */
export const APP_OPEN_EXTERNAL = 'app:open-external' as const

/** 桌面主题：同时用于网页界面和 Electron 原生标题栏 */
export type AppTheme = 'light' | 'dark'
export const APP_SET_THEME = 'app:set-theme' as const
