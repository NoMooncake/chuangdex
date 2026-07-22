import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChuangdexAgentService } from '../src/agent/service'
import type { ModelProvider, ModelRequest } from '../src/agent/providers/types'
import {
  executeDesktopScheduledTask,
  tryCreateScheduledTask
} from '../src/channels/schedule-creation'
import { TaskScheduler, TaskStore } from '../src/channels/scheduler'
import type { AgentRunEvent } from '../src/shared/agent'

const tempDir = mkdtempSync(join(tmpdir(), 'chuangdex-schedule-'))

try {
  const requests: ModelRequest[] = []
  const model: ModelProvider = {
    name: '定时任务测试模型',
    isConfigured: () => true,
    describeTarget: () => '本地测试',
    chat: async (request) => {
      requests.push(request)
      const system = request.messages[0]?.content ?? ''
      const user = request.messages.at(-1)?.content ?? ''
      if (system.includes('你是一个意图解析器')) {
        if (user.includes('每天早上九点')) {
          return {
            model: 'fake-model',
            content: JSON.stringify({
              is_schedule: true,
              time: '09:00',
              repeat: 'daily',
              task: '提醒我要开会'
            })
          }
        }
        if (user === '提醒我要开会') {
          return {
            model: 'fake-model',
            content: JSON.stringify({
              is_schedule: true,
              time: null,
              repeat: null,
              task: '提醒我要开会'
            })
          }
        }
        return {
          model: 'fake-model',
          content: JSON.stringify({ is_schedule: false, time: null, repeat: null, task: null })
        }
      }
      if (system.includes('你正在为 ChuangDex 执行一个定时任务')) {
        assert.equal(user, '提醒我要开会')
        return { model: 'fake-model', content: '⏰ 提醒：该开会了' }
      }
      throw new Error('定时任务不应进入普通聊天提示词')
    }
  }

  const agent = new ChuangdexAgentService(model)
  const store = new TaskStore(join(tempDir, 'desktop-tasks.json'))
  const scheduler = new TaskScheduler(store, async () => undefined, () => undefined)
  const creationEvents: AgentRunEvent[] = []
  const created = await tryCreateScheduledTask(
    agent,
    scheduler,
    'desktop-session-1',
    '每天早上九点提醒我要开会',
    (event) => creationEvents.push(event)
  )

  assert.ok(created?.task)
  assert.equal(created.task.chatId, 'desktop-session-1')
  assert.equal(created.task.text, '提醒我要开会')
  assert.equal(created.task.time, '09:00')
  assert.equal(created.task.repeat, 'daily')
  assert.match(created.content, /定时任务已创建/)
  assert.deepEqual(
    store.load().map(({ chatId, text, time, repeat }) => ({ chatId, text, time, repeat })),
    [
      {
        chatId: 'desktop-session-1',
        text: '提醒我要开会',
        time: '09:00',
        repeat: 'daily'
      }
    ]
  )

  const executionEvents: AgentRunEvent[] = []
  const reply = await executeDesktopScheduledTask(
    agent,
    created.task,
    'scheduled-turn-1',
    (event) => executionEvents.push(event)
  )
  assert.equal(reply.content, '⏰ 提醒：该开会了')
  assert.ok(executionEvents.some((event) => event.title === '执行已触发的定时任务'))
  assert.equal(requests.length, 2, '创建时解析一次，到点后直接执行一次，不应重新识别任务意图')

  const incomplete = await tryCreateScheduledTask(
    agent,
    scheduler,
    'desktop-session-1',
    '提醒我要开会',
    () => undefined
  )
  assert.match(incomplete?.content ?? '', /信息还不够明确/)
  assert.equal(store.load().length, 1)

  const ordinary = await tryCreateScheduledTask(
    agent,
    scheduler,
    'desktop-session-1',
    '今天天气怎么样',
    () => undefined
  )
  assert.equal(ordinary, null)

  console.log('SCHEDULE_SMOKE_OK')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
