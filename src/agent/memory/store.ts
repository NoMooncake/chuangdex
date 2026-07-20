// 长期记忆持久化：保存到本机用户数据目录，重启后仍然可用。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { MemoryItem } from '../../shared/agent'

/** 最大记忆条数，防止无限增长 */
const MAX_MEMORIES = 50
/** 单条记忆只保存一个紧凑事实，避免把整段对话当作记忆 */
const MAX_MEMORY_CHARS = 500

export type MemoryStoreFailureReason =
  | 'empty'
  | 'too_long'
  | 'capacity'
  | 'duplicate'
  | 'sensitive'
  | 'not_found'

export type MemoryStoreResult =
  | { ok: true; item: MemoryItem }
  | { ok: false; reason: MemoryStoreFailureReason }

export class MemoryStore {
  constructor(private readonly filePath: string) {}

  load(): MemoryItem[] {
    if (!existsSync(this.filePath)) return []
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as unknown
      if (Array.isArray(data)) {
        return data.filter(
          (item): item is MemoryItem =>
            item &&
            typeof (item as MemoryItem).id === 'string' &&
            typeof (item as MemoryItem).content === 'string'
        )
      }
    } catch {
      // 文件损坏时返回空数组
    }
    return []
  }

  save(memories: MemoryItem[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(memories, null, 2), 'utf-8')
    renameSync(temporaryPath, this.filePath)
  }

  /** 添加一条原子记忆；重复、敏感或容量满时返回明确失败原因 */
  add(content: string): MemoryStoreResult {
    const memories = this.load()
    const validation = validateContent(content, memories)
    if (validation) return { ok: false, reason: validation }
    if (memories.length >= MAX_MEMORIES) return { ok: false, reason: 'capacity' }

    const now = Date.now()
    const item: MemoryItem = {
      id: `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
      content: content.trim(),
      createdAt: now,
      updatedAt: now
    }
    memories.push(item)
    this.save(memories)
    return { ok: true, item }
  }

  /** 根据稳定 id 更新内容；更新同样经过重复、长度和敏感信息检查 */
  update(id: string, content: string): MemoryStoreResult {
    const memories = this.load()
    const index = memories.findIndex((memory) => memory.id === id)
    if (index === -1) return { ok: false, reason: 'not_found' }

    const validation = validateContent(
      content,
      memories.filter((memory) => memory.id !== id)
    )
    if (validation) return { ok: false, reason: validation }

    const item = { ...memories[index], content: content.trim(), updatedAt: Date.now() }
    memories[index] = item
    this.save(memories)
    return { ok: true, item }
  }

  /** 根据稳定 id 删除并返回真实删除的条目 */
  remove(id: string): MemoryStoreResult {
    const memories = this.load()
    const index = memories.findIndex((memory) => memory.id === id)
    if (index === -1) return { ok: false, reason: 'not_found' }
    const [item] = memories.splice(index, 1)
    this.save(memories)
    return { ok: true, item }
  }
}

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ')
}

function validateContent(
  content: string,
  memories: MemoryItem[]
): MemoryStoreFailureReason | null {
  const trimmed = content.trim()
  if (!trimmed) return 'empty'
  if (Array.from(trimmed).length > MAX_MEMORY_CHARS) return 'too_long'
  const normalized = normalize(trimmed)
  if (memories.some((memory) => normalize(memory.content) === normalized)) return 'duplicate'
  if (isSensitive(trimmed)) return 'sensitive'
  return null
}

/** 拒绝保存敏感信息：密钥、密码、Token 等 */
function isSensitive(content: string): boolean {
  const lower = content.toLowerCase()
  const keywords = [
    'api key',
    'apikey',
    'secret',
    'app secret',
    'appsecret',
    'token',
    'password',
    '密码',
    '密钥',
    'bearer ',
    'sk-',
    'ak-',
    'authorization'
  ]
  if (keywords.some((keyword) => lower.includes(keyword))) return true
  // 拒绝看起来像长随机串的密钥
  if (/\b[a-zA-Z0-9+/]{32,}\b/.test(content)) return true
  if (/\b[a-f0-9]{32,}\b/.test(content)) return true
  return false
}
