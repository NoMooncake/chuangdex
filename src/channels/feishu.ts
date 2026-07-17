// 飞书长连接接线层：唯一接触飞书官方 SDK 的地方。
// 使用 @larksuiteoapi/node-sdk 的 WebSocket 长连接接收消息，无需公网回调地址。

import * as Lark from '@larksuiteoapi/node-sdk'
import type { ChuangdexAgentService } from '../agent/service'
import type { FeishuConfig } from '../main/feishu-config'
import { FeishuBotChannel, type FeishuMessageEvent } from './feishu-channel'
import { TaskScheduler, TaskStore } from './scheduler'

/**
 * 启动飞书机器人：建立长连接，把消息事件桥接到 ChuangDex Agent 服务。
 * 连接/运行中的错误由 SDK 内部重连与本层日志承担，不会导致应用崩溃。
 */
export function startFeishuBot(
  config: FeishuConfig,
  agent: ChuangdexAgentService,
  tasksFile: string
): TaskScheduler {
  // REST 客户端：用于以机器人身份发送回复
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu
  })

  // 定时任务引擎：到点后用 Agent 服务执行（定时任务模式），结果发回创建任务的会话
  let channel!: FeishuBotChannel
  const scheduler = new TaskScheduler(new TaskStore(tasksFile), async (task) => {
    const content = await channel.runScheduledTask(task.chatId, task.text, (run) =>
      console.log(`[scheduler]   ${run.status} ${run.title} · ${run.detail}`)
    )
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: task.chatId, msg_type: 'text', content: JSON.stringify({ text: content }) }
    })
    console.log(`[scheduler] 任务 ${task.id} 结果已发送到会话 ${task.chatId}`)
  })

  channel = new FeishuBotChannel(
    agent,
    async (_chatId, replyToId, text) => {
      // 以“回复原消息”的方式发回同一会话，群里也能看清上下文
      await client.im.v1.message.reply({
        path: { message_id: replyToId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) }
      })
    },
    undefined,
    scheduler
  )

  // 事件分发：只订阅“接收消息”事件。
  // 回调同步返回（不 await 任何模型调用），飞书不会因处理超时而重推消息。
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data: unknown) => {
      channel.handleEvent(data as FeishuMessageEvent)
    }
  })

  // 长连接客户端：事件通过 WebSocket 推送，不需要公网地址
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info
  })

  scheduler.start()
  wsClient.start({ eventDispatcher: dispatcher })
  return scheduler
}
