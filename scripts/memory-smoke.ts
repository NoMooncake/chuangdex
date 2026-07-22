import assert from 'node:assert/strict'
import { ChuangdexAgentService } from '../src/agent/service'
import type { AgentRunEvent, HistoryMessage, ShortTermMemoryState } from '../src/shared/agent'
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/agent/providers/types'

const SUMMARY_MARKER = '你是 ChuangDex 的会话上下文压缩器。'
const GENERATED_SUMMARY = [
  '## 当前目标与主题',
  '用户正在验证桌面 Agent 的滚动短期记忆机制，希望较早对话可以被稳定承接。',
  '## 已确认信息与约束',
  '完整原始消息仍保留在会话存档中；模型上下文只使用滚动摘要与最近完整轮次；飞书逻辑保持不变。',
  '## 未决事项与下一步',
  '继续根据后续消息更新摘要，并保留仍会影响回答的决定。'
].join('\n')

async function testSmallDesktopHistoryKeepsRawMessages(): Promise<void> {
  const model = new FakeModel()
  const history = makeTurns(1, 5)
  const reply = await new ChuangdexAgentService(model).handleMessage(
    { sessionId: 'small', source: 'desktop', text: '继续', history },
    () => undefined
  )

  assert.equal(reply.shortTermMemory, undefined)
  assert.equal(model.requests.length, 1)
  assert.deepEqual(rawContents(model.requests[0]), [...history.map((item) => item.content), '继续'])
}

async function testDesktopHistoryCompacts(): Promise<{
  history: HistoryMessage[]
  state: ShortTermMemoryState
}> {
  const model = new FakeModel()
  const events: AgentRunEvent[] = []
  const history = makeTurns(1, 10)
  const reply = await new ChuangdexAgentService(model).handleMessage(
    { sessionId: 'compact', source: 'desktop', text: '继续', history },
    (event) => events.push(event)
  )

  assert.equal(model.requests.length, 2)
  assert.ok(reply.shortTermMemory)
  assert.equal(reply.shortTermMemory.summarizedThroughMessageId, 'm-6-a')
  assert.equal(summaryPayload(model.requests[0]).previousSummary, null)
  assert.equal(summaryPayload(model.requests[0]).messagesToCompact.length, 12)
  assert.deepEqual(rawContents(model.requests[1]), [
    ...history.slice(-8).map((item) => item.content),
    '继续'
  ])
  assert.ok(
    model.requests[1].messages.some(
      (message) => message.role === 'system' && message.content?.includes('# 会话早期摘要')
    )
  )
  assert.ok(events.some((event) => event.title === '早期对话已压缩' && event.status === 'success'))
  return { history, state: reply.shortTermMemory }
}

async function testSuccessiveCompaction(input: {
  history: HistoryMessage[]
  state: ShortTermMemoryState
}): Promise<void> {
  const model = new FakeModel()
  const history = [...input.history, ...makeTurns(11, 9)]
  const reply = await new ChuangdexAgentService(model).handleMessage(
    {
      sessionId: 'rolling',
      source: 'desktop',
      text: '再继续',
      history,
      shortTermMemory: input.state
    },
    () => undefined
  )

  const payload = summaryPayload(model.requests[0])
  assert.equal(payload.previousSummary, GENERATED_SUMMARY)
  assert.equal(payload.messagesToCompact[0]?.content, '用户消息 7')
  assert.equal(payload.messagesToCompact.some((message) => message.content === '用户消息 1'), false)
  assert.equal(reply.shortTermMemory?.summarizedThroughMessageId, 'm-15-a')
}

async function testCompactionFailureFallsBack(): Promise<void> {
  const model = new FakeModel(true)
  const events: AgentRunEvent[] = []
  const history = makeTurns(1, 10)
  const reply = await new ChuangdexAgentService(model).handleMessage(
    { sessionId: 'fallback', source: 'desktop', text: '继续', history },
    (event) => events.push(event)
  )

  assert.equal(reply.content, '最终回答')
  assert.equal(reply.shortTermMemory, undefined)
  assert.equal(model.requests.length, 2)
  assert.deepEqual(rawContents(model.requests[1]), [
    ...history.slice(-12).map((item) => item.content),
    '继续'
  ])
  assert.ok(events.some((event) => event.title === '上下文压缩失败' && event.status === 'failed'))
}

async function testFeishuKeepsTwelveMessageWindow(): Promise<void> {
  const model = new FakeModel()
  const history = makeTurns(1, 10)
  await new ChuangdexAgentService(model).handleMessage(
    { sessionId: 'feishu', source: 'feishu', text: '继续', history },
    () => undefined
  )

  assert.equal(model.requests.length, 1)
  assert.deepEqual(rawContents(model.requests[0]), [
    ...history.slice(-12).map((item) => item.content),
    '继续'
  ])
  assert.equal(
    model.requests[0].messages.some((message) => message.content?.includes('# 会话早期摘要')),
    false
  )
}

class FakeModel implements ModelProvider {
  readonly name = 'fake'
  readonly requests: ModelRequest[] = []

  constructor(private readonly failFirstSummary = false) {}

  isConfigured(): boolean {
    return true
  }

  describeTarget(): string {
    return 'fake endpoint'
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    if (request.messages[0]?.content?.startsWith(SUMMARY_MARKER)) {
      if (this.failFirstSummary) throw new Error('摘要服务暂时不可用')
      return { content: GENERATED_SUMMARY, model: 'fake-summary' }
    }
    return { content: '最终回答', model: 'fake-chat' }
  }
}

function makeTurns(start: number, count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, offset) => start + offset).flatMap((turn) => [
    {
      id: `m-${turn}-u`,
      turnId: `turn-${turn}`,
      role: 'user' as const,
      content: `用户消息 ${turn}`
    },
    {
      id: `m-${turn}-a`,
      turnId: `turn-${turn}`,
      role: 'assistant' as const,
      content: `助手消息 ${turn}`
    }
  ])
}

function rawContents(request: ModelRequest): string[] {
  return request.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => message.content ?? '')
}

function summaryPayload(request: ModelRequest): {
  previousSummary: string | null
  messagesToCompact: Array<{ role: string; content: string }>
} {
  const raw = request.messages[1]?.content
  if (typeof raw !== 'string') throw new Error('摘要请求缺少 JSON 载荷')
  return JSON.parse(raw) as {
    previousSummary: string | null
    messagesToCompact: Array<{ role: string; content: string }>
  }
}

await testSmallDesktopHistoryKeepsRawMessages()
const firstCompaction = await testDesktopHistoryCompacts()
await testSuccessiveCompaction(firstCompaction)
await testCompactionFailureFallsBack()
await testFeishuKeepsTwelveMessageWindow()
console.log('MEMORY_SMOKE_OK')
