export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  time: string
  /** 界面分组标记：同一轮对话（用户消息→回复）共享一个 turnId */
  turnId?: string
}

export type RunStatus = 'success' | 'running' | 'failed'

export interface RunRecord {
  id: string
  title: string
  detail: string
  status: RunStatus
  time: string
  /** 真实时间戳（epoch ms），用于计算耗时 */
  ts?: number
  /** 属于哪一轮对话；无 turnId 的是后台记录（如自动命名） */
  turnId?: string
}

export interface Session {
  id: string
  title: string
  preview: string
  updatedAt: string
  /** 初始自带的演示会话标记；用户新建的会话没有此标记 */
  demo?: boolean
  /** 用户手动改过标题后为 true：自动命名永远不会再覆盖它 */
  renamed?: boolean
  messages: Message[]
  runs: RunRecord[]
}

/**
 * 演示会话：内容只反映 ChuangDex 当前真实能力
 * （Kimi 对话、daily-briefing Skill、飞书定时提醒），
 * 运行记录与 Agent 服务实际产生的步骤保持一致。
 */
export const mockSessions: Session[] = [
  {
    id: 's1',
    demo: true,
    title: '项目事项整理成日报',
    preview: '已按日报格式生成，可直接发群。',
    updatedAt: '10:42',
    messages: [
      {
        id: 'm1',
        role: 'user',
        turnId: 't-1',
        content: '帮我把这些事项整理成日报：修复了登录页闪退，开了新版首页评审会，下午联调推送接口。',
        time: '10:38'
      },
      {
        id: 'm2',
        role: 'assistant',
        turnId: 't-1',
        content:
          '# 工作简报\n\n## 一、今日进展\n- 修复登录页闪退问题\n- 完成新版首页评审\n- 推进推送接口联调\n\n## 二、问题与风险\n- 无\n\n## 三、明日计划\n- 继续推送接口联调（待确认）',
        time: '10:39'
      }
    ],
    runs: [
      { id: 'r1', title: '收到消息', detail: '会话 s1 · 38 个字符', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r2', title: '读取会话历史', detail: '当前会话 · 提供 0 条', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r3', title: '已带入 0 条上下文消息', detail: '本会话暂无历史，仅发送当前消息', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r4', title: '发现 Skills', detail: '共 1 个可用：daily-briefing', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r5', title: '选择 daily-briefing', detail: '命中关键词：日报', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r6', title: '准备调用模型', detail: '已注入「daily-briefing」的工作说明', status: 'success', time: '10:38:02', turnId: 't-1' },
      { id: 'r7', title: '正在按 Skill 生成回复', detail: '响应正常', status: 'success', time: '10:38:05', turnId: 't-1' },
      { id: 'r8', title: '已收到模型回复', detail: '2.4s · 输入 312 / 输出 96 tokens', status: 'success', time: '10:38:05', turnId: 't-1' },
      { id: 'r9', title: 'Skill 执行完成', detail: 'daily-briefing · 回复 89 个字符', status: 'success', time: '10:38:05', turnId: 't-1' }
    ]
  },
  {
    id: 's2',
    demo: true,
    title: '量子纠缠是什么',
    preview: '用一句话概括：两个粒子的状态相互关联……',
    updatedAt: '昨天',
    messages: [
      { id: 'm1', role: 'user', turnId: 't-1', content: '量子纠缠是什么？用通俗的话解释。', time: '昨天 21:03' },
      {
        id: 'm2',
        role: 'assistant',
        turnId: 't-1',
        content: '一句话：两个粒子形成纠缠后，无论相距多远，测量其中一个，另一个的状态会立刻确定。可以把它想象成一对“心有灵犀”的硬币。',
        time: '昨天 21:04'
      },
      { id: 'm3', role: 'user', turnId: 't-2', content: '那它能用来超光速通信吗？', time: '昨天 21:05' },
      {
        id: 'm4',
        role: 'assistant',
        turnId: 't-2',
        content: '不能。测量结果是随机的，你无法控制它变成什么，所以传不了任何信息——超光速通信依然不成立。',
        time: '昨天 21:06'
      }
    ],
    runs: [
      { id: 'r1', title: '收到消息', detail: '会话 s2 · 16 个字符', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r2', title: '读取会话历史', detail: '当前会话 · 提供 0 条', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r3', title: '已带入 0 条上下文消息', detail: '本会话暂无历史，仅发送当前消息', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r4', title: '发现 Skills', detail: '共 1 个可用：daily-briefing', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r5', title: '未匹配 Skill', detail: '按普通对话直接调用模型', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r6', title: '准备调用模型', detail: 'kimi-for-coding', status: 'success', time: '21:03:11', turnId: 't-1' },
      { id: 'r7', title: '正在等待 kimi 回复', detail: '响应正常', status: 'success', time: '21:04:02', turnId: 't-1' },
      { id: 'r8', title: '已收到模型回复', detail: '1.8s · 输入 260 / 输出 74 tokens', status: 'success', time: '21:04:02', turnId: 't-1' },
      { id: 'r9', title: '已完成', detail: '回复 68 个字符', status: 'success', time: '21:04:02', turnId: 't-1' },
      { id: 'r10', title: '收到消息', detail: '会话 s2 · 12 个字符', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r11', title: '读取会话历史', detail: '当前会话 · 提供 2 条', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r12', title: '已带入 2 条上下文消息', detail: '最近 2 条历史 + 当前消息，按时间顺序发送', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r13', title: '发现 Skills', detail: '共 1 个可用：daily-briefing', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r14', title: '未匹配 Skill', detail: '按普通对话直接调用模型', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r15', title: '准备调用模型', detail: 'kimi-for-coding', status: 'success', time: '21:05:40', turnId: 't-2' },
      { id: 'r16', title: '正在等待 kimi 回复', detail: '响应正常', status: 'success', time: '21:06:01', turnId: 't-2' },
      { id: 'r17', title: '已收到模型回复', detail: '2.1s · 输入 402 / 输出 66 tokens', status: 'success', time: '21:06:01', turnId: 't-2' },
      { id: 'r18', title: '已完成', detail: '回复 55 个字符', status: 'success', time: '21:06:01', turnId: 't-2' }
    ]
  },
  {
    id: 's3',
    demo: true,
    title: '飞书定时提醒怎么设',
    preview: '在飞书里直接对机器人说即可……',
    updatedAt: '周一',
    messages: [
      { id: 'm1', role: 'user', turnId: 't-1', content: '怎么让 ChuangDex 每个工作日早上提醒我开站会？', time: '周一 18:20' },
      {
        id: 'm2',
        role: 'assistant',
        turnId: 't-1',
        content: '在飞书里直接对机器人说一句就行，例如：“每个工作日 09:30 提醒我开站会。”它会确认任务，到点自动在该会话里提醒你。',
        time: '周一 18:22'
      }
    ],
    runs: [
      { id: 'r1', title: '收到消息', detail: '会话 s3 · 21 个字符', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r2', title: '读取会话历史', detail: '当前会话 · 提供 0 条', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r3', title: '已带入 0 条上下文消息', detail: '本会话暂无历史，仅发送当前消息', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r4', title: '发现 Skills', detail: '共 1 个可用：daily-briefing', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r5', title: '未匹配 Skill', detail: '按普通对话直接调用模型', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r6', title: '准备调用模型', detail: 'kimi-for-coding', status: 'success', time: '18:20:11', turnId: 't-1' },
      { id: 'r7', title: '正在等待 kimi 回复', detail: '响应正常', status: 'success', time: '18:21:55', turnId: 't-1' },
      { id: 'r8', title: '已收到模型回复', detail: '1.6s · 输入 288 / 输出 71 tokens', status: 'success', time: '18:21:55', turnId: 't-1' },
      { id: 'r9', title: '已完成', detail: '回复 63 个字符', status: 'success', time: '18:21:55', turnId: 't-1' }
    ]
  }
]
