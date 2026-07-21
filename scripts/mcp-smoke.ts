import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ChuangdexAgentService } from '../src/agent/service'
import { McpManager } from '../src/agent/mcp/manager'
import { McpServerStore } from '../src/agent/mcp/store'
import type { ModelProvider } from '../src/agent/providers/types'
import type { AgentRunEvent } from '../src/shared/agent'

const tempDir = mkdtempSync(join(tmpdir(), 'chuangdex-mcp-'))
const manager = new McpManager(
  new McpServerStore(join(tempDir, 'mcp-servers.json')),
  tempDir
)

try {
  const created = await manager.create({
    name: 'local-demo',
    command: process.execPath,
    args: [resolve('examples/mcp/echo-server.mjs')],
    enabled: true
  })
  assert.equal(created.status, 'connected')
  assert.deepEqual(created.tools.map((tool) => tool.name).sort(), ['current_time', 'echo'])

  const echoDefinition = manager.getToolDefinitions().find((definition) =>
    manager.resolveTool(definition.function.name)?.toolName === 'echo'
  )
  assert.ok(echoDefinition, '应该发现 echo 工具')

  const direct = await manager.callTool(echoDefinition.function.name, { text: 'MCP_DIRECT_OK' })
  assert.equal(direct.content, 'MCP_DIRECT_OK')
  assert.equal(direct.isError, false)

  let modelCalls = 0
  const model: ModelProvider = {
    name: 'MCP 测试模型',
    isConfigured: () => true,
    describeTarget: () => '本地测试',
    chat: async (request) => {
      modelCalls += 1
      if (request.tools) {
        return {
          content: '',
          model: 'fake-model',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: echoDefinition.function.name,
                arguments: JSON.stringify({ text: 'MCP_AGENT_OK' })
              }
            }
          ]
        }
      }
      const resultMessage = request.messages.at(-1)?.content ?? ''
      assert.match(resultMessage, /MCP_AGENT_OK/)
      return { content: '模型已读取：MCP_AGENT_OK', model: 'fake-model' }
    }
  }

  const events: AgentRunEvent[] = []
  const service = new ChuangdexAgentService(model, [], '', undefined, null, manager)
  const approval = await service.handleMessage(
    { sessionId: 'mcp-smoke-session', source: 'desktop', text: '请用 MCP echo 返回测试字符' },
    (event) => events.push(event)
  )
  assert.match(approval.content, /确认调用/)
  assert.equal(modelCalls, 1, '确认前不应整理工具结果')

  const confirmed = await service.handleMessage(
    { sessionId: 'mcp-smoke-session', source: 'desktop', text: '确认调用' },
    (event) => events.push(event)
  )
  assert.equal(confirmed.content, '模型已读取：MCP_AGENT_OK')
  assert.equal(modelCalls, 2)
  assert.ok(events.some((event) => event.title === 'MCP 工具调用完成'))

  await manager.closeAll()
  const restoredManager = new McpManager(
    new McpServerStore(join(tempDir, 'mcp-servers.json')),
    tempDir
  )
  await restoredManager.startAll()
  assert.equal(restoredManager.listServers()[0]?.status, 'connected')
  await restoredManager.closeAll()

  console.log('MCP_SMOKE_OK')
} finally {
  await manager.closeAll()
  rmSync(tempDir, { recursive: true, force: true })
}
