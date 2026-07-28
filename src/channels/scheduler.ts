// ─────────────────────────────────────────────────────────────
// ChuangDex 周期定时任务引擎（纯逻辑，不依赖飞书 SDK / Electron）
//
// 调度方式：由 cron 表达式 + 时区描述周期；运行时只维护一个 setTimeout，
// 等待最近的一项任务，不再 30 秒轮询。
// 任务持久化在 JSON 文件中，version 2 保存 cron/timezone；兼容读取 version 1。
// 执行策略仍为“先推进、后执行”——先把下一次执行时间写盘，再运行任务，
// 因此重启或重复触发都不会导致同一时间的任务被重复回复。
// ─────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { Cron } from 'croner'

export type RepeatMode = 'daily' | 'weekdays'

export interface ScheduledTask {
  id: string
  /** 渠道内的目标会话 ID：执行结果回复到创建任务的那个会话 */
  chatId: string
  /** 用户当初交代的任务内容 */
  text: string
  /** 执行时间，HH:MM（24 小时制），用于展示和自然语言输入 */
  time: string
  repeat: RepeatMode
  /** 五段 cron 表达式，例如 `30 9 * * 1-5` */
  cron: string
  /** IANA 时区，例如 `Asia/Shanghai` */
  timezone: string
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

/** 获取系统时区；无法获取或无效时回退到上海。 */
export function systemDefaultTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (isValidTimezone(tz)) return tz
  } catch {
    // fallthrough
  }
  return 'Asia/Shanghai'
}

function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function isRepeatMode(value: unknown): value is RepeatMode {
  return value === 'daily' || value === 'weekdays'
}

export function isValidTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function isValidCron(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    new Cron(value, { mode: '5-part' })
    return true
  } catch {
    return false
  }
}

/** 从 time + repeat 生成标准五段 cron 表达式。 */
export function toCronExpression(time: string, repeat: RepeatMode): string {
  const [hour, minute] = time.split(':').map(Number)
  if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error('时间格式无效')
  return `${minute} ${hour} * * ${repeat === 'weekdays' ? '1-5' : '*'}`
}

/** 基于 cron + 时区计算下一次执行时间；prev 默认当前时间。 */
export function computeNextRun(cron: string, timezone: string, from = Date.now()): number {
  const next = new Cron(cron, { mode: '5-part', timezone }).nextRun(new Date(from))
  if (!next) return from + 24 * 60 * 60 * 1000
  return next.getTime()
}

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
    isRepeatMode(task.repeat) &&
    typeof task.cron === 'string' &&
    isValidCron(task.cron) &&
    typeof task.timezone === 'string' &&
    isValidTimezone(task.timezone) &&
    typeof task.nextRunAt === 'number' &&
    Number.isFinite(task.nextRunAt) &&
    (task.lastRunAt === undefined || (typeof task.lastRunAt === 'number' && Number.isFinite(task.lastRunAt))) &&
    typeof task.createdAt === 'number' &&
    Number.isFinite(task.createdAt)
  )
}

interface V1ScheduledTask {
  id: string
  chatId: string
  text: string
  time: string
  repeat: RepeatMode
  nextRunAt: number
  lastRunAt?: number
  createdAt: number
}

function isV1ScheduledTask(value: unknown): value is V1ScheduledTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<V1ScheduledTask>
  return (
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.chatId === 'string' &&
    task.chatId.length > 0 &&
    typeof task.text === 'string' &&
    task.text.trim().length > 0 &&
    isValidTime(task.time) &&
    isRepeatMode(task.repeat) &&
    typeof task.nextRunAt === 'number' &&
    Number.isFinite(task.nextRunAt) &&
    (task.lastRunAt === undefined || (typeof task.lastRunAt === 'number' && Number.isFinite(task.lastRunAt))) &&
    typeof task.createdAt === 'number' &&
    Number.isFinite(task.createdAt)
  )
}

function migrateV1Task(value: unknown, timezone: string): ScheduledTask | null {
  if (!isV1ScheduledTask(value)) return null
  try {
    const cron = toCronExpression(value.time, value.repeat)
    return {
      ...value,
      cron,
      timezone,
      nextRunAt: computeNextRun(cron, timezone)
    }
  } catch {
    return null
  }
}

export interface StoredTasks {
  version: number
  tasks: unknown[]
}

/** JSON 文件任务仓库：读失败返回空表；写为原子替换 */
export class TaskStore {
  constructor(private readonly file: string) {}

