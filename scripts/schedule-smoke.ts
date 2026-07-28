import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChuangdexAgentService } from '../src/agent/service'
import type { ModelProvider, ModelRequest } from '../src/agent/providers/types'
import type { AgentRunEvent } from '../src/shared/agent'
import {
  executeDesktopScheduledTask,
  tryCreateScheduledTask
} from '../src/channels/schedule-creation'
import {
  TaskScheduler,
  TaskStore,
  computeNextRun,
  isValidCron,
  isValidTimezone,
  systemDefaultTimezone,
  toCronExpression,
  type ScheduledTask
} from '../src/channels/scheduler'

const tempDir = mkdtempSync(join(tmpdir(), 'chuangdex-schedule-'))

/** 把指定时区的本地时间转换为 epoch 毫秒，用于测试纯函数。 */
function epochAt(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  // 先按目标时区的 wall time 构造一个 UTC 时间，再计算此时目标时区与 UTC 的偏移。
  const utcWall = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const utcAsLocal = new Date(utcWall.toLocaleString('en-US', { timeZone: 'UTC' }))
  const tzAsLocal = new Date(utcWall.toLocaleString('en-US', { timeZone: tz }))
  const offsetMinutes = (tzAsLocal.getTime() - utcAsLocal.getTime()) / 60000
  return utcWall.getTime() - offsetMinutes * 60000
}

/** 替换全局 Date.now / setTimeout / clearTimeout，实现确定性调度测试。 */
class FakeTimer {
  private now = 0
  private id = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  private readonly realDateNow = Date.now
  private readonly realSetTimeout = globalThis.setTimeout
  private readonly realClearTimeout = globalThis.clearTimeout

  constructor(start = 0) {
    this.now = start
    Date.now = () => this.now
    globalThis.setTimeout = ((fn: () => void, ms: number) => this.setTimeout(fn, ms)) as unknown as typeof globalThis.setTimeout
    globalThis.clearTimeout = ((id: number) => this.clearTimeout(id)) as unknown as typeof globalThis.clearTimeout
  }

  reset(): void {
    Date.now = this.realDateNow
    globalThis.setTimeout = this.realSetTimeout
    globalThis.clearTimeout = this.realClearTimeout
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.id
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimeout(id: number): void {
    this.timers.delete(id)
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    let guard = 0
    while (guard++ < 1000) {
      let nextId: number | null = null
      for (const [id, t] of this.timers) {
        if (t.at > target) continue
        if (nextId === null) {
          nextId = id
          continue
        }
        const next = this.timers.get(nextId)!
        if (t.at < next.at || (t.at === next.at && id < nextId)) {
          nextId = id
        }
      }
      if (nextId === null) break
      const next = this.timers.get(nextId)!
      this.timers.delete(nextId)
      this.now = next.at
      const result: unknown = next.fn()
      if (result instanceof Promise) await result
    }
    this.now = target
  }

  currentTime(): number {
    return this.now
  }
}

function makeFakeAgent(): { agent: ChuangdexAgentService; requests: ModelRequest[] } {
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
          content: JSON.stringify({
            is_schedule: false,
            time: null,
            repeat: null,
            task: null
          })
        }
      }
      if (system.includes('你正在为 ChuangDex 执行一个定时任务')) {
        assert.equal(user, '提醒我要开会')
        return { model: 'fake-model', content: '⏰ 提醒：该开会了' }
      }
      throw new Error('定时任务不应进入普通聊天提示词')
    }
  }
  return { agent: new ChuangdexAgentService(model), requests }
}

