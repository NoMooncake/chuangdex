// 会话数据的本机持久化（仅在主进程运行）。
//
// 存储位置：Electron userData 目录下的 sessions.json
//   macOS:  ~/Library/Application Support/chuangdex/sessions.json
//   Windows: %APPDATA%/chuangdex/sessions.json
//
// 主进程只把会话数据当作不透明 JSON 存取，不关心内部结构；
// 这里不接触、也不写入任何模型配置或 API Key。

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { SessionsLoadResult, SessionsSavePayload } from '../shared/agent'

const FILE_VERSION = 1
const SAVE_DEBOUNCE_MS = 150

export function sessionsFilePath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

/** 启动时读取已保存的会话；文件缺失、损坏或结构不符时返回 null（界面回退到初始状态） */
export function loadPersistedSessions(): SessionsLoadResult {
  try {
    const file = sessionsFilePath()
    if (!existsSync(file)) return null

    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      activeId?: unknown
      sessions?: unknown
    }
    if (!raw || typeof raw.activeId !== 'string' || !Array.isArray(raw.sessions)) {
      return null
    }
    return { activeId: raw.activeId, sessions: raw.sessions }
  } catch (err) {
    // JSON 损坏等情况：不崩溃，安全回退
    console.warn('[chuangdex] sessions.json 读取失败，已回退到初始会话：', err)
    return null
  }
}

let saveTimer: NodeJS.Timeout | null = null

/** 防抖保存：运行记录会成批到达，合并短时间内的多次写入 */
export function scheduleSaveSessions(state: SessionsSavePayload): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => writeSessionsNow(state), SAVE_DEBOUNCE_MS)
}

/** 原子写入：先写临时文件再重命名，避免崩溃时留下半个文件 */
function writeSessionsNow(state: SessionsSavePayload): void {
  try {
    const file = sessionsFilePath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, ...state }), 'utf-8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[chuangdex] 会话保存失败：', err)
  }
}
