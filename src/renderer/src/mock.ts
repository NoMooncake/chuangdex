export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  time: string
}

export type RunStatus = 'success' | 'running' | 'failed'

export interface RunRecord {
  id: string
  title: string
  detail: string
  status: RunStatus
  time: string
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

export const mockSessions: Session[] = [
  {
    id: 's1',
    demo: true,
    title: '整理本周会议纪要',
    preview: '已生成 3 条待办，是否同步到日历？',
    updatedAt: '10:42',
    messages: [
      { id: 'm1', role: 'user', content: '帮我把本周的会议纪要整理成摘要。', time: '10:38' },
      {
        id: 'm2',
        role: 'assistant',
        content: '好的。我找到了 4 场会议，已提取要点并生成摘要草案。',
        time: '10:39'
      },
      { id: 'm3', role: 'user', content: '把里面的行动项单独列出来。', time: '10:41' },
      {
        id: 'm4',
        role: 'assistant',
        content: '已生成 3 条待办：\n1. 确认新版首页视觉稿\n2. 输出 Q3 复盘文档\n3. 跟进部署流水线告警\n\n是否同步到日历？',
        time: '10:42'
      }
    ],
    runs: [
      { id: 'r1', title: '搜索会议记录', detail: '检索本周 4 场会议', status: 'success', time: '10:38:12' },
      { id: 'r2', title: '生成摘要', detail: '模型推理 · 1280 tokens', status: 'success', time: '10:39:03' },
      { id: 'r3', title: '提取行动项', detail: '模型推理 · 642 tokens', status: 'success', time: '10:41:47' },
      { id: 'r4', title: '等待用户确认', detail: '同步日历前需要确认', status: 'running', time: '10:42:01' }
    ]
  },
  {
    id: 's2',
    demo: true,
    title: '排查构建失败',
    preview: 'CI 在第 3 步失败：依赖安装超时',
    updatedAt: '昨天',
    messages: [
      { id: 'm1', role: 'user', content: '昨晚的 CI 构建为什么挂了？', time: '昨天 21:03' },
      {
        id: 'm2',
        role: 'assistant',
        content: '我拉取了日志：第 3 步依赖安装超时（registry 响应 30s 无数据）。建议重试或切换镜像源。',
        time: '昨天 21:04'
      }
    ],
    runs: [
      { id: 'r1', title: '读取 CI 日志', detail: 'build #482 · 1.2 MB', status: 'success', time: '21:03:40' },
      { id: 'r2', title: '分析失败原因', detail: '定位到 step 3/6', status: 'success', time: '21:04:02' },
      { id: 'r3', title: '重试依赖安装', detail: '网络超时，已放弃', status: 'failed', time: '21:04:31' }
    ]
  },
  {
    id: 's3',
    demo: true,
    title: '周报草稿',
    preview: '还差数据部分，需要你提供数据源。',
    updatedAt: '周一',
    messages: [
      { id: 'm1', role: 'user', content: '按模板起草这周周报。', time: '周一 18:20' },
      {
        id: 'm2',
        role: 'assistant',
        content: '草稿已完成 70%，数据部分缺少来源。请提供数据文件或告诉我从哪里取数。',
        time: '周一 18:22'
      }
    ],
    runs: [
      { id: 'r1', title: '加载周报模板', detail: 'template: weekly-v2', status: 'success', time: '18:20:11' },
      { id: 'r2', title: '生成正文草稿', detail: '模型推理 · 2140 tokens', status: 'success', time: '18:21:55' }
    ]
  }
]
