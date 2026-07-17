// Skill 选择：由 ChuangDex Agent 理解用户意图后，决定是否需要使用某个 Skill。
// 不再依赖关键词匹配；而是把当前可用 Skills 的名称和用途交给模型，
// 让模型根据用户请求和会话上下文输出一个严格的 JSON 决策。

import type { ChatMessage, ModelProvider } from '../providers/types'
import type { Skill, SkillMatch } from './types'

export interface SkillSelectionResult {
  match: SkillMatch | null
  /** 选择状态：命中、未命中、判断失败 */
  state: 'used' | 'none' | 'failed'
  /** 失败时的简短原因（仅在 state === 'failed' 时存在） */
  error?: string
}

export class SkillSelector {
  constructor(private readonly model: ModelProvider) {}

  async select(
    skills: Skill[],
    text: string,
    history: { role: 'user' | 'assistant'; content: string }[]
  ): Promise<SkillSelectionResult> {
    if (skills.length === 0) {
      return { match: null, state: 'none' }
    }
    if (!this.model.isConfigured()) {
      return { match: null, state: 'failed', error: '模型未配置' }
    }

    try {
      const response = await this.model.chat({
        messages: [
          { role: 'system', content: buildSelectorPrompt(skills) },
          ...history.slice(-6).map((message) => ({ role: message.role, content: message.content }) as ChatMessage),
          { role: 'user', content: text }
        ]
      })
      const match = parseSelectionJson(response.content, skills)
      return match ? { match, state: 'used' } : { match: null, state: 'none' }
    } catch (err) {
      return {
        match: null,
        state: 'failed',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

function buildSelectorPrompt(skills: Skill[]): string {
  const list = skills
    .map((skill, index) => `${index + 1}. ${skill.name}：${skill.description}`)
    .join('\n')

  return [
    '你是一个 Skill 选择器。请根据用户请求和会话上下文，判断是否需要使用某个 Skill 来完成任务。',
    '不要仅根据关键词判断；只有当用户真正需要完成某个 Skill 所描述的能力时，才选择该 Skill。',
    '',
    '当前可用 Skills：',
    list,
    '',
    '请只输出严格 JSON，不要输出任何解释、注释或 Markdown 代码块：',
    '{"useSkill": true | false, "skillName": "skill-name" | null}',
    '',
    '规则：',
    '- 如果用户只是询问 Skill 的含义、测试、闲聊，或请求与所有 Skills 无关，输出 {"useSkill":false,"skillName":null}。',
    '- skillName 必须是可用 Skills 列表中某个 Skill 的 name 字段，否则视为未命中。',
    '- 不要输出你的思考过程。'
  ].join('\n')
}

function parseSelectionJson(raw: string, skills: Skill[]): SkillMatch | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null

  let data: Record<string, unknown>
  try {
    data = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }

  if (typeof data.useSkill !== 'boolean') return null
  if (!data.useSkill) return null

  const skillName = data.skillName
  if (typeof skillName !== 'string') return null

  const skill = skills.find((s) => s.name === skillName.trim())
  if (!skill) return null

  return { skill }
}
