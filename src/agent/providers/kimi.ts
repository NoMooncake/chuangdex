// Kimi（Moonshot AI）模型调用。
// 使用 OpenAI 兼容的 /chat/completions 接口，Node 自带 fetch，无新增依赖。
// 将来接入其他厂商时，参照本文件在 providers/ 下新建实现即可。

import type { ChatMessage, ModelProvider, ModelRequest, ModelResponse } from './types'

export interface KimiConfig {
  apiKey: string
  baseUrl: string
  model: string
}

const DEFAULT_TIMEOUT_MS = 60_000

export class KimiProvider implements ModelProvider {
  readonly name = 'kimi'

  constructor(private readonly config: KimiConfig | null) {}

  isConfigured(): boolean {
    return Boolean(this.config?.apiKey && this.config.baseUrl && this.config.model)
  }

  describeTarget(): string {
    if (!this.config) return '未配置'
    return `${this.config.baseUrl} · ${this.config.model}`
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    if (!this.config || !this.isConfigured()) {
      throw new Error('Kimi 未配置（缺少 API Key / Endpoint / 模型名）')
    }

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages
        }),
        signal: controller.signal
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(friendlyHttpError(res.status, body))
      }

      const data = (await res.json()) as {
        model?: string
        choices?: { message?: { content?: unknown } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('Kimi 响应格式异常：缺少 message.content')
      }

      return {
        content,
        model: data.model ?? this.config.model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens ?? 0,
              completionTokens: data.usage.completion_tokens ?? 0
            }
          : undefined
      }
    } catch (err) {
      throw new Error(toFriendlyReason(err))
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 把底层错误翻译成用户能看懂的简短原因 */
function toFriendlyReason(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return `请求超时（${DEFAULT_TIMEOUT_MS / 1000} 秒无响应）`
    // Node fetch 网络层错误通常是 TypeError: fetch failed
    if (err.message.includes('fetch failed')) return '网络错误：无法连接 Endpoint，请检查网络或代理'
    return err.message
  }
  return String(err)
}

function friendlyHttpError(status: number, body: string): string {
  const snippet = body ? `（${body.slice(0, 120)}）` : ''
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：请检查 API Key 是否正确`
  if (status === 404) return `接口不存在（HTTP 404）：请检查 Endpoint 和模型名`
  if (status === 429) return `请求被限流（HTTP 429）：请稍后重试`
  if (status >= 500) return `Kimi 服务异常（HTTP ${status}）${snippet}`
  return `请求被拒绝（HTTP ${status}）${snippet}`
}
