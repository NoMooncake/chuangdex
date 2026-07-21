import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerInfo, McpServerInput, McpServerUpdateInput } from '../../shared/agent'
import type { ToolDefinition } from '../providers/types'
import { McpServerStore, type McpServerConfig } from './store'

interface DiscoveredTool {
  exposedName: string
  actualName: string
  description: string
  inputSchema: Record<string, unknown>
}

interface ServerConnection {
  config: McpServerConfig
  client: Client
  transport: StdioClientTransport
  tools: DiscoveredTool[]
}

interface ServerRuntimeState {
  status: McpServerInfo['status']
  error?: string
}

interface PendingConnection {
  generation: number
  client: Client
}

export interface ResolvedMcpTool {
  exposedName: string
  serverId: string
  serverName: string
  toolName: string
  description: string
}

export interface McpCallResult {
  serverId: string
  serverName: string
  toolName: string
  content: string
  isError: boolean
}

const CONNECT_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 60_000
const MAX_RESULT_CHARS = 64_000
const MAX_TOOLS_PER_SERVER = 100
const MAX_TOOL_DESCRIPTION_CHARS = 1_000
const MAX_TOOL_SCHEMA_CHARS = 64_000
const MAX_TOOL_PAGES = 20

export class McpManager {
  private readonly connections = new Map<string, ServerConnection>()
  private readonly pendingConnections = new Map<string, PendingConnection>()
  private readonly states = new Map<string, ServerRuntimeState>()
  private readonly generations = new Map<string, number>()
  private readonly operationQueues = new Map<string, Promise<void>>()
  private readonly intentionalClose = new WeakSet<Client>()

  constructor(
    private readonly store: McpServerStore,
    private readonly workspaceDir: string
  ) {}

  async startAll(): Promise<void> {
    const servers = this.store.load()
    for (const server of servers) {
      this.states.set(server.id, { status: server.enabled ? 'connecting' : 'disabled' })
    }
    await Promise.allSettled(
      servers.filter((server) => server.enabled).map((server) => {
        const generation = this.nextGeneration(server.id)
        return this.enqueue(server.id, () => this.connect(server, generation))
      })
    )
  }

  listServers(): McpServerInfo[] {
    return this.store.load().map((server) => this.toServerInfo(server))
  }

  async create(input: McpServerInput): Promise<McpServerInfo> {
    const server = this.store.create(input)
    this.states.set(server.id, { status: server.enabled ? 'connecting' : 'disabled' })
    if (server.enabled) {
      const generation = this.nextGeneration(server.id)
      await this.enqueue(server.id, () => this.connect(server, generation))
    }
    return this.toServerInfo(server)
  }

  async update(input: McpServerUpdateInput): Promise<McpServerInfo> {
    const generation = this.nextGeneration(input.id)
    const cancellation = this.cancelConnection(input.id)
    return this.enqueue(input.id, async () => {
      await cancellation
      const server = this.store.update(input)
      if (!this.isCurrent(input.id, generation)) return this.toServerInfo(server)
      this.states.set(server.id, { status: server.enabled ? 'connecting' : 'disabled' })
      if (server.enabled) await this.connect(server, generation)
      return this.toServerInfo(server)
    })
  }

  async remove(id: string): Promise<void> {
    this.nextGeneration(id)
    const cancellation = this.cancelConnection(id)
    await this.enqueue(id, async () => {
      await cancellation
      this.store.remove(id)
      this.states.delete(id)
    })
  }

  async reconnect(id: string): Promise<McpServerInfo> {
    const server = this.store.load().find((item) => item.id === id)
    if (!server) throw new Error('MCP Server 不存在')
    if (!server.enabled) throw new Error('请先启用这个 MCP Server')
    const generation = this.nextGeneration(id)
    const cancellation = this.cancelConnection(id)
    return this.enqueue(id, async () => {
      await cancellation
      if (this.isCurrent(id, generation)) await this.connect(server, generation)
      return this.toServerInfo(server)
    })
  }

  getToolDefinitions(): ToolDefinition[] {
    const definitions: ToolDefinition[] = []
    for (const connection of this.connections.values()) {
      if (this.states.get(connection.config.id)?.status !== 'connected') continue
      for (const tool of connection.tools) {
        definitions.push({
          type: 'function',
          function: {
            name: tool.exposedName,
            description: `来自 MCP Server「${connection.config.name}」：${tool.description || tool.actualName}`.slice(0, 1_000),
            parameters: tool.inputSchema
          }
        })
      }
    }
    return definitions
  }

