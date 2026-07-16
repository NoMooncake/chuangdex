// ─────────────────────────────────────────────────────────────
// ChuangDex 周期定时任务引擎（纯逻辑，不依赖飞书 SDK / Electron）
//
// 支持两种重复方式：每天（daily）、每个工作日（weekdays）。
// 任务持久化在 JSON 文件中，重启后恢复；
// 执行策略为“先推进、后执行”——先把下一次执行时间写盘，再运行任务，
// 因此重启或重复触发都不会导致同一时间的任务被重复回复。
// ─────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export type RepeatMode = 'daily' | 'weekdays'

export interface ScheduledTask {
  id: string
  /** 飞书会话 ID：执行结果回复到创建任务的那个会话 */
  chatId: string
  /** 用户当初交代的任务内容 */
  text: string
  /** 执行时间，HH:MM（24 小时制） */
  time: string
  repeat: RepeatMode
  /** 下一次执行时间（epoch ms） */
  nextRunAt: number
  /** 上一次执行时间（epoch ms），用于观察与防重 */
  lastRunAt?: number
  createdAt: number
}

export function repeatLabel(repeat: RepeatMode): string {
  return repeat === 'daily' ? '每天' : '每个工作日（周一至周五）'
}

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 计算下一次执行时间：from 之后最近的一个 “time 时刻 + 满足重复方式” 的日期。
 * weekdays 遇到周六/周日顺延到下个周一。
 */
export function computeNextRun(time: string, repeat: RepeatMode, from: number = Date.now()): number {
  const [h, m] = time.split(':').map(Number)
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setHours(h, m)
  if (candidate.getTime() <= from) {
    candidate.setDate(candidate.getDate() + 1)
  }
  if (repeat === 'weekdays') {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1)
    }
  }
  return candidate.getTime()
}

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/**
 * 任务文件属于本机持久化边界，不能把未校验的 JSON 当成 ScheduledTask 使用。
 * 单条坏记录会被忽略，避免它阻塞其它正常任务或制造无效的执行时间。
 */
function isScheduledTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<ScheduledTask>
  return (
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.chatId === 'string' &&
    task.chatId.length > 0 &&
    typeof task.text === 'string' &&
    task.text.trim().length > 0 &&
    isValidTime(task.time) &&
    (task.repeat === 'daily' || task.repeat === 'weekdays') &&
    typeof task.nextRunAt === 'number' &&
    Number.isFinite(task.nextRunAt) &&
    (task.lastRunAt === undefined || (typeof task.lastRunAt === 'number' && Number.isFinite(task.lastRunAt))) &&
    typeof task.createdAt === 'number' &&
    Number.isFinite(task.createdAt)
  )
}

/** JSON 文件任务仓库：读失败返回空表；写为原子替换 */
export class TaskStore {
  constructor(private readonly file: string) {}

  load(): ScheduledTask[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as { tasks?: unknown }
      if (!raw || !Array.isArray(raw.tasks)) return []
      const tasks = raw.tasks.filter(isScheduledTask)
      const discarded = raw.tasks.length - tasks.length
      if (discarded > 0) {
        console.warn(`[scheduler] 已忽略 ${discarded} 条格式无效的定时任务记录`)
      }
      return tasks
    } catch (err) {
      console.error('[scheduler] 任务读取失败，已以空任务启动：', err)
      return []
    }
  }

  /**
   * 原子保存。调用方必须检查返回值：没能写盘时不能确认创建，也不能开始执行，
   * 否则重启后会失去“同一时间只执行一次”的保障。
   */
  save(tasks: ScheduledTask[]): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, tasks }), 'utf-8')
      renameSync(tmp, this.file)
      return true
    } catch (err) {
      console.error('[scheduler] 任务保存失败：', err)
      return false
    }
  }
}

export type TaskRunner = (task: ScheduledTask) => Promise<void>
export type SchedulerLog = (line: string) => void

let taskSeq = 0
const TICK_MS = 30_000

export class TaskScheduler {
  private tasks: ScheduledTask[] = []
  private timer: NodeJS.Timeout | null = null
  /** setInterval 不会等待 async 回调；用这把锁确保多个巡检不会交叠执行。 */
  private ticking = false

  constructor(
    private readonly store: TaskStore,
    private readonly runner: TaskRunner,
    private readonly log: SchedulerLog = (line) => console.log(line)
  ) {}

  /** 加载任务并启动巡检；启动时已到期的任务立即补执行一次 */
  start(): void {
    if (this.timer) {
      this.log('[scheduler] 调度器已启动，忽略重复启动')
      return
    }
    this.tasks = this.store.load()
    this.log(`[scheduler] 已加载 ${this.tasks.length} 个定时任务`)
    for (const t of this.tasks) {
      this.log(`[scheduler]   · ${t.id} · ${repeatLabel(t.repeat)} ${t.time} · 下次执行 ${formatTime(t.nextRunAt)}`)
    }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 创建任务：立即计算下一次执行时间并落盘 */
  addTask(input: { chatId: string; text: string; time: string; repeat: RepeatMode }): ScheduledTask {
    if (!input.chatId || !input.text.trim() || !isValidTime(input.time)) {
      throw new Error('定时任务参数不完整或时间格式无效')
    }
    taskSeq += 1
    const task: ScheduledTask = {
      id: `task-${Date.now()}-${taskSeq}`,
      chatId: input.chatId,
      text: input.text,
      time: input.time,
      repeat: input.repeat,
      nextRunAt: computeNextRun(input.time, input.repeat),
      createdAt: Date.now()
    }
    this.tasks.push(task)
    if (!this.store.save(this.tasks)) {
      this.tasks.pop()
      throw new Error('定时任务保存失败，未创建任务')
    }
    this.log(
      `[scheduler] 创建任务 ${task.id} · ${repeatLabel(task.repeat)} ${task.time} · ` +
        `会话 ${task.chatId} · 下次执行 ${formatTime(task.nextRunAt)} · 内容「${task.text.slice(0, 30)}」`
    )
    return task
  }

  /** 巡检：执行所有到期任务（串行，避免并发重复） */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = Date.now()
      for (const task of this.tasks) {
        if (task.nextRunAt <= now) {
          await this.fire(task)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  /**
   * 执行一个任务。先把 lastRunAt / nextRunAt 写盘，再运行——
   * 哪怕执行中途崩溃或重启，这个时间的这次执行也不会再来第二次。
   */
  private async fire(task: ScheduledTask): Promise<void> {
    const previousLastRunAt = task.lastRunAt
    const previousNextRunAt = task.nextRunAt
    task.lastRunAt = Date.now()
    task.nextRunAt = computeNextRun(task.time, task.repeat)
    if (!this.store.save(this.tasks)) {
      if (previousLastRunAt === undefined) delete task.lastRunAt
      else task.lastRunAt = previousLastRunAt
      task.nextRunAt = previousNextRunAt
      this.log(`[scheduler] 任务 ${task.id} 未执行：无法先保存下一次执行时间，将在下次巡检重试`)
      return
    }

    this.log(`[scheduler] 执行任务 ${task.id} · 内容「${task.text.slice(0, 40)}」`)
    try {
      await this.runner(task)
      this.log(`[scheduler] 任务 ${task.id} 执行完成 · 下次执行 ${formatTime(task.nextRunAt)}`)
    } catch (err) {
      this.log(
        `[scheduler] 任务 ${task.id} 执行失败：${err instanceof Error ? err.message : String(err)} · ` +
          `下次执行 ${formatTime(task.nextRunAt)}`
      )
    }
  }
}