  load(): ScheduledTask[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredTasks
      const version = typeof raw?.version === 'number' ? raw.version : 1
      if (!raw || !Array.isArray(raw.tasks)) return []
      const defaultTz = systemDefaultTimezone()

      if (version === 1) {
        const migrated = raw.tasks
          .map((item) => migrateV1Task(item, defaultTz))
          .filter((task): task is ScheduledTask => task !== null)
        const discarded = raw.tasks.length - migrated.length
        if (discarded > 0) {
          console.warn(`[scheduler] 迁移时忽略 ${discarded} 条格式无效的 version 1 定时任务记录`)
        }
        this.save(migrated)
        return migrated
      }

      if (version >= 2) {
        const tasks = raw.tasks.filter(isScheduledTask)
        const discarded = raw.tasks.length - tasks.length
        if (discarded > 0) {
          console.warn(`[scheduler] 已忽略 ${discarded} 条格式无效的定时任务记录`)
        }
        return tasks
      }

      return []
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
      writeFileSync(tmp, JSON.stringify({ version: 2, tasks }, null, 2), 'utf-8')
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

/** Node.js setTimeout 最大安全延时（2^31 - 1 毫秒）。 */
const MAX_TIMEOUT_MS = 2_147_483_647

/** 保存失败后的退避时间，避免保存持续失败时形成 0ms 忙循环。 */
const SAVE_FAILURE_BACKOFF_MS = 30_000

export class TaskScheduler {
  private tasks: ScheduledTask[] = []
  private timer: NodeJS.Timeout | null = null
  /** 防止 runDueTasks 与自身或 reconcile 交叠执行。 */
  private ticking = false
  /** 启动状态不能依赖 timer 是否存在：空任务时 timer 为 null。 */
  private started = false
  /** 保存失败后最早允许重试的时间。 */
  private retryAfter = 0
  private readonly defaultTimezone: string

  constructor(
    private readonly store: TaskStore,
    private readonly runner: TaskRunner,
    private readonly log: SchedulerLog = (line) => console.log(line)
  ) {
    this.defaultTimezone = systemDefaultTimezone()
  }

  /** 加载任务并启动调度；已到期任务立即补执行一次。 */
  async start(): Promise<void> {
    if (this.started) {
      this.log('[scheduler] 调度器已启动，忽略重复启动')
      return
    }
    this.started = true
    this.retryAfter = 0
    this.tasks = this.store.load()
    this.log(`[scheduler] 已加载 ${this.tasks.length} 个定时任务`)
    for (const t of this.tasks) {
      this.log(`[scheduler]   · ${t.id} · ${t.cron} · ${t.timezone} · 下次执行 ${formatTime(t.nextRunAt)}`)
    }
    await this.runDueTasks()
  }

  stop(): void {
    this.started = false
    this.retryAfter = 0
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 返回任务快照，供桌面端展示；调用方不能改写调度器的内存状态。 */
  listTasks(): ScheduledTask[] {
    return this.tasks.map((task) => ({ ...task }))
  }

  /**
   * 创建任务：立即计算下一次执行时间并落盘。
   * 如果传入有效 cron/timezone 则直接使用；否则从 time/repeat 推导。
   */
  addTask(input: {
    chatId: string
    text: string
    time: string
    repeat: RepeatMode
    cron?: string
    timezone?: string
  }): ScheduledTask {
    if (!input.chatId || !input.text.trim() || !isValidTime(input.time) || !isRepeatMode(input.repeat)) {
      throw new Error('定时任务参数不完整或时间格式无效')
    }
    taskSeq += 1
    const timezone =
      typeof input.timezone === 'string' && input.timezone.length > 0 && isValidTimezone(input.timezone)
        ? input.timezone
        : this.defaultTimezone
    const cron =
      typeof input.cron === 'string' && input.cron.length > 0 && isValidCron(input.cron)
        ? input.cron
        : toCronExpression(input.time, input.repeat)
    const task: ScheduledTask = {
      id: `task-${Date.now()}-${taskSeq}`,
      chatId: input.chatId,
      text: input.text.trim(),
      time: input.time,
      repeat: input.repeat,
      cron,
      timezone,
      nextRunAt: computeNextRun(cron, timezone),
      createdAt: Date.now()
    }
    this.tasks.push(task)
    if (!this.store.save(this.tasks)) {
      this.tasks.pop()
      throw new Error('定时任务保存失败，未创建任务')
    }
    this.log(
      `[scheduler] 创建任务 ${task.id} · ${repeatLabel(task.repeat)} ${task.time} · ` +
        `cron ${task.cron} · 时区 ${task.timezone} · 会话 ${task.chatId} · ` +
        `下次执行 ${formatTime(task.nextRunAt)} · 内容「${task.text.slice(0, 30)}」`
    )
    this.scheduleNextWakeup()
    return task
  }

  /**
   * 更新任务内容、执行时间和重复方式。更新后的下一次执行时间从现在重新计算，
   * 这样桌面端的编辑会立即作用到正在运行的调度器。
   */
  updateTask(id: string, input: {
    text: string
    time: string
    repeat: RepeatMode
    cron?: string
    timezone?: string
  }): ScheduledTask {
    if (!id || !input.text.trim() || !isValidTime(input.time) || !isRepeatMode(input.repeat)) {
      throw new Error('定时任务参数不完整或时间格式无效')
    }
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index === -1) throw new Error('未找到要编辑的定时任务')

    const previous = this.tasks[index]
    const timezone =
      typeof input.timezone === 'string' && input.timezone.length > 0 && isValidTimezone(input.timezone)
        ? input.timezone
        : previous.timezone
    const cron =
      typeof input.cron === 'string' && input.cron.length > 0 && isValidCron(input.cron)
        ? input.cron
        : toCronExpression(input.time, input.repeat)
    const updated: ScheduledTask = {
      ...previous,
      text: input.text.trim(),
      time: input.time,
      repeat: input.repeat,
      cron,
      timezone,
      nextRunAt: computeNextRun(cron, timezone)
    }
    this.tasks[index] = updated
    if (!this.store.save(this.tasks)) {
      this.tasks[index] = previous
      throw new Error('定时任务保存失败，未更新任务')
    }

    this.log(
      `[scheduler] 编辑任务 ${updated.id} · ${repeatLabel(updated.repeat)} ${updated.time} · ` +
        `cron ${updated.cron} · 时区 ${updated.timezone} · 下次执行 ${formatTime(updated.nextRunAt)} · ` +
        `内容「${updated.text.slice(0, 30)}」`
    )
    this.scheduleNextWakeup()
    return updated
  }

  /** 删除任务并立即持久化，之后的调度不会再执行它。 */
  removeTask(id: string): ScheduledTask {
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index === -1) throw new Error('未找到要删除的定时任务')

    const [removed] = this.tasks.splice(index, 1)
    if (!this.store.save(this.tasks)) {
      this.tasks.splice(index, 0, removed)
      throw new Error('定时任务保存失败，未删除任务')
    }

    this.log(`[scheduler] 删除任务 ${removed.id} · 内容「${removed.text.slice(0, 30)}」`)
    this.scheduleNextWakeup()
    return removed
  }

  /** 外部通知调度器重新核对到期任务（如系统从睡眠恢复）。不依赖 Electron。 */
  async reconcile(): Promise<void> {
    if (!this.started) return
    await this.runDueTasks()
  }

  /** 串行执行所有到期任务，执行完毕或保存失败时重新安排下一次唤醒。 */
  private async runDueTasks(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      while (true) {
        const now = Date.now()
        const due = this.tasks
          .filter((task) => task.nextRunAt <= now)
          .sort((a, b) => a.nextRunAt - b.nextRunAt)
        if (due.length === 0) break
        const success = await this.fire(due[0])
        if (!success) break
      }
    } finally {
      this.ticking = false
      this.scheduleNextWakeup()
    }
  }