  resolveTool(exposedName: string): ResolvedMcpTool | null {
    for (const connection of this.connections.values()) {
      if (this.states.get(connection.config.id)?.status !== 'connected') continue
      const tool = connection.tools.find((item) => item.exposedName === exposedName)
      if (tool) {
        return {
          exposedName,
          serverId: connection.config.id,
          serverName: connection.config.name,
          toolName: tool.actualName,
          description: tool.description
        }
      }
    }
    return null
  }

  async callTool(exposedName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const resolved = this.resolveTool(exposedName)
    if (!resolved) throw new Error('MCP 工具不存在或 Server 当前未连接')
    const connection = this.connections.get(resolved.serverId)
    if (!connection) throw new Error('MCP Server 当前未连接')

    const raw = await connection.client.callTool(
      { name: resolved.toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    )
    const normalized = normalizeToolResult(raw)
    return {
      serverId: resolved.serverId,
      serverName: resolved.serverName,
      toolName: resolved.toolName,
      content: normalized.content,
      isError: normalized.isError
    }
  }

  async closeAll(): Promise<void> {
    const ids = new Set([
      ...this.store.load().map((server) => server.id),
      ...this.connections.keys(),
      ...this.pendingConnections.keys()
    ])
    await Promise.allSettled([...ids].map(async (id) => {
      this.nextGeneration(id)
      await this.cancelConnection(id)
      await this.operationQueues.get(id)
      const server = this.store.load().find((item) => item.id === id)
      this.states.set(id, { status: server?.enabled ? 'disconnected' : 'disabled' })
    }))
  }

  private async connect(server: McpServerConfig, generation: number): Promise<void> {
    if (!this.isCurrent(server.id, generation)) return
    this.states.set(server.id, { status: 'connecting' })
    const client = new Client({ name: 'chuangdex', version: '0.1.0' })
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: this.workspaceDir,
      env: safeEnvironment(),
      stderr: 'pipe'
    })
    transport.stderr?.on('data', () => {
      // 主动消费 stderr，避免 Server 大量日志堵塞；不把其中可能含有的敏感内容展示到界面。
    })
    this.pendingConnections.set(server.id, { generation, client })

    client.onerror = (error) => {
      if (!this.ownsClient(server.id, generation, client) || this.intentionalClose.has(client)) return
      this.states.set(server.id, { status: 'error', error: conciseError(error) })
    }
    client.onclose = () => {
      this.deleteClientReferences(server.id, client)
      if (this.intentionalClose.has(client) || !this.isCurrent(server.id, generation)) return
      this.states.set(server.id, { status: 'disconnected', error: 'MCP Server 连接已关闭' })
    }

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      if (!this.isCurrent(server.id, generation)) {
        await this.closeClient(server.id, client)
        return
      }
      const tools = await listAllTools(client, server)
      if (!this.isCurrent(server.id, generation)) {
        await this.closeClient(server.id, client)
        return
      }
      const pending = this.pendingConnections.get(server.id)
      if (pending?.client === client) this.pendingConnections.delete(server.id)
      this.connections.set(server.id, { config: server, client, transport, tools })
      this.states.set(server.id, { status: 'connected' })
    } catch (err) {
      const error = conciseError(err)
      await this.closeClient(server.id, client)
      if (this.isCurrent(server.id, generation)) {
        this.states.set(server.id, { status: 'error', error })
      }
    }
  }

  private nextGeneration(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    return generation
  }

  private isCurrent(id: string, generation: number): boolean {
    return this.generations.get(id) === generation
  }

  private ownsClient(id: string, generation: number, client: Client): boolean {
    const pending = this.pendingConnections.get(id)
    if (pending?.client === client && pending.generation === generation) return true
    return this.connections.get(id)?.client === client && this.isCurrent(id, generation)
  }

  private deleteClientReferences(id: string, client: Client): void {
    if (this.pendingConnections.get(id)?.client === client) this.pendingConnections.delete(id)
    if (this.connections.get(id)?.client === client) this.connections.delete(id)
  }

  private async cancelConnection(id: string): Promise<void> {
    const clients = new Set<Client>()
    const pending = this.pendingConnections.get(id)
    if (pending) clients.add(pending.client)
    const connection = this.connections.get(id)
    if (connection) clients.add(connection.client)
    await Promise.allSettled([...clients].map((client) => this.closeClient(id, client)))
  }

  private async closeClient(id: string, client: Client): Promise<void> {
    this.intentionalClose.add(client)
    this.deleteClientReferences(id, client)
    try {
      await client.close()
    } catch {
      // 连接关闭失败不应阻塞后续的删除、更新或重连。
    }
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(id) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tracked = result.then(() => undefined, () => undefined)
    this.operationQueues.set(id, tracked)
    void tracked.then(() => {
      if (this.operationQueues.get(id) === tracked) this.operationQueues.delete(id)
    })
    return result
  }

  private toServerInfo(server: McpServerConfig): McpServerInfo {
    const state = this.states.get(server.id) ?? {
      status: server.enabled ? 'disconnected' : 'disabled'
    }
    const connection = this.connections.get(server.id)
    return {
      ...server,
      status: state.status,
      ...(state.error ? { error: state.error } : {}),
      tools: connection?.tools.map((tool) => ({
        name: tool.actualName,
        description: tool.description
      })) ?? []
    }
  }
}

