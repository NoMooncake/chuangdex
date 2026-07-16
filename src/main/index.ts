import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { ChuangdexAgentService } from '../agent/service'
import { KimiProvider } from '../agent/providers/kimi'
import { loadSkills } from '../agent/skills/loader'
import { AGENT_CHANNELS, AgentSendPayload, SESSION_CHANNELS, SessionsSavePayload } from '../shared/agent'
import { loadKimiConfig, modelsConfigPath } from './model-config'
import { feishuConfigPath, loadFeishuConfig } from './feishu-config'
import { startFeishuBot } from '../channels/feishu'
import { loadPersistedSessions, scheduleSaveSessions, sessionsFilePath } from './session-store'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// 飞书长连接和本机调度器都只能由一个 ChuangDex 进程持有。
// 否则两个实例会同时恢复同一份 scheduled-tasks.json，造成重复执行/重复回复。
const hasSingleInstanceLock = app.requestSingleInstanceLock()

// ChuangDex Agent 内核：本地模块常驻主进程，启动时装配模型 provider
let agentService: ChuangdexAgentService

function setupAgent(): void {
  const kimiConfig = loadKimiConfig(app.getAppPath())
  const skills = loadSkills(join(app.getAppPath(), 'skills'))
  agentService = new ChuangdexAgentService(new KimiProvider(kimiConfig), skills)

  if (kimiConfig) {
    console.log(`[chuangdex] Kimi 配置已加载：${kimiConfig.baseUrl} · ${kimiConfig.model}`)
  } else {
    console.warn(`[chuangdex] 未找到 Kimi 配置，请创建 ${modelsConfigPath(app.getAppPath())}`)
  }
  console.log(
    skills.length > 0
      ? `[chuangdex] 发现 ${skills.length} 个 Skill：${skills.map((s) => s.name).join('、')}`
      : '[chuangdex] 未发现 Skill（skills/ 目录为空或不存在）'
  )
}

function registerAgentIpc(): void {
  // 渲染进程通过 ipcRenderer.invoke 调用；处理过程中的每条运行记录
  // 都通过 webContents.send 实时推回对应的渲染进程。
  ipcMain.handle(AGENT_CHANNELS.sendMessage, async (event, payload: AgentSendPayload) => {
    return agentService.handleMessage(payload, (run) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AGENT_CHANNELS.runEvent, run)
      }
    })
  })

  // 自动命名：与聊天回复完全独立的第二次模型调用，运行记录走同一通道回流
  ipcMain.handle(AGENT_CHANNELS.generateTitle, async (event, payload: AgentSendPayload) => {
    return agentService.generateTitle(payload, (run) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AGENT_CHANNELS.runEvent, run)
      }
    })
  })

  // 会话持久化：读取启动存档 / 接收界面状态并落盘（主进程独占文件读写）
  ipcMain.handle(SESSION_CHANNELS.load, () => {
    const result = loadPersistedSessions()
    console.log(
      result
        ? `[chuangdex] 已从 ${sessionsFilePath()} 恢复 ${result.sessions.length} 个会话`
        : `[chuangdex] 无可用会话存档（${sessionsFilePath()}），使用初始演示会话`
    )
    return result
  })

  ipcMain.handle(SESSION_CHANNELS.save, (_event, payload: SessionsSavePayload) => {
    scheduleSaveSessions(payload)
  })
}

// 飞书机器人渠道：配置存在才启动；任何失败只记日志，不影响桌面端
function setupFeishu(): void {
  const config = loadFeishuConfig(app.getAppPath())
  if (!config) {
    console.warn(
      `[chuangdex] 未找到飞书配置（${feishuConfigPath(app.getAppPath())}），` +
        '飞书机器人未启动。请参照 config/feishu.example.json 填写 App ID 和 App Secret'
    )
    return
  }
  try {
    startFeishuBot(config, agentService, join(app.getPath('userData'), 'scheduled-tasks.json'))
    console.log('[chuangdex] 飞书机器人已启动（长连接模式），等待消息…')
  } catch (err) {
    console.error('[chuangdex] 飞书机器人启动失败（不影响桌面端）：', err)
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 960,
    minHeight: 600,
    title: 'ChuangDex',
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Open external links in the system browser, not in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL as string)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    setupAgent()
    registerAgentIpc()
    setupFeishu()
    createWindow()

    app.on('activate', () => {
      // macOS: re-create window when the dock icon is clicked.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Windows/Linux: quit when all windows are closed.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