function testPureFunctions(): void {
  assert.equal(toCronExpression('09:00', 'daily'), '0 9 * * *')
  assert.equal(toCronExpression('18:30', 'weekdays'), '30 18 * * 1-5')
  assert.equal(isValidCron('0 9 * * *'), true)
  assert.equal(isValidCron('30 18 * * 1-5'), true)
  assert.equal(isValidCron('not-a-cron'), false)
  assert.equal(isValidTimezone('Asia/Shanghai'), true)
  assert.equal(isValidTimezone('Mars/Phobos'), false)

  // Asia/Shanghai 星期一 08:00 的下一执行点是当天 09:00
  const monday08 = epochAt(2025, 1, 13, 8, 0, 'Asia/Shanghai')
  const monday09 = epochAt(2025, 1, 13, 9, 0, 'Asia/Shanghai')
  assert.equal(computeNextRun('0 9 * * *', 'Asia/Shanghai', monday08), monday09)

  // 星期五 18:31 的下一执行点是下周一 18:30
  const friday1831 = epochAt(2025, 1, 17, 18, 31, 'Asia/Shanghai')
  const nextMonday1830 = epochAt(2025, 1, 20, 18, 30, 'Asia/Shanghai')
  assert.equal(computeNextRun('30 18 * * 1-5', 'Asia/Shanghai', friday1831), nextMonday1830)
}

function testMigration(): void {
  const file = join(tempDir, 'migrate-tasks.json')
  const v1 = {
    version: 1,
    tasks: [
      {
        id: 'v1-daily',
        chatId: 'chat-1',
        text: '日报',
        time: '09:00',
        repeat: 'daily',
        nextRunAt: 1,
        lastRunAt: 0,
        createdAt: 0
      },
      {
        id: 'v1-weekdays',
        chatId: 'chat-1',
        text: '周报',
        time: '18:30',
        repeat: 'weekdays',
        nextRunAt: 2,
        createdAt: 0
      },
      // 无效记录应被忽略
      {
        id: 'v1-invalid',
        text: '缺少 chatId',
        time: '09:00',
        repeat: 'daily',
        nextRunAt: 3,
        createdAt: 0
      }
    ]
  }
  writeFileSync(file, JSON.stringify(v1), 'utf-8')
  const store = new TaskStore(file)
  const tasks = store.load()
  assert.equal(tasks.length, 2)
  const daily = tasks.find((t) => t.id === 'v1-daily')!
  assert.equal(daily.cron, '0 9 * * *')
  assert.equal(daily.timezone, systemDefaultTimezone())
  assert.equal(daily.repeat, 'daily')
  const weekdays = tasks.find((t) => t.id === 'v1-weekdays')!
  assert.equal(weekdays.cron, '30 18 * * 1-5')
  assert.equal(weekdays.timezone, systemDefaultTimezone())
  assert.ok(daily.nextRunAt > Date.now() - 24 * 60 * 60 * 1000) // 已重新计算为未来的某次执行
  assert.ok(existsSync(file))
  const migrated = JSON.parse(readFileSync(file, 'utf-8')) as { version: number; tasks: unknown[] }
  assert.equal(migrated.version, 2)
  assert.equal(migrated.tasks.length, 2)
}

