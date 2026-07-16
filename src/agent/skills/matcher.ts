// Skill 选择：根据用户消息中的触发关键词，从已发现的 Skill 中选出最合适的一个。
// 纯函数、确定性匹配（不调用模型）；命中关键词最多的 Skill 胜出，全未命中返回 null。

import type { Skill } from './types'

export interface SkillMatch {
  skill: Skill
  /** 命中的触发关键词，用于运行记录展示 */
  matchedTriggers: string[]
}

export function matchSkill(skills: Skill[], userText: string): SkillMatch | null {
  const text = userText.toLowerCase()
  let best: SkillMatch | null = null

  for (const skill of skills) {
    const matched = skill.triggers.filter((t) => t && text.includes(t.toLowerCase()))
    if (matched.length > (best?.matchedTriggers.length ?? 0)) {
      best = { skill, matchedTriggers: matched }
    }
  }
  return best
}