  /**
   * 执行一个任务。先把 lastRunAt / nextRunAt 写盘，再运行——
   * 哪怕执行中途崩溃或重启，这个时间的这次执行也不会再来第二次。
   * 返回 false 表示保存失败，调用方应停止继续执行并等待重试。
   */
  private async fire(task: ScheduledTask): Promise<boolean> {
    const previousLastRunAt = task.lastRunAt
    const previousNextRunAt = task.nextRunAt
    task.lastRunAt = Date.now()
    task.nextRunAt = computeNextRun(task.cron, task.timezone, task.nextRunAt)
    if (!this.store.save(this.tasks)) {
      if (previousLastRunAt === undefined) delete task.lastRunAt
      else task.lastRunAt = previousLastRunAt
      task.nextRunAt = previousNextRunAt
      this.retryAfter = Date.now() + SAVE_FAILURE_BACKOFF_MS
      this.log(
        `[scheduler] 任务 ${task.id} 未执行：无法先保存下一次执行时间，将在 ${formatTime(this.retryAfter)} 重试`
      )
      return false
    }
    this.retryAfter = 0
    this.log(`[scheduler] 执行任务 ${task.id} · 内容「${task.text.slice(0, 40)}」`)
    try {
      await this.runner(task)
      this.log(`[scheduler] 任务 ${task.id} 执行完成 · 下次执行 ${formatTime(task.nextRunAt)}`)
      return true
    } catch (err) {
      this.log(
        `[scheduler] 任务 ${task.id} 执行失败：${err instanceof Error ? err.message : String(err)} · ` +
          `下次执行 ${formatTime(task.nextRunAt)}`
      )
      return true
    }
  }

  /** 只维护一个 setTimeout，等待当前任务列表中最近的一次执行。 */
  private scheduleNextWakeup(): void {
    if (!this.started) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const now = Date.now()
    if (this.retryAfter > 0 && this.retryAfter <= now) {
      this.retryAfter = 0
    }
    if (this.tasks.length === 0) {
      this.retryAfter = 0
      return
    }
    const earliest = Math.min(...this.tasks.map((task) => task.nextRunAt))

    let wakeupAt: number
    if (earliest <= now) {
      // 有到期任务：保存失败时退避，否则立即唤醒。
      wakeupAt = this.retryAfter > 0 ? this.retryAfter : now
    } else {
      // 未来任务：同时考虑保存失败的重试点，取更早者。
      wakeupAt = this.retryAfter > 0 ? Math.min(earliest, this.retryAfter) : earliest
    }

    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, wakeupAt - now))
    this.timer = setTimeout(async () => {
      this.timer = null
      await this.runDueTasks()
    }, delay)
  }
}
