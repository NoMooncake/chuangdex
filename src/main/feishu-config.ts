// ChuangDex 飞书机器人配置加载器（仅在主进程运行）。
// 读取 config/feishu.local.json（已被 .gitignore 的 config/*.local.json 覆盖，不会提交）。
// 与模型配置完全分离，不读取任何其他工具的配置文件。

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export function feishuConfigPath(appPath: string): string {
  return join(appPath, 'config', 'feishu.local.json')
}

/** 读取飞书配置；文件缺失、JSON 损坏或字段不全时返回 null */
export function loadFeishuConfig(appPath: string): FeishuConfig | null {
  const file = feishuConfigPath(appPath)
  if (!existsSync(file)) return null

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<FeishuConfig>
    if (!raw.appId || !raw.appSecret) return null
    return { appId: raw.appId, appSecret: raw.appSecret }
  } catch {
    return null
  }
}
