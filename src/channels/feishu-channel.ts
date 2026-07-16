// ─────────────────────────────────────────────────────────────
// ChuangDex 飞书渠道层（纯逻辑，不依赖飞书 SDK，可独立测试）
//
// 职责：把飞书消息事件翻译为 Agent 服务调用，并把回复交给发送函数。
//   · 只处理用户发送的文本消息
//   · 忽略任何机器人（包括自己）发出的消息，防止自我回复循环
//   · 按 message_id 去重，同一条消息绝不处理两次
//   · 每个飞书会话（私聊/群聊）映射为独立内部会话 feishu-{chat_id}，
//     各自维护上下文，互不泄露
// ─────────────────────────────────────────────────────────────

import type { ChuangdexAgentService } from '../agent/service'
import type { HistoryMessage } from '../shared/agent'
import { formatTime, repeatLabel, type TaskScheduler } from './scheduler'

/** 飞书消息事件的最小结构（只声明渠道层关心的字段） */
export interface FeishuMessageEvent {
  sender?: { sender_type?: string }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
  }
}

/** 发送文本回复的函数签名（由 SDK 接线层注入）：chatId 定位会话，replyToId 定位原消息 */
export type SendTextFn = (chatId: string, replyToId: string, text: string) => Promise<void>

export type LogFn = (line: string) => void

/** 内存中每个飞书会话最多保留的上下文条数（发给模型时服务再截到 12 条） */
const HISTORY_KEEP = 24
/** message_id 去重表容量，超出后淘汰最早的记录 */
const SEEN_CAP = 500

export class FeishuBotChannel {
  private readonly seen = new Set<string>()
  private readonly histories = new Map<string, HistoryMessage[]>()

  constructor(
    private readonly agent: ChuangdexAgentService,
    private readonly send: SendTextFn,
    private readonly log: LogFn = (line) => console.log(line),
    private readonly scheduler?: TaskScheduler
  ) {}

  /**
   * 处理一条飞书消息事件。
   *
   * 同步返回：只做过滤/去重/取文本这些零耗时操作，随后立即结束事件处理。
   * 真正的 Agent 调用（可能耗时几十秒）放到后台任务里执行——
   * 飞书不会等待，也就不会因超时而重推同一条消息。
   */
  handleEvent(event: FeishuMessageEvent): void {
    const msg = event.message
    if (!msg?.message_id || !msg.chat_id) return

    // ① 忽略机器人（含自己）的消息：机器人回复自己会造成死循环
    if (event.sender?.sender_type !== 'user') {
      this.log(`[feishu] 忽略非用户消息（sender_type=${event.sender?.sender_type ?? '未知'}）`)
      return
    }

    // ② 只处理文本消息
    if (msg.message_type !== 'text') {
      this.log(`[feishu] 忽略非文本消息（type=${msg.message_type ?? '未知'}）`)
      return
    }

    // ③ message_id 去重：重连重投或重复事件只处理一次
    //    （同步完成，后台处理尚未结束时重推也能被拦截）
    if (this.seen.has(msg.message_id)) {
      this.log(`[feishu] 忽略重复消息 ${msg.message_id}`)
      return
    }
    this.rememberSeen(msg.message_id)

    // ④ 提取文本（群里 @机器人 时去掉 @_user_N 占位符）
    const text = this.extractText(msg.content)
    if (!text) return

    // ⑤ 事件处理到此结束；Agent 调用和回复在后台继续，失败只记日志
    void this.processInBackground(msg.message_id, msg.chat_id, text)
  }

