// ChuangDex 自己的本机模型配置加载器（仅在主进程运行）。
// 读取项目下 config/models.local.json（已被 .gitignore 忽略，不会提交）。
// 不读取、不依赖任何其他工具（包括 Pi）的配置文件。

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { KimiConfig } from '../agent/providers/kimi'

export interface ModelsConfigFile {
  providers?: {
    kimi?: Partial<KimiConfig>
  }
}

/** 配置文件的预期位置（用于报错提示） */
export function modelsConfigPath(appPath: string): string {
  return join(appPath, 'config', 'models.local.json')
}

/** 读取 Kimi 配置；文件缺失、JSON 损坏或字段不全时返回 null */
export function loadKimiConfig(appPath: string): KimiConfig | null {
  const file = modelsConfigPath(appPath)
  if (!existsSync(file)) return null

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as ModelsConfigFile
    const kimi = raw.providers?.kimi
    if (!kimi?.apiKey || !kimi.baseUrl || !kimi.model) return null
    return { apiKey: kimi.apiKey, baseUrl: kimi.baseUrl, model: kimi.model }
  } catch {
    return null
  }
}
