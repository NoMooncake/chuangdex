// 定时任务创建的共用入口：飞书与桌面都先把自然语言拆成固定字段，
// 再交给同一个 TaskScheduler 持久化，避免渠道各自实现一套语义。

import type { ChuangdexAgentService, RunEventSink } from '../agent/service'
import type { AgentReply } from '../shared/agent'
import {
  formatTime,
  repeatLabel,
  type ScheduledTask,
  type TaskScheduler
} from './scheduler'

export interface ScheduleCreationResult {
  content: string
  task?: ScheduledTask
  error?: string
}

/** 返回 null 表示不是定时任务，调用方应继续走普通聊天。 */
export async function tryCreateScheduledTask(
  agent: ChuangdexAgentService,
  scheduler: TaskScheduler,
  destinationId: string,
  userText: string,
  emit: RunEventSink
): Promise<ScheduleCreationResult | null> {
  const intent = await agent.detectSchedule(userText, emit)
  if (!intent?.isSchedule) return null

  if (!intent.time || !intent.repeat || !intent.task) {
    return {
      content: [
        '听起来你想创建一个定时任务，但信息还不够明确，请补充：',
        '· 具体时间（几点几分，如 09:00、18:30）',
        '· 重复方式（每天，或每个工作日）',
        '例如：“每个工作日 09:00 提醒我开会。”'
      ].join('\n')
    }
  }

  try {
    const task = scheduler.addTask({
      chatId: destinationId,
      text: intent.task,
      time: intent.time,
      repeat: intent.repeat
    })
    return {
      task,
      content: [
        '✅ 定时任务已创建',
        `内容：${task.text}`,
        `频率：${repeatLabel(task.repeat)}`,
        `时间：${task.time}`,
        `下次执行：${formatTime(task.nextRunAt)}`
      ].join('\n')
    }
  } catch (error) {
    return {
      content: '暂时无法保存这个定时任务，因此未创建。请稍后重试。',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 桌面任务到点后的唯一执行入口。
 * scheduled=true 明确告诉 Agent：任务已经创建，现在只生成本次应交付的内容。
 */
export function executeDesktopScheduledTask(
  agent: ChuangdexAgentService,
  task: ScheduledTask,
  turnId: string,
  emit: RunEventSink
): Promise<AgentReply> {
  return agent.handleMessage(
    {
      sessionId: task.chatId,
      text: task.text,
      source: 'desktop',
      scheduled: true,
      turnId
    },
    emit
  )
}
