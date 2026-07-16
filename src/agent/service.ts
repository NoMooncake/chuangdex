// ─────────────────────────────────────────────────────────────
// ChuangDex Agent 内核入口（本地模块）
//
// 处理一条消息的完整流程：
//   收到消息 → 发现 Skills → 选择 Skill（触发词匹配）
//   → 组装提示词（命中时注入 Skill 工作说明）→ 调用模型 → 返回回复
//
// Skill 不是另一个模型，而是一套可复用的工作方法：
// 它通过注入系统提示词来规范模型的输出。发现与选择全部由
// 本服务负责，React 界面不参与。
// ─────────────────────────────────────────────────────────────

import type { AgentReply, AgentRunEvent, AgentTitleReply, HistoryMessage, RunStatus } from '../shared/agent'
import type { ChatMessage, ModelProvider } from './providers/types'
import { matchSkill, type SkillMatch } from './skills/matcher'
import type { Skill } from './skills/types'

export interface AgentRequest {
  sessionId: string
  text: string
  /** 当前会话的最近历史消息（按时间正序），服务内会再过滤并截断到上限 */
  history?: HistoryMessage[]
  /** true 表示这是定时任务到点后的执行：text 是创建任务时交代的内容，不是新请求 */
  scheduled?: boolean
}

/** 运行记录的发射口：Agent 服务每产生一条记录就调用一次 */
export type RunEventSink = (event: AgentRunEvent) => void

/** ChuangDex 助手的基础人格设定（始终随请求发给模型） */
const BASE_SYSTEM_PROMPT =
  '你是 ChuangDex 桌面客户端的内置助手。请简洁、准确地回答用户的问题，使用中文。'

/**
 * 定时任务到点执行专用提示词。
 * 关键：告诉模型任务已创建、现在就是执行时间——它只需要生成此刻应发的内容，
 * 不要重新评估能否创建提醒，不要追问，也不要建议改用日历或闹钟。
 */
const SCHEDULED_EXECUTION_PROMPT =
  '你正在为 ChuangDex 执行一个定时任务。这个任务早已创建成功，现在就是它的执行时间；' +
  '计时与触发由 ChuangDex 负责，不需要你判断或安排。\n' +
  '用户消息是创建任务时交代的内容，不是一条新请求。你只需要生成此刻应该直接发给用户的最终内容：\n' +
  '· 简单提醒类（如“提醒我要开会”）：直接输出一条简洁提醒（如“⏰ 提醒：该开会了”），' +
  '不要追问、不要解释、不要建议改用日历或闹钟。\n' +
  '· 生成类任务（如整理日报、写摘要）：按任务要求完成并输出成品；不得编造用户没有提供的事实。\n' +
  '不要重新判断能否创建提醒，也不要向用户提及任务机制本身。'

/** 自动命名专用提示词：只要一个简短标题，不要任何多余内容 */
const TITLE_SYSTEM_PROMPT =
  '请为用户的消息生成一个会话标题。要求：不超过 12 个汉字；能概括消息主题；' +
  '不使用引号、句号或任何标点；不输出任何解释；只输出标题本身。'

/** 定时任务意图解析结果 */
export interface ScheduleIntent {
  isSchedule: boolean
  /** HH:MM（24 小时制）；不明确为 null */
  time: string | null
  /** 只支持 daily（每天）/ weekdays（每个工作日）；其他或不明确为 null */
  repeat: 'daily' | 'weekdays' | null
  /** 任务内容概括；无法概括为 null */
  task: string | null
}

/** 定时任务意图解析专用提示词：只输出严格 JSON */
const SCHEDULE_SYSTEM_PROMPT =
  '你是一个意图解析器。判断用户消息是否想创建一个定时任务，并只输出 JSON（不要输出任何其他内容）：\n' +
  '{"is_schedule": true 或 false, "time": "HH:MM" 或 null, "repeat": "daily" 或 "weekdays" 或 null, "task": "任务内容的一句话概括" 或 null}\n\n' +
  '规则：\n' +
  '- 只有用户明确要求“在某个时间、按某种周期执行某件事”时 is_schedule 才为 true；普通问答、闲聊为 false\n' +
  '- repeat 只支持两种：每天 → "daily"；每个工作日（周一至周五）→ "weekdays"。其他周期一律填 null\n' +
  '- time 必须是 24 小时制的具体时间（"早上9点"→"09:00"，"18点"→"18:00"）；时间不明确就填 null\n' +
  '- task 保留用户原意概括，去掉时间与频率表述'

const UNCONFIGURED_HINT =
  'Kimi 尚未配置：请复制 config/models.example.json 为 config/models.local.json，' +
  '填入你的 API Key、Endpoint 和模型名后重试。'

/** 多轮上下文：带入模型的历史消息上限（另有当前消息） */
const MAX_HISTORY_MESSAGES = 12

let runSeq = 0

export class ChuangdexAgentService {
  readonly name = 'chuangdex-agent'
  readonly version = '0.3.0'

  constructor(
    private readonly model: ModelProvider,
    /** 启动时发现的全部 Skill（由主进程扫描 skills/ 目录后注入） */
    private readonly skills: Skill[] = []
  ) {}

  /**
   * 处理一条用户消息。
   * 过程中会向 sink 依次发射运行记录，最终返回回复文本。
   */
  async handleMessage(request: AgentRequest, emit: RunEventSink): Promise<AgentReply> {
    const { sessionId, text } = request

    // 1. 收到消息（定时任务执行时标记为“执行已触发的定时任务”）
    const scheduled = request.scheduled === true
    emit(
      this.makeRun(
        sessionId,
        scheduled ? '执行已触发的定时任务' : '收到消息',
        scheduled ? `任务内容：${text.slice(0, 40)}` : `会话 ${sessionId} · ${text.length} 个字符`,
        'success'
      )
    )

    // 2. 读取会话历史：只用当前会话提供的消息，过滤无效项，最多带入最近 12 条
    const provided = request.history?.length ?? 0
    const history = (request.history ?? [])
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0
      )
      .slice(-MAX_HISTORY_MESSAGES)
    emit(
      this.makeRun(sessionId, '读取会话历史', `当前会话 · 提供 ${provided} 条`, 'success')
    )
    emit(
      this.makeRun(
        sessionId,
        `已带入 ${history.length} 条上下文消息`,
        history.length > 0
          ? `最近 ${history.length} 条历史 + 当前消息，按时间顺序发送`
          : '本会话暂无历史，仅发送当前消息',
        'success'
      )
    )

    // 2. 发现 Skills（启动时扫描的结果，这里汇报给运行面板）
    const names = this.skills.map((s) => s.name).join('、')
    emit(
      this.makeRun(
        sessionId,
        '发现 Skills',
        this.skills.length > 0 ? `共 ${this.skills.length} 个可用：${names}` : 'skills/ 目录为空',
        'success'
      )
    )

    // 3. 选择 Skill（触发关键词匹配；未命中则按普通对话处理）
    const match = matchSkill(this.skills, text)
    if (match) {
      emit(
        this.makeRun(
          sessionId,
          `选择 ${match.skill.name}`,
          `命中关键词：${match.matchedTriggers.join('、')}`,
          'success'
        )
      )
    } else {
      emit(this.makeRun(sessionId, '未匹配 Skill', '按普通对话直接调用模型', 'success'))
    }

    // 4. 准备调用模型（配置缺失时直接失败，给出可操作的提示）
    if (!this.model.isConfigured()) {
      emit(this.makeRun(sessionId, '准备调用模型', `模型「${this.model.name}」未配置`, 'failed'))
      return { sessionId, content: UNCONFIGURED_HINT }
    }
    emit(
      this.makeRun(
        sessionId,
        '准备调用模型',
        match
          ? `${this.model.describeTarget()} · 已注入「${match.skill.name}」的工作说明`
          : this.model.describeTarget(),
        'success'
      )
    )

    // 5. 调用模型（running 记录，完成后原地更新状态）
    const runningTitle = match ? '正在按 Skill 生成回复' : `正在等待 ${this.model.name} 回复`
    const waitingId = this.nextId()
    emit(this.makeRun(sessionId, runningTitle, '请求已发送…', 'running', waitingId))

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(match, scheduled) },
      ...history,
      { role: 'user', content: text }
    ]

    const startedAt = Date.now()
    try {
      const response = await this.model.chat({ messages })
      const latency = ((Date.now() - startedAt) / 1000).toFixed(1)

      emit(this.makeRun(sessionId, runningTitle, '响应正常', 'success', waitingId))

      // 6. 已收到模型回复
      const usageText = response.usage
        ? ` · 输入 ${response.usage.promptTokens} / 输出 ${response.usage.completionTokens} tokens`
        : ''
      emit(
        this.makeRun(
          sessionId,
          '已收到模型回复',
          `${response.model} · ${latency}s${usageText}`,
          'success'
        )
      )

      // 7. 收尾
      emit(
        this.makeRun(
          sessionId,
          scheduled ? '任务内容已生成' : match ? 'Skill 执行完成' : '已完成',
          match
            ? `${match.skill.name} · 回复 ${response.content.length} 个字符`
            : `回复 ${response.content.length} 个字符`,
          'success'
        )
      )

      return { sessionId, content: response.content }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      emit(this.makeRun(sessionId, runningTitle, reason, 'failed', waitingId))
      return {
        sessionId,
        content: `调用 ${this.model.name} 失败：${reason}。请检查 config/models.local.json 配置或网络后重试。`
      }
    }
  }

  /**
   * 为会话生成自动标题（独立的模型调用，与聊天回复互不影响）。
   * 只参考用户的第一条消息；失败或未配置时返回 title: null，界面保持原标题。
   */
  async generateTitle(request: AgentRequest, emit: RunEventSink): Promise<AgentTitleReply> {
    const { sessionId, text } = request

    if (!this.model.isConfigured()) {
      return { sessionId, title: null }
    }

    const runningId = this.nextId()
    emit(
      this.makeRun(sessionId, '正在生成会话标题', `独立调用 ${this.model.name}…`, 'running', runningId)
    )

    try {
      const response = await this.model.chat({
        messages: [
          { role: 'system', content: TITLE_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ]
      })
      const title = sanitizeTitle(response.content)

      if (!title) {
        emit(this.makeRun(sessionId, '正在生成会话标题', '模型未返回可用标题', 'failed', runningId))
        return { sessionId, title: null }
      }

      emit(this.makeRun(sessionId, '正在生成会话标题', '响应正常', 'success', runningId))
      emit(this.makeRun(sessionId, '会话已自动命名', title, 'success'))
      return { sessionId, title }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      emit(this.makeRun(sessionId, '正在生成会话标题', reason, 'failed', runningId))
      return { sessionId, title: null }
    }
  }

  private nextId(): string {
    runSeq += 1
    return `run-${Date.now()}-${runSeq}`
  }

  /**
   * 解析一条消息是否是定时任务请求（独立的模型调用）。
   * 返回 null 表示无法判断（未配置/调用失败），调用方应走普通对话流程。
   */
  async detectSchedule(text: string, emit: RunEventSink): Promise<ScheduleIntent | null> {
    const sessionId = 'schedule-detect'
    if (!this.model.isConfigured()) return null

    const runningId = this.nextId()
    emit(this.makeRun(sessionId, '解析定时任务意图', `独立调用 ${this.model.name}…`, 'running', runningId))

    try {
      const response = await this.model.chat({
        messages: [
          { role: 'system', content: SCHEDULE_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ]
      })
      const intent = parseScheduleJson(response.content)
      if (!intent) {
        emit(this.makeRun(sessionId, '解析定时任务意图', '模型未返回可用 JSON，按普通对话处理', 'success', runningId))
        return null
      }
      emit(
        this.makeRun(
          sessionId,
          '解析定时任务意图',
          intent.isSchedule
            ? `判定：定时任务 · ${intent.repeat === 'daily' ? '每天' : intent.repeat === 'weekdays' ? '每个工作日' : '频率不明'} ${intent.time ?? '时间不明'}`
            : '判定：普通对话',
          'success',
          runningId
        )
      )
      return intent
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      emit(this.makeRun(sessionId, '解析定时任务意图', `${reason}，按普通对话处理`, 'failed', runningId))
      return null
    }
  }

  private makeRun(
    sessionId: string,
    title: string,
    detail: string,
    status: RunStatus,
    id: string = this.nextId()
  ): AgentRunEvent {
    return {
      id,
      sessionId,
      title,
      detail,
      status,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
  }
}

/**
 * 组装系统提示词。
 * 定时任务执行用 SCHEDULED_EXECUTION_PROMPT 作基底，普通对话用 BASE_SYSTEM_PROMPT；
 * 命中 Skill 时把用途和工作说明附加在基底之后——
 * 这就是 Skill 影响模型输出的方式：不换模型，只约束和指导同一个模型。
 */
function buildSystemPrompt(match: SkillMatch | null, scheduled: boolean): string {
  const base = scheduled ? SCHEDULED_EXECUTION_PROMPT : BASE_SYSTEM_PROMPT
  if (!match) return base
  const { skill } = match
  return [
    base,
    '',
    `# 当前任务使用 Skill：${skill.name}`,
    `## 用途`,
    skill.description,
    `## 工作说明`,
    skill.instructions
  ].join('\n')
}

/**
 * 从模型输出中提取并校验定时任务 JSON。
 * 容忍 ```json 代码块和前后杂音；字段不合法时归一为 null。
 */
function parseScheduleJson(raw: string): ScheduleIntent | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof data.is_schedule !== 'boolean') return null

  let time: string | null = null
  if (typeof data.time === 'string') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(data.time.trim())
    if (m) time = `${m[1].padStart(2, '0')}:${m[2]}`
  }
  const repeat = data.repeat === 'daily' || data.repeat === 'weekdays' ? data.repeat : null
  const task = typeof data.task === 'string' && data.task.trim() ? data.task.trim() : null

  return { isSchedule: data.is_schedule, time, repeat, task }
}

/**
 * 清洗模型返回的标题：取第一行、去引号、去首尾标点、限制长度。
 * 清洗后为空则返回 null（视为命名失败，界面保持“新对话”）。
 */
function sanitizeTitle(raw: string): string | null {
  let title = raw.split(/\r?\n/)[0].trim()
  // 去掉引号和书名号
  title = title.replace(/[""''「」『』《》<>]/g, '')
  // 去掉首尾标点
  title = title.replace(/^[\s，。！？；：、,.!?;:]+/, '').replace(/[\s，。！？；：、,.!?;:]+$/, '')
  if (!title) return null
  // 超长截断（中文字符按 1 计，最多 12 字）
  return Array.from(title).slice(0, 12).join('')
}
