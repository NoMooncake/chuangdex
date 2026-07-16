// Skill 发现：扫描项目 skills/ 目录，解析每个子目录中的 SKILL.md。
// SKILL.md = YAML frontmatter（name / description / triggers）+ 正文（工作说明）。
// 只在主进程运行，启动时执行一次。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
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
function parseSkillFile(path: string, content: string): Skill | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  // 极简 frontmatter 解析：只支持「key: value」单行，triggers 用逗号分隔
  const meta: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w[\w-]*):\s*(.+)$/)
    if (m) meta[m[1]] = m[2].trim()
  }

  if (!meta.name || !meta.description) return null

  return {
    name: meta.name,
    description: meta.description,
    triggers: (meta.triggers ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    instructions: match[2].trim(),
    path
  }
}
