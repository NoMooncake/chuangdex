import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { McpServerInput, McpServerUpdateInput } from '../../shared/agent'

export interface McpServerConfig extends McpServerInput {
  id: string
}

interface McpServerFile {
  version: 1
  servers: McpServerConfig[]
}

const MAX_SERVERS = 20
const MAX_ARGS = 30
let serverSeq = 0

export class McpServerStore {
  constructor(private readonly filePath: string) {}

  load(): McpServerConfig[] {
    if (!existsSync(this.filePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as McpServerFile).servers)
          ? (parsed as McpServerFile).servers
          : []
      return candidates.slice(0, MAX_SERVERS).flatMap((value) => {
        const config = normalizeStoredConfig(value)
        return config ? [config] : []
      })
    } catch {
      return []
    }
  }

  create(input: McpServerInput): McpServerConfig {
    const servers = this.load()
    if (servers.length >= MAX_SERVERS) throw new Error(`最多配置 ${MAX_SERVERS} 个 MCP Server`)
    const normalized = normalizeInput(input)
    ensureUniqueName(servers, normalized.name)
    serverSeq += 1
    const server: McpServerConfig = {
      id: `mcp-${Date.now()}-${serverSeq}`,
      ...normalized
    }
    this.save([...servers, server])
    return server
  }

  update(input: McpServerUpdateInput): McpServerConfig {
    const servers = this.load()
    const index = servers.findIndex((server) => server.id === input.id)
    if (index === -1) throw new Error('MCP Server 不存在')
    const normalized = normalizeInput(input)
    ensureUniqueName(servers, normalized.name, input.id)
    const server: McpServerConfig = { id: input.id, ...normalized }
    const next = servers.slice()
    next[index] = server
    this.save(next)
    return server
  }

  remove(id: string): void {
    const servers = this.load()
    const next = servers.filter((server) => server.id !== id)
    if (next.length === servers.length) throw new Error('MCP Server 不存在')
    this.save(next)
  }

  private save(servers: McpServerConfig[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    const payload: McpServerFile = { version: 1, servers }
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tempPath, this.filePath)
  }
}

function normalizeStoredConfig(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !/^mcp-[a-zA-Z0-9-]+$/.test(record.id)) return null
  try {
    return { id: record.id, ...normalizeInput(record as unknown as McpServerInput) }
  } catch {
    return null
  }
}

function normalizeInput(input: McpServerInput): McpServerInput {
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  const command = typeof input?.command === 'string' ? input.command.trim() : ''
  const args = Array.isArray(input?.args)
    ? input.args.map((arg) => (typeof arg === 'string' ? arg.trim() : '')).filter(Boolean)
    : []

  if (!name || name.length > 40 || /[\u0000-\u001f]/.test(name)) {
    throw new Error('Server 名称必须为 1–40 个可见字符')
  }
  if (!command || command.length > 500 || command.includes('\0')) {
    throw new Error('启动命令不能为空，且不能超过 500 个字符')
  }
  if (args.length > MAX_ARGS || args.some((arg) => arg.length > 1_000 || arg.includes('\0'))) {
    throw new Error(`启动参数最多 ${MAX_ARGS} 项，每项不能超过 1000 个字符`)
  }
  const launchText = [command, ...args].join(' ').toLowerCase()
  if (/models\.local\.json|feishu\.local\.json|(^|[\s/])\.env([\s/]|$)/.test(launchText)) {
    throw new Error('MCP Server 配置不能引用应用密钥文件或 .env')
  }
  return { name, command, args, enabled: input.enabled === true }
}

function ensureUniqueName(servers: McpServerConfig[], name: string, excludeId?: string): void {
  if (servers.some((server) => server.id !== excludeId && server.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`已存在名为「${name}」的 MCP Server`)
  }
}
