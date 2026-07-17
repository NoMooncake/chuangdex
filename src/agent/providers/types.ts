// 模型厂商抽象层。
// Agent 服务只依赖这个接口，不认识任何具体厂商。
// 将来接入其他模型（OpenAI / Anthropic / 本地模型等）时：
// 在 providers/ 下新增一个实现本接口的类即可，Agent 服务与界面不动。

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * Agent 内部统一消息格式。
 * toolCalls / toolCallId 会由具体 Provider 转换为厂商协议字段。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none'
}

export interface ModelResponse {
  content: string
  model: string
  finishReason?: string
  toolCalls?: ToolCall[]
  usage?: {
    promptTokens: number
    completionTokens: number
  }
}

export interface ModelProvider {
  /** 厂商标识，用于运行记录展示 */
  readonly name: string

  /** 本机配置是否齐全（缺 Key / Endpoint / 模型名时返回 false） */
  isConfigured(): boolean

  /** 描述调用目标（Endpoint + 模型名），用于运行记录；不得包含 API Key */
  describeTarget(): string

  /** 发起一次对话补全调用。失败时抛出带可读原因的 Error */
  chat(request: ModelRequest): Promise<ModelResponse>
}
