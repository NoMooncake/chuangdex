import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpManager } from '../src/agent/mcp/manager'
import { McpServerStore } from '../src/agent/mcp/store'
import { MemoryStore } from '../src/agent/memory/store'

const tempDir = mkdtempSync(join(tmpdir(), 'chuangdex-review-regressions-'))
const managers: McpManager[] = []

try {
  testMemoryLoadLimits()
  await testRemoveDuringConnect()
  await testDisableDuringConnect()
  await testReconnectDuringConnect()
  console.log('REVIEW_REGRESSIONS_OK')
} finally {
  await Promise.allSettled(managers.map((manager) => manager.closeAll()))
  rmSync(tempDir, { recursive: true, force: true })
}

function testMemoryLoadLimits(): void {
  const memoryPath = join(tempDir, 'memories.json')
  const stored = Array.from({ length: 60 }, (_, index) => ({
    id: `mem-${index}`,
    content: index === 59 ? '🧠'.repeat(600) : `memory ${index}`,
    createdAt: index,
    updatedAt: index
  }))
  stored.splice(55, 0, { id: '', content: '', createdAt: 0, updatedAt: 0 })
  writeFileSync(memoryPath, JSON.stringify(stored), 'utf8')

  const memories = new MemoryStore(memoryPath).load()
  assert.equal(memories.length, 50)
  assert.equal(memories[0]?.id, 'mem-10')
  assert.equal(memories.at(-1)?.id, 'mem-59')
  assert.equal(Array.from(memories.at(-1)?.content ?? '').length, 500)
}

async function testRemoveDuringConnect(): Promise<void> {
  const caseDir = join(tempDir, 'remove-during-connect')
  const pidFile = join(caseDir, 'pids.txt')
  const store = new McpServerStore(join(caseDir, 'servers.json'))
  const server = store.create(delayedServerInput(pidFile))
  const manager = new McpManager(store, caseDir)
  managers.push(manager)

  const starting = manager.startAll()
  const [pid] = await waitForPids(pidFile, 1)
  await manager.remove(server.id)
  await starting

  assert.deepEqual(manager.listServers(), [])
  assert.deepEqual(manager.getToolDefinitions(), [])
  await waitUntil(() => !isProcessAlive(pid), '删除后旧 MCP 子进程仍在运行')
}

async function testReconnectDuringConnect(): Promise<void> {
  const caseDir = join(tempDir, 'reconnect-during-connect')
  const pidFile = join(caseDir, 'pids.txt')
  const store = new McpServerStore(join(caseDir, 'servers.json'))
  const server = store.create(delayedServerInput(pidFile))
  const manager = new McpManager(store, caseDir)
  managers.push(manager)

  const starting = manager.startAll()
  const [firstPid] = await waitForPids(pidFile, 1)
  const reconnecting = manager.reconnect(server.id)
  await Promise.all([starting, reconnecting])
  const pids = await waitForPids(pidFile, 2)

  await waitUntil(() => !isProcessAlive(firstPid), '重连后旧 MCP 子进程仍在运行')
  assert.equal(isProcessAlive(pids[1]), true)
  assert.equal(manager.listServers()[0]?.status, 'connected')
  assert.equal(manager.getToolDefinitions().length, 1)
}

async function testDisableDuringConnect(): Promise<void> {
  const caseDir = join(tempDir, 'disable-during-connect')
  const pidFile = join(caseDir, 'pids.txt')
  const store = new McpServerStore(join(caseDir, 'servers.json'))
  const server = store.create(delayedServerInput(pidFile))
  const manager = new McpManager(store, caseDir)
  managers.push(manager)

  const starting = manager.startAll()
  const [pid] = await waitForPids(pidFile, 1)
  const updated = await manager.update({ ...server, enabled: false })
  await starting

  assert.equal(updated.status, 'disabled')
  assert.deepEqual(manager.getToolDefinitions(), [])
  assert.equal((await waitForPids(pidFile, 1)).length, 1)
  await waitUntil(() => !isProcessAlive(pid), '停用后旧 MCP 子进程仍在运行')
}

function delayedServerInput(pidFile: string) {
  return {
    name: `delayed-${Math.random().toString(36).slice(2, 8)}`,
    command: process.execPath,
    args: [
      resolve('scripts/fixtures/delayed-mcp-server.mjs'),
      '--list-delay=500',
      `--pid-file=${pidFile}`
    ],
    enabled: true
  }
}

async function waitForPids(filePath: string, count: number): Promise<number[]> {
  let pids: number[] = []
  await waitUntil(() => {
    if (!existsSync(filePath)) return false
    pids = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number)
    return pids.length >= count
  }, `未观察到 ${count} 个 MCP 子进程`)
  return pids
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
