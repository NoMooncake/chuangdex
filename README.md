# ChuangDex

ChuangDex 是一个本地优先、可观察、可扩展的 Agent 桌面客户端，同时可作为飞书机器人运行。它把对话、Skills、长期记忆、受控命令执行、MCP 工具和定时任务整合在同一个 Electron 应用中，并把 Agent 每一步的执行过程实时展示出来。

## 核心能力

- **Agent 工作台**：多会话管理、滚动短期记忆、Markdown 消息、自动命名、深浅主题和本地持久化。
- **可观察执行**：对话中的每轮任务都有执行摘要和可折叠记录，右侧栏实时展示步骤、状态和耗时。
- **自定义模型**：通过 API Key、Endpoint 和模型名接入你自己的 OpenAI-compatible 模型服务，Agent 内核与具体厂商接口解耦。
- **Skills**：自动发现内置与用户 Skill，由 Agent 根据当前请求选择是否使用；也可从用户明确提供的公开 GitHub 链接安装完整 Skill 目录。
- **长期记忆**：Agent 可在桌面会话中新增、修改、回忆或删除原子记忆，并提供独立的记忆管理页。
- **受控命令执行**：Agent 可提议在独立工作目录执行非交互式命令，但必须先展示完整命令并等待用户确认。
- **MCP**：在桌面端管理本地 stdio MCP Server，查看连接状态和工具列表；每次工具调用均需用户确认。
- **飞书渠道**：可选的私聊/群聊机器人与周期定时任务，任务到点后自动唤醒 Agent 并回复到原会话。

## 快速开始

需要本机已安装 Node.js 和 npm。

```bash
git clone https://github.com/NoMooncake/chuangdex.git
cd chuangdex
npm install
cp config/models.example.json config/models.local.json
npm run dev
```

启动前编辑 `config/models.local.json`，填入你的 API Key、Endpoint 和模型名。当前 Provider 使用 OpenAI-compatible `/chat/completions` 协议；如果需要 Skills 安装、命令或 MCP 等工具能力，模型还需支持 `tool_calls`。

`config/models.local.json` 已被 Git 忽略，不会提交到仓库。未配置模型时，应用仍可启动和查看本地数据，发送消息时会给出配置提示。

> 如果 Electron 二进制下载缓慢，可使用：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 桌面端使用

### Skills

每个 Skill 是一个包含 `SKILL.md` 的目录。应用启动时会同时加载：

- 仓库 `skills/` 中的内置 Skills。
- Electron `userData/skills/` 中的用户 Skills。

Agent 会结合用户请求和当前会话判断是否选用 Skill，未匹配时按普通对话处理。当用户明确要求安装其提供的公开 GitHub Skill 链接时，ChuangDex 会下载、校验并原子写入完整 Skill 目录，不会自动执行仓库中的脚本或安装步骤。

### 会话短期记忆

桌面会话会保留完整原始消息；当未压缩上下文超过消息数或字符数阈值时，Agent 把较早内容更新为会话级滚动摘要，同时保留最多最近 4 个完整轮次的原文。后续请求使用「早期摘要 + 最近原文 + 当前消息」，压缩失败时自动退回最近 12 条消息继续回答。滚动摘要只用于恢复上下文，不会作为命令、Skill 安装或 MCP 调用授权。

### 长期记忆

长期记忆只在桌面会话中使用，不会注入飞书对话或定时任务。Agent 根据对话判断是否需要保存或更新记忆，用户也可在「记忆」页查看和删除。记忆最多保留 50 条，单条最多 500 个字符。

### 命令执行

命令工具只在桌面会话中开放，并且：

- 执行前必须由用户明确确认。
- 固定从系统「文稿/Documents」目录下的 `ChuangDex Workspace` 运行，不直接使用应用源码或配置目录。
- 不继承 API Key 等应用环境变量，并拦截凭据读取、完整环境变量输出和高风险破坏命令。
- 输出大小和执行时间均有上限，超限会截断或终止。

### MCP

