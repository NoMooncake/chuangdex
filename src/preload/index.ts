import { contextBridge, ipcRenderer } from 'electron'
import {
  AGENT_CHANNELS,
  AgentReply,
  AgentRunEvent,
  AgentSendPayload,
  AgentTitleReply,
  ScheduledAgentDelivery,
  APP_OPEN_EXTERNAL,
  APP_SET_THEME,
  AppTheme,
  MEMORY_CHANNELS,
  MemoryItem,
  MemoryUpdateInput,
  MCP_CHANNELS,
  McpServerInfo,
  McpServerInput,
  McpServerUpdateInput,
  SESSION_CHANNELS,
  SessionsLoadResult,
  SessionsSavePayload,
  SKILL_CHANNELS,
  SkillInfo,
  TASK_CHANNELS,
  TaskCreateInput,
  TaskInfo,
  TaskRemoveInput,
  TaskUpdateInput
} from '../shared/agent'

// 渲染进程唯一可见的安全桥。
// 对话消息通过它进入主进程的 Agent 服务；运行记录通过它订阅回流。
const api = {
  appName: 'ChuangDex',
  platform: process.platform,
  agent: {
    /** 把用户消息交给主进程的 Agent 服务，返回最终回复 */
    sendMessage: (payload: AgentSendPayload): Promise<AgentReply> =>
      ipcRenderer.invoke(AGENT_CHANNELS.sendMessage, payload),

    /** 让 Agent 服务为会话生成自动标题（独立模型调用，失败返回 title: null） */
    generateTitle: (payload: AgentSendPayload): Promise<AgentTitleReply> =>
      ipcRenderer.invoke(AGENT_CHANNELS.generateTitle, payload),

    /** 订阅 Agent 服务逐步产生的运行记录，返回取消订阅函数 */
    onRunEvent: (handler: (event: AgentRunEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, run: AgentRunEvent): void =>
        handler(run)
      ipcRenderer.on(AGENT_CHANNELS.runEvent, listener)
      return () => {
        ipcRenderer.removeListener(AGENT_CHANNELS.runEvent, listener)
      }
    },

    /** 订阅后台桌面定时任务的执行结果。 */
    onScheduledDelivery: (handler: (delivery: ScheduledAgentDelivery) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, delivery: ScheduledAgentDelivery): void =>
        handler(delivery)
      ipcRenderer.on(AGENT_CHANNELS.scheduledDelivery, listener)
      return () => ipcRenderer.removeListener(AGENT_CHANNELS.scheduledDelivery, listener)
    },

    /** 会话存档恢复完成后通知主进程，可以安全投递后台结果。 */
    readyForScheduledDeliveries: (): Promise<void> =>
      ipcRenderer.invoke(AGENT_CHANNELS.scheduledReady),

    ackScheduledDelivery: (id: string): Promise<void> =>
      ipcRenderer.invoke(AGENT_CHANNELS.scheduledAck, id)
  },

  /** 会话持久化：文件读写由主进程负责，界面只提交/领取数据 */
  sessions: {
    /** 启动时恢复上次保存的会话列表；无存档时返回 null */
    load: (): Promise<SessionsLoadResult> => ipcRenderer.invoke(SESSION_CHANNELS.load),

    /** 会话数据有任何变化后调用，主进程防抖落盘 */
    save: (payload: SessionsSavePayload): Promise<void> =>
      ipcRenderer.invoke(SESSION_CHANNELS.save, payload)
  },

  /** 只读暴露 Skills 列表（不含工作说明正文和任何密钥） */
  skills: {
    load: (): Promise<SkillInfo[]> => ipcRenderer.invoke(SKILL_CHANNELS.load)
  },

  /** 已安排任务：界面只能操作任务本身，不能读取飞书配置或密钥。 */
  tasks: {
    load: (): Promise<TaskInfo[]> => ipcRenderer.invoke(TASK_CHANNELS.load),
    create: (input: TaskCreateInput): Promise<TaskInfo> => ipcRenderer.invoke(TASK_CHANNELS.create, input),
    update: (input: TaskUpdateInput): Promise<TaskInfo> => ipcRenderer.invoke(TASK_CHANNELS.update, input),
    remove: (input: TaskRemoveInput): Promise<void> =>
      ipcRenderer.invoke(TASK_CHANNELS.remove, input)
  },

  /** 外部链接：Markdown 中的链接通过主进程调用系统浏览器打开 */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(APP_OPEN_EXTERNAL, url),

  /** 长期记忆：界面可读取、编辑和删除；新增仍由 Agent 在对话中自主处理 */
  memories: {
    load: (): Promise<MemoryItem[]> => ipcRenderer.invoke(MEMORY_CHANNELS.load),
    update: (input: MemoryUpdateInput): Promise<MemoryItem> =>
      ipcRenderer.invoke(MEMORY_CHANNELS.update, input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(MEMORY_CHANNELS.remove, id)
  },

  /** 本地 stdio MCP：配置、连接状态和工具列表，不暴露环境变量或密钥。 */
  mcp: {
    load: (): Promise<McpServerInfo[]> => ipcRenderer.invoke(MCP_CHANNELS.load),
    create: (input: McpServerInput): Promise<McpServerInfo> =>
      ipcRenderer.invoke(MCP_CHANNELS.create, input),
    update: (input: McpServerUpdateInput): Promise<McpServerInfo> =>
      ipcRenderer.invoke(MCP_CHANNELS.update, input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(MCP_CHANNELS.remove, id),
    reconnect: (id: string): Promise<McpServerInfo> =>
      ipcRenderer.invoke(MCP_CHANNELS.reconnect, id)
  },

  /** 同步网页主题与 Electron 原生标题栏 */
  setTheme: (theme: AppTheme): Promise<void> => ipcRenderer.invoke(APP_SET_THEME, theme)
}

contextBridge.exposeInMainWorld('chuangdex', api)

export type ChuangDexBridge = typeof api