async function testCreationAndExecution(): Promise<void> {
  const { agent } = makeFakeAgent()
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
  assert.equal(created.task.cron, '0 9 * * *')
  assert.equal(created.task.timezone, systemDefaultTimezone())
  assert.match(created.content, /定时任务已创建/)
  assert.deepEqual(
    store.load().map(({ chatId, text, time, repeat, cron }) => ({ chatId, text, time, repeat, cron })),
    [
      {
        chatId: 'desktop-session-1',
        text: '提醒我要开会',
        time: '09:00',
        repeat: 'daily',
        cron: '0 9 * * *'
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
}

class FailingTaskStore extends TaskStore {
  failCount = 0
  savedCount = 0
  failFirstN = 0

  constructor(file: string, failFirstN = 0) {
    super(file)
    this.failFirstN = failFirstN
  }

  save(tasks: ScheduledTask[]): boolean {
    this.savedCount += 1
    if (this.failCount < this.failFirstN) {
      this.failCount += 1
      return false
    }
    return super.save(tasks)
  }
}

function makeScheduler(
  file: string,
  runner: (task: ScheduledTask) => Promise<void> | void,
  log?: (line: string) => void
) {
  const store = new TaskStore(file)
  const runs: string[] = []
  const scheduler = new TaskScheduler(
    store,
    async (task) => {
      runs.push(task.id)
      await runner(task)
    },
    log
  )
  return { scheduler, store, runs }
}

async function testScheduler(): Promise<void> {
  // 空任务状态 + 重复 start 不重复初始化
  {
    const timer = new FakeTimer(0)
    const logs: string[] = []
    const { scheduler } = makeScheduler(join(tempDir, 'empty-1.json'), () => undefined, (line) => logs.push(line))
    await scheduler.start()
    await scheduler.start()
    assert.ok(logs.some((l) => l.includes('调度器已启动，忽略重复启动')))
    await timer.advance(1000)
    scheduler.stop()
    timer.reset()
  }

  // 启动时过期任务只补执行一次
  {
    const timer = new FakeTimer(0)
    const file = join(tempDir, 'overdue-once.json')
    const { scheduler, runs, store } = makeScheduler(file, () => undefined)
    const dueTask: ScheduledTask = {
      id: 'due-task',
      chatId: 'c',
      text: 't',
      time: '00:00',
      repeat: 'daily',
      cron: '0 0 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: 0,
      createdAt: 0
    }
    store.save([dueTask])
    await scheduler.start()
    assert.equal(runs.length, 1)
    assert.equal(runs[0], dueTask.id)
    await timer.advance(24 * 60 * 60 * 1000)
    assert.equal(runs.length, 2)
    scheduler.stop()
    timer.reset()
  }

  // 最近任务触发后重新安排下一项
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'future.json'), () => undefined)
    await scheduler.start()
    // 系统时区为 Asia/Shanghai 时 epoch 0 对应本地 08:00；10:00 是 2 小时后
    scheduler.addTask({
      chatId: 'c',
      text: 't',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    assert.equal(runs.length, 0)
    await timer.advance(60 * 60 * 1000)
    assert.equal(runs.length, 0)
    await timer.advance(60 * 60 * 1000)
    assert.equal(runs.length, 1)
    await timer.advance(24 * 60 * 60 * 1000)
    assert.equal(runs.length, 2)
    scheduler.stop()
    timer.reset()
  }

  // 新增更早任务后原 timer 被重新安排
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'add-earlier.json'), () => undefined)
    await scheduler.start()
    const later = scheduler.addTask({
      chatId: 'c',
      text: 'later',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    await timer.advance(30 * 60 * 1000)
    assert.equal(runs.length, 0)
    const earlier = scheduler.addTask({
      chatId: 'c',
      text: 'earlier',
      time: '09:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    await timer.advance(30 * 60 * 1000)
    assert.deepEqual(runs, [earlier.id])
    await timer.advance(60 * 60 * 1000)
    assert.equal(runs.length, 2)
    assert.ok(runs.includes(later.id))
    scheduler.stop()
    timer.reset()
  }

  // 编辑任务后重新安排
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'update.json'), () => undefined)
    await scheduler.start()
    const task = scheduler.addTask({
      chatId: 'c',
      text: 't',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    await timer.advance(30 * 60 * 1000)
    assert.equal(runs.length, 0)
    scheduler.updateTask(task.id, {
      text: 'updated',
      time: '09:00',
      repeat: 'daily'
    })
    await timer.advance(30 * 60 * 1000)
    assert.equal(runs.length, 1)
    assert.equal(runs[0], task.id)
    scheduler.stop()
    timer.reset()
  }

  // 删除最近任务后改等下一项
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'remove.json'), () => undefined)
    await scheduler.start()
    const first = scheduler.addTask({
      chatId: 'c',
      text: 'first',
      time: '09:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    const second = scheduler.addTask({
      chatId: 'c',
      text: 'second',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    scheduler.removeTask(first.id)
    await timer.advance(60 * 60 * 1000)
    assert.equal(runs.length, 0)
    await timer.advance(60 * 60 * 1000)
    assert.equal(runs.length, 1)
    assert.equal(runs[0], second.id)
    scheduler.stop()
    timer.reset()
  }

  // 两个同时间任务只各执行一次
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'same-time.json'), () => undefined)
    await scheduler.start()
    const a = scheduler.addTask({
      chatId: 'c',
      text: 'a',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    const b = scheduler.addTask({
      chatId: 'c',
      text: 'b',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    await timer.advance(2 * 60 * 60 * 1000)
    assert.equal(runs.length, 2)
    assert.ok(runs.includes(a.id))
    assert.ok(runs.includes(b.id))
    scheduler.stop()
    timer.reset()
  }

  // 保存失败时不执行 runner，且退避 30 秒，不存在 0ms 忙循环
  {
    const timer = new FakeTimer(0)
    const file = join(tempDir, 'save-fail.json')
    const dueTask: ScheduledTask = {
      id: 'due-task',
      chatId: 'c',
      text: 't',
      time: '00:00',
      repeat: 'daily',
      cron: '0 0 * * *',
      timezone: 'Asia/Shanghai',
      nextRunAt: 0,
      createdAt: 0
    }
    const seedStore = new TaskStore(file)
    seedStore.save([dueTask])
    const store = new FailingTaskStore(file, 2)
    const runs: string[] = []
    const scheduler = new TaskScheduler(store, async (task) => {
      runs.push(task.id)
    })
    await scheduler.start()
    assert.equal(runs.length, 0)
    assert.equal(store.savedCount, 1) // start 里的 fire 第一次保存失败
    await timer.advance(29 * 1000)
    assert.equal(runs.length, 0)
    await timer.advance(1 * 1000)
    assert.equal(runs.length, 0)
    assert.equal(store.savedCount, 2) // 30 秒时再次失败
    await timer.advance(30 * 1000)
    assert.equal(runs.length, 1)
    assert.equal(runs[0], dueTask.id)
    assert.equal(store.savedCount, 3)
    scheduler.stop()
    timer.reset()
  }

  // stop 后不再执行
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'stop.json'), () => undefined)
    await scheduler.start()
    scheduler.addTask({
      chatId: 'c',
      text: 't',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    assert.equal(runs.length, 0)
    scheduler.stop()
    await timer.advance(2 * 60 * 60 * 1000)
    assert.equal(runs.length, 0)
    timer.reset()
  }

  // 超过 setTimeout 最大延时不会溢出，远未来任务也能正常触发
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'max-timeout.json'), () => undefined)
    await scheduler.start()
    scheduler.addTask({
      chatId: 'c',
      text: 't',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    // 把内部 nextRunAt 推到 50 天后，模拟远超最大延时的任务
    const far = timer.currentTime() + 50 * 24 * 60 * 60 * 1000
    const internal = (scheduler as unknown as { tasks: ScheduledTask[] }).tasks[0]
    internal.nextRunAt = far
    await scheduler.start() // 重复 start，应被忽略，但会重新安排（幂等）
    const beforeNear = 2 * 60 * 60 * 1000 - 1
    await timer.advance(beforeNear)
    assert.equal(runs.length, 0)
    await timer.advance(1)
    // 先触发近处 timer，调度器重新发现远任务并再次设置长延时
    assert.equal(runs.length, 0)
    const remaining = far - timer.currentTime()
    await timer.advance(remaining)
    assert.equal(runs.length, 1)
    scheduler.stop()
    timer.reset()
  }

  // reconcile 能在 timer 缺失时补执行到期任务（模拟系统睡眠恢复）
  {
    const timer = new FakeTimer(0)
    const { scheduler, runs } = makeScheduler(join(tempDir, 'reconcile.json'), () => undefined)
    await scheduler.start()
    const task = scheduler.addTask({
      chatId: 'c',
      text: 't',
      time: '10:00',
      repeat: 'daily',
      timezone: 'Asia/Shanghai'
    })
    // 清除内部 timer，模拟错过唤醒
    const timerId = (scheduler as unknown as { timer: number | null }).timer
    if (timerId !== null) {
      clearTimeout(timerId)
      ;(scheduler as unknown as { timer: number | null }).timer = null
    }
    await timer.advance(2 * 60 * 60 * 1000)
    assert.equal(runs.length, 0)
    await scheduler.reconcile()
    assert.equal(runs.length, 1)
    assert.equal(runs[0], task.id)
    scheduler.stop()
    timer.reset()
  }
}

async function main(): Promise<void> {
  testPureFunctions()
  testMigration()
  await testCreationAndExecution()
  await testScheduler()
  console.log('SCHEDULE_SMOKE_OK')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })
