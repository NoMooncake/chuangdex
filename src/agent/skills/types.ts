// Skill 的最小组成：名称、用途、触发词、工作说明。
// Skill 不是模型，也不是工具——它是一套可复用的工作方法，
// 由 Agent 服务发现并选择，其工作说明会被注入提示词影响模型输出。

export interface Skill {
  /** 唯一名称，如 daily-briefing */
  name: string

  /** 用途：什么场景下应该使用这个 Skill */
  description: string

  /** 触发关键词：用于从用户消息中匹配选择 */
  triggers: string[]

  /** 工作说明（SKILL.md 正文）：注入系统提示词，指导模型如何完成这类任务 */
  instructions: string

  /** SKILL.md 的磁盘路径（仅用于日志和运行记录） */
  path: string
}
