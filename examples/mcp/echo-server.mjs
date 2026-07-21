import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// 只用于本地验证 ChuangDex MCP 连接和确认调用链。
// Server 不读取文件、不访问网络，也不执行命令。
const server = new Server(
  { name: 'chuangdex-mcp-demo', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '原样返回一段文本，用于测试 MCP 调用。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要返回的文本' }
        },
        required: ['text'],
        additionalProperties: false
      }
    },
    {
      name: 'current_time',
      description: '返回当前本机时间。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'echo') {
    const text = request.params.arguments?.text
    if (typeof text !== 'string') {
      return { isError: true, content: [{ type: 'text', text: '参数 text 必须是字符串。' }] }
    }
    return { content: [{ type: 'text', text }] }
  }

  if (request.params.name === 'current_time') {
    return { content: [{ type: 'text', text: new Date().toLocaleString('zh-CN') }] }
  }

  return { isError: true, content: [{ type: 'text', text: '未知工具。' }] }
})

await server.connect(new StdioServerTransport())