  /**
   * 后台处理：Agent 调用 + 会话上下文 + 发送回复。
   * 全包裹 try/catch——任何失败只写本机日志，绝不抛出，长连接不受影响。
   */
  private async processInBackground(messageId: string, chatId: string, text: string): Promise<void> {
    try {
      const sessionId = `feishu-${chatId}`
      this.log(`[feishu] 收到消息 ${messageId}（会话 ${sessionId}）：${text.slice(0, 40)}`)

      const runSink = (run: { status: string; title: string; detail: string }): void =>
        this.log(`[feishu]   ${run.status} ${run.title} · ${run.detail}`)

      // 先解析是否是定时任务请求
      if (this.scheduler) {
        const intent = await this.agent.detectSchedule(text, runSink)
        if (intent?.isSchedule) {
          if (intent.time && intent.repeat && intent.task) {
            try {
              const task = this.scheduler.addTask({
                chatId,
                text: intent.task,
                time: intent.time,
                repeat: intent.repeat
              })
              await this.send(
                chatId,
                messageId,
                [
                  '✅ 定时任务已创建',
                  `内容：${task.text}`,
                  `频率：${repeatLabel(task.repeat)}`,
                  `时间：${task.time}`,
                  `下次执行：${formatTime(task.nextRunAt)}`
                ].join('\n')
              )
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err)
              this.log(`[feishu] 定时任务创建失败（消息 ${messageId}）：${reason}`)
              await this.send(chatId, messageId, '暂时无法保存这个定时任务，因此未创建。请稍后重试。')
            }
          } else {
            await this.send(
              chatId,
              messageId,
              [
                '听起来你想创建一个定时任务，但信息还不够明确，请补充：',
                '· 具体时间（几点几分，如 09:00、18:30）',
                '· 重复方式（每天，或每个工作日）',
                '例如：“每个工作日 09:00 把今天日报发到这个群。”'
              ].join('\n')
            )
          }
          this.log(`[feishu] 已回复 ${messageId}`)
          return
        }
      }

      // 普通对话：Agent 调用 + 回复
      const content = await this.runAgentForChat(chatId, text, runSink)
      await this.send(chatId, messageId, content)
      this.log(`[feishu] 已回复 ${messageId}`)
    } catch (err) {
      this.log(
        `[feishu] 后台处理失败（消息 ${messageId}）：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * 用 Agent 服务处理一条某个飞书会话的文本（含该会话上下文），返回回复文本。
   * 用户消息与定时任务执行共用这条路径。
   */
  async runAgentForChat(
    chatId: string,
    text: string,
    runSink?: (run: { status: string; title: string; detail: string }) => void
  ): Promise<string> {
    return this.runAgent(chatId, text, false, runSink)
  }

  /**
   * 执行一个已到点的定时任务。
   * 与聊天的唯一区别是告诉 Agent 服务“任务已创建、现在到执行时间了”，
   * 模型只生成此刻应发的内容，不会把它当成新的提醒请求。
   */
  async runScheduledTask(
    chatId: string,
    text: string,
    runSink?: (run: { status: string; title: string; detail: string }) => void
  ): Promise<string> {
    return this.runAgent(chatId, text, true, runSink)
  }

  private async runAgent(
    chatId: string,
    text: string,
    scheduled: boolean,
    runSink?: (run: { status: string; title: string; detail: string }) => void
  ): Promise<string> {
    const sessionId = `feishu-${chatId}`
    const history = (this.histories.get(chatId) ?? []).slice(-12)
    const reply = await this.agent.handleMessage(
      { sessionId, text, history, scheduled },
      runSink ?? (() => {})
    )
    this.appendHistory(
      chatId,
      { role: 'user', content: text },
      { role: 'assistant', content: reply.content }
    )
    return reply.content
  }

  private extractText(content: string | undefined): string {
    if (!content) return ''
    try {
      const parsed = JSON.parse(content) as { text?: unknown }
      if (typeof parsed.text !== 'string') return ''
      return parsed.text.replace(/@_user_\d+/g, '').trim()
    } catch {
      return ''
    }
  }

  private rememberSeen(messageId: string): void {
    this.seen.add(messageId)
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  private appendHistory(chatId: string, ...items: HistoryMessage[]): void {
    const list = [...(this.histories.get(chatId) ?? []), ...items]
    this.histories.set(chatId, list.slice(-HISTORY_KEEP))
  }
}