「MCP」页可新增、编辑、启用、重连和删除本地 stdio Server，并展示实时状态与已发现的工具。当前版本不支持远程 MCP 传输或自定义 Server 环境变量。

MCP Server 是在本机运行的程序，只应添加信任的 Server。Agent 发起工具调用后会先展示 Server、工具名和参数，用户确认后才会真正调用。

## 飞书机器人（可选）

```bash
cp config/feishu.example.json config/feishu.local.json
# 编辑 feishu.local.json，填入 App ID 和 App Secret
```

在飞书开发者后台完成以下配置：

1. 创建「企业自建应用」并添加机器人能力。
2. 添加发送与接收消息所需权限；如后台提供细分权限，选择私聊接收、群聊接收和消息发送。
3. 事件订阅选择「使用长连接收事件」，订阅 `im.message.receive_v1`。
4. 创建版本并发布应用，然后私聊机器人或将其加入群聊。

重启应用后，终端出现「飞书机器人已启动（长连接模式）」即表示连接成功。

### 飞书定时任务

在飞书会话中直接说，例如：「每个工作日早上 9 点，把今天日报发到这个群」。

- Agent 会解析时间、重复方式和任务内容，信息不全时会追问。
- 任务持久化后可在桌面端「已安排」页继续新增、修改或删除。
- 到点后会生成当次应发送的内容并回复到创建任务的飞书会话。
- 调度器会先推进下次执行时间再执行当次任务，避免同一时间重复回复。

## 数据与安全边界

- 模型和飞书密钥只从本机 `config/*.local.json` 读取，不经过 renderer，也不写入会话存档。
- 会话、定时任务、长期记忆、MCP 配置和用户 Skills 都保存在 Electron `userData` 目录。
- renderer 只能通过 `contextBridge` 暴露的最小 IPC 接口访问主进程能力。
- 命令执行和 MCP 工具调用都需要用户确认，敏感参数和高风险命令会被额外拦截。
- 飞书渠道不使用桌面端的私人长期记忆、命令执行或 MCP 工具。

## 架构

```text
React 桌面界面 / 飞书渠道
              │
              ▼
     ChuangdexAgentService
       │      │      │
       │      │      └─ Skills / 记忆
       │      └─ 命令 / MCP 工具
       └─ ModelProvider
              │
              ▼
       自定义兼容模型服务
```

`ChuangdexAgentService` 是与 Electron 界面解耦的内核入口，只依赖 `ModelProvider` 抽象。要添加新的模型协议，可在 `src/agent/providers/` 实现新 Provider，再在主进程装配，无需改动 Agent 服务或 renderer。

## 开发与验证

```bash
npm run dev          # 开发模式，支持热更新
npm run typecheck    # TypeScript 类型检查
npm run test:memory  # 桌面滚动摘要与飞书固定窗口回归测试
npm run test:mcp     # MCP 连接与 Agent 调用 smoke test
npm run test:review  # MCP 生命周期与记忆边界回归测试
npm run build        # 生成生产构建到 out/
npm start            # 预览已生成的构建
```

## 目录结构

```text
config/
  models.example.json       # 模型服务配置示例
  feishu.example.json       # 飞书机器人配置示例
skills/
  daily-briefing/SKILL.md   # 内置 Skill 示例
examples/mcp/
  echo-server.mjs           # 本地 MCP 演示 Server
src/
  agent/
    service.ts              # Agent 内核入口
    providers/              # ModelProvider 抽象与当前 Provider
    skills/                 # Skill 加载、选择与安装
    memory/                 # 会话短期记忆与长期记忆
    tools/command.ts        # 受控命令执行器
    mcp/                    # 本地 MCP 配置、连接与工具调用
  channels/                 # 飞书渠道与定时调度
  main/                     # Electron 主进程、配置与会话存储
  preload/                  # contextBridge 安全桥
  renderer/                 # React 界面
  shared/agent.ts           # 共享类型与 IPC 通道
scripts/                    # smoke test 与回归测试
```

## 技术栈

- Electron 33
- React 18
- TypeScript
- electron-vite / Vite
- Model Context Protocol SDK
- Lark OpenAPI SDK
