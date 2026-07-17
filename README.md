# ChuangDex

我们自己的 Agent 桌面客户端 + 飞书机器人。当前进度：可观察的 Agent 工作台（时间线 + 折叠执行卡片 + 可收起执行侧栏）+ Agent 内核 + Kimi + Skills + 会话管理 + 持久化 + 多轮对话 + 飞书渠道 + 飞书定时任务。

## 配置 Kimi（必填）

```bash
cp config/models.example.json config/models.local.json
# 编辑 models.local.json，填入你的 API Key、Endpoint 和模型名
```

`config/models.local.json` 已被 .gitignore 忽略，不会提交。未配置时发消息会在右侧看到「准备调用模型 → 失败」记录和提示。

## 配置飞书机器人（可选）

```bash
cp config/feishu.example.json config/feishu.local.json
# 编辑 feishu.local.json，填入飞书应用的 App ID 和 App Secret
```

飞书开发者后台（open.feishu.cn）最少手动配置：

1. 创建「企业自建应用」，添加应用能力：**机器人**
2. 权限：添加 `im:message`（发送与接收消息；若后台提供细化权限，选 `im:message.p2p_msg` 私聊接收 + `im:message.group_msg` 群聊接收 + `im:message` 发送）
3. 事件订阅：订阅方式选「**使用长连接接收事件**」，添加事件「接收消息 im.message.receive_v1」
4. 创建版本并发布（企业自建应用一般管理员直接通过），然后私聊机器人或把它拉进群

配置后重启 `npm run dev`，日志出现「飞书机器人已启动（长连接模式）」即可在飞书里对话。

## 飞书定时任务

在飞书里直接说，例如「每个工作日早上 9 点，把今天日报发到这个群」：

- Kimi 解析意图（时间 HH:MM + 每天/每个工作日 + 任务内容），信息不全则反问补充
- 任务持久化在 userData 目录 `scheduled-tasks.json`，重启自动恢复
- 到点唤醒 Agent 服务执行（定时任务模式：模型被告知“任务已创建、现在到点”，只生成此刻应发的内容；Skills 照常生效）
- “先推进后执行”：同一时间的任务绝不重复回复；终端可见创建/执行/下次时间日志

## 消息链路

```
React 对话区
  │  window.chuangdex.agent.sendMessage()   （preload 安全桥，contextBridge）
  ▼
Electron 主进程  ipcMain.handle('agent:send-message')
  │  交给
  ▼
ChuangdexAgentService  src/agent/service.ts   ← Agent 内核入口
  │  ① 发现 Skills（启动时扫描 skills/ 目录）
  │  ② 选择 Skill（触发关键词匹配，由服务决定，界面不参与）
  │  ③ 命中时把 Skill 工作说明注入系统提示词
  │  ④ 调用 ModelProvider 接口（当前实现：src/agent/providers/kimi.ts）
  │  处理中逐条发射运行记录 → webContents.send('agent:run-event') → 右侧面板实时显示
  │  最终回复作为 invoke 的返回值 → 对话区显示
  ▼
界面
```

接入其他模型厂商时：在 `src/agent/providers/` 下新增一个实现 `ModelProvider` 接口的类，并在主进程 `setupAgent()` 中装配。

## Skills

Skill 不是模型，而是一套可复用的工作方法。每个 Skill 是 `skills/` 下的一个目录，内含 `SKILL.md`：

- frontmatter：`name`（名称）、`description`（用途）、`triggers`（触发关键词）
- 正文：工作说明，命中时注入系统提示词，指导模型完成这类任务

新增 Skill：只需新建 `skills/<名称>/SKILL.md`，重启即被自动发现，无需改代码。

## 会话管理

- 左栏「＋」新建空会话并立即切换；默认名“新对话”，重名自动加数字
- 悬停会话出现「×」删除入口，弹窗确认后删除
- 删除当前会话后自动切到相邻会话；删光后自动新建空会话
- 对话区标题旁「✎」手动重命名；手动标题永不被自动命名覆盖（renamed 标记）
- 新会话发出第一条消息后，Agent 服务独立调用 Kimi 自动生成标题；失败则保留“新对话”，不影响对话
- 会话数据持久化在 userData 目录（macOS `~/Library/Application Support/chuangdex/sessions.json`，Windows `%APPDATA%/chuangdex/sessions.json`），重启自动恢复上次会话与激活项
- 存档缺失或损坏时安全回退到演示会话；存档不含 API Key 等任何模型配置
- 多轮对话：发送时带上当前会话最近 12 条历史消息（仅角色+内容），按时间顺序发给模型；不同会话的上下文互相隔离

## 技术栈

- Electron 33（跨 macOS / Windows）
- React 18 + TypeScript
- electron-vite（开发热更新 + 构建）

## 启动

```bash
cd chuangdex
npm install        # 首次
npm run dev        # 开发模式（推荐，带热更新）
```

其他命令：

```bash
npm run build      # 构建到 out/
npm start          # 预览构建产物
npm run typecheck  # TypeScript 类型检查
```

> 如果 Electron 二进制下载缓慢：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 目录结构

```
config/
  models.example.json  # Kimi 配置示例（不含真实密钥）
  models.local.json    # 你的 Kimi 配置（Git 忽略，需自己创建）
  feishu.example.json  # 飞书机器人配置示例（不含真实密钥）
  feishu.local.json    # 你的飞书配置（Git 忽略，需自己创建）
skills/
  daily-briefing/
    SKILL.md           # 第一个 Skill：结构化日报/简报
src/
  agent/service.ts     # ★ Agent 内核入口（与 Electron 解耦）
  agent/providers/
    types.ts           # ModelProvider 接口（厂商抽象层）
    kimi.ts            # Kimi（Moonshot）实现
  agent/skills/
    types.ts           # Skill 的最小组成
    loader.ts          # Skill 发现（扫描 skills/ 目录）
    matcher.ts         # Skill 选择（触发关键词匹配）
  channels/
    feishu-channel.ts  # 飞书渠道层（纯逻辑：过滤/去重/会话隔离；事件立即返回，后台执行）
    feishu.ts          # 飞书长连接接线（唯一接触飞书 SDK 的地方）
    scheduler.ts       # 周期定时任务引擎（每天/工作日；先推进后执行，绝不重复回复）
  shared/agent.ts      # 两端共享的类型与 IPC 通道名
  main/index.ts        # Electron 主进程：窗口 + IPC + 装配 Skills/模型/飞书
  main/model-config.ts # Kimi 配置加载器
  main/feishu-config.ts# 飞书配置加载器
  main/session-store.ts# 会话持久化（userData/sessions.json）
  preload/index.ts     # 安全桥（contextBridge）
  renderer/
    index.html
    src/
      App.tsx          # 三栏布局 + 交互逻辑
      mock.ts          # 假数据（会话 / 消息 / 运行记录）
      styles.css       # 深色主题
```

## 界面

- 左栏：会话列表（新建/删除/改名/持久化），处理中的会话有低调的状态点
- 中栏：时间线对话区；每轮任务的运行记录收进默认折叠的「执行过程」卡片，运行中有克制的动效提示
- 右栏：可一键收起的「本次执行」侧栏；区块可分别展开/收起；只展示真实数据（进度、步骤、后台记录），没有数据时明确写“暂无”
- 界面分组只靠一个轻量标记 `turnId`：同一轮的消息与运行记录共享它，自动命名等后台记录不带，自然分开