async function listAllTools(client: Client, server: McpServerConfig): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = []
  const toolNames = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0
  do {
    pages += 1
    if (pages > MAX_TOOL_PAGES) throw new Error(`Server「${server.name}」返回的工具分页过多`)
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS })
    for (const tool of page.tools) {
      if (tools.length >= MAX_TOOLS_PER_SERVER) {
        throw new Error(`Server「${server.name}」的工具超过 ${MAX_TOOLS_PER_SERVER} 个`)
      }
      if (toolNames.has(tool.name)) continue
      const inputSchema = tool.inputSchema as Record<string, unknown>
      if (safeJson(inputSchema).length > MAX_TOOL_SCHEMA_CHARS) {
        throw new Error(`Server「${server.name}」的工具「${tool.name}」Schema 过大`)
      }
      toolNames.add(tool.name)
      tools.push({
        exposedName: exposedToolName(server, tool.name),
        actualName: tool.name,
        description: (tool.description?.trim() ?? '').slice(0, MAX_TOOL_DESCRIPTION_CHARS),
        inputSchema
      })
    }
    cursor = page.nextCursor
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error(`Server「${server.name}」返回了重复的分页标记`)
      seenCursors.add(cursor)
    }
  } while (cursor)
  return tools
}

function exposedToolName(server: McpServerConfig, toolName: string): string {
  const serverPart = safeToolPart(server.name).slice(0, 16) || 'server'
  const toolPart = safeToolPart(toolName).slice(0, 24) || 'tool'
  const hash = shortHash(`${server.id}:${toolName}`)
  return `mcp_${serverPart}_${toolPart}_${hash}`
}

function safeToolPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

function shortHash(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function normalizeToolResult(raw: unknown): { content: string; isError: boolean } {
  if (!raw || typeof raw !== 'object') return { content: String(raw ?? ''), isError: false }
  const record = raw as Record<string, unknown>
  if ('toolResult' in record) {
    return { content: limitResult(safeJson(record.toolResult)), isError: false }
  }

  const sections: string[] = []
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== 'object') continue
      const block = item as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        sections.push(block.text)
      } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
        const resource = block.resource as Record<string, unknown>
        if (typeof resource.text === 'string') sections.push(resource.text)
        else sections.push(`[资源：${String(resource.uri ?? '未知')}]`)
      } else if (block.type === 'resource_link') {
        sections.push(`[资源链接：${String(block.name ?? '')} ${String(block.uri ?? '')}]`.trim())
      } else if (block.type === 'image' || block.type === 'audio') {
        sections.push(`[${String(block.type)}：${String(block.mimeType ?? '未知类型')}]`)
      }
    }
  }
  if (record.structuredContent && typeof record.structuredContent === 'object') {
    sections.push(safeJson(record.structuredContent))
  }
  return {
    content: limitResult(sections.join('\n\n') || '工具调用完成，但没有返回可显示内容。'),
    isError: record.isError === true
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function limitResult(value: string): string {
  return value.length > MAX_RESULT_CHARS
    ? `${value.slice(0, MAX_RESULT_CHARS)}\n（结果已截断）`
    : value
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300) || '未知错误'
}

function safeEnvironment(): Record<string, string> {
  const allowed = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE',
    'HOMEPATH', 'PATHEXT', 'ComSpec'
  ]
  const result: Record<string, string> = { NO_COLOR: '1', CI: '1' }
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}
