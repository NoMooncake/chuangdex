import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const delayArg = process.argv.find((arg) => arg.startsWith('--list-delay='))
const pidFileArg = process.argv.find((arg) => arg.startsWith('--pid-file='))
const listDelay = Number(delayArg?.slice('--list-delay='.length) ?? 0)
const pidFile = pidFileArg?.slice('--pid-file='.length)

if (pidFile) appendFileSync(pidFile, `${process.pid}\n`, 'utf8')

const server = new Server(
  { name: 'chuangdex-delayed-test-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (listDelay > 0) await new Promise((resolve) => setTimeout(resolve, listDelay))
  return {
    tools: [
      {
        name: 'delayed_echo',
        description: '用于连接生命周期回归测试。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      }
    ]
  }
})

await server.connect(new StdioServerTransport())
