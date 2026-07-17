// Skill 发现：扫描项目 skills/ 目录，解析每个子目录中的 SKILL.md。
// SKILL.md = YAML frontmatter（name / description）+ 正文（工作说明）。
// 只在主进程运行，启动时执行一次。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseDocument } from 'yaml'
import type { Skill } from './types'

/** 扫描 skillsDir，返回发现的全部 Skill；目录不存在或文件不合格时跳过 */
export function loadSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return []

  const skills: Skill[] = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(skillsDir, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue

    try {
      const skill = parseSkillFile(file, readFileSync(file, 'utf-8'))
      if (skill) skills.push(skill)
    } catch {
      // 单个 Skill 解析失败不影响其他 Skill
    }
  }
  return skills
}

/** 解析一个 SKILL.md；缺少必需字段时返回 null */
export function parseSkillFile(path: string, content: string): Skill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  if (match[1].length > 64 * 1024) return null

  let meta: Record<string, unknown>
  try {
    const document = parseDocument(match[1])
    if (document.errors.length > 0) return null
    const parsed = document.toJS({ maxAliasCount: 10 }) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    meta = parsed as Record<string, unknown>
  } catch {
    return null
  }

  const name = typeof meta.name === 'string' ? meta.name.trim() : ''
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!name || !description) return null

  return {
    name,
    description,
    instructions: match[2].trim(),
    path
  }
}
