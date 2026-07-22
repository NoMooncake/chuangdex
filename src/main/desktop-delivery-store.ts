// 桌面定时任务结果的待投递队列。
// 结果先落盘，再通知 renderer；renderer 确认写入会话后才删除，避免窗口关闭时丢失。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ScheduledAgentDelivery } from '../shared/agent'

const MAX_PENDING_DELIVERIES = 100

export class DesktopDeliveryStore {
  constructor(private readonly file: string) {}

  load(): ScheduledAgentDelivery[] {
    try {
      if (!existsSync(this.file)) return []
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as { deliveries?: unknown }
      if (!raw || !Array.isArray(raw.deliveries)) return []
      return raw.deliveries.filter(isValidDelivery).slice(-MAX_PENDING_DELIVERIES)
    } catch (error) {
      console.warn('[desktop-scheduler] 待投递结果读取失败：', error)
      return []
    }
  }

  add(delivery: ScheduledAgentDelivery): boolean {
    const deliveries = [...this.load().filter((item) => item.id !== delivery.id), delivery]
      .slice(-MAX_PENDING_DELIVERIES)
    return this.save(deliveries)
  }

  remove(id: string): boolean {
    return this.save(this.load().filter((delivery) => delivery.id !== id))
  }

  private save(deliveries: ScheduledAgentDelivery[]): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, deliveries }), 'utf-8')
      renameSync(tmp, this.file)
      return true
    } catch (error) {
      console.error('[desktop-scheduler] 待投递结果保存失败：', error)
      return false
    }
  }
}

function isValidDelivery(value: unknown): value is ScheduledAgentDelivery {
  if (!value || typeof value !== 'object') return false
  const delivery = value as Partial<ScheduledAgentDelivery>
  return (
    typeof delivery.id === 'string' &&
    typeof delivery.taskId === 'string' &&
    typeof delivery.taskText === 'string' &&
    typeof delivery.sessionId === 'string' &&
    typeof delivery.turnId === 'string' &&
    typeof delivery.content === 'string' &&
    typeof delivery.time === 'string' &&
    Array.isArray(delivery.runs)
  )
}
