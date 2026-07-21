// 桌面端受控命令执行器。
// 命令只会在用户确认后由 Agent 服务调用；本模块负责固定工作目录、
// 清理环境变量、限制输出与执行时间，不接触 React 或飞书渠道。

import { spawn } from 'child_process'
import { mkdirSync } from 'fs'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_COMMAND_CHARS = 2_000
const MAX_STREAM_BYTES = 32 * 1024

export interface CommandExecutionResult {
  command: string
  cwd: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
}

export type CommandRisk = 'normal' | 'high'

export class CommandRunner {
  constructor(
    readonly workspaceDir: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {}

  validate(command: string): string | null {
    const trimmed = command.trim()
    if (!trimmed) return '命令不能为空'
    if (trimmed.length > MAX_COMMAND_CHARS) return `命令不能超过 ${MAX_COMMAND_CHARS} 个字符`
    if (trimmed.includes('\0')) return '命令包含无效字符'
    if (targetsSensitiveData(trimmed)) {
      return '安全限制：命令不能读取应用密钥、本机凭据或完整环境变量'
    }
    return null
  }

  risk(command: string): CommandRisk {
    return isPotentiallyDestructive(command) ? 'high' : 'normal'
  }

  async run(command: string): Promise<CommandExecutionResult> {
    const trimmed = command.trim()
    const invalidReason = this.validate(trimmed)
    if (invalidReason) throw new Error(invalidReason)

    mkdirSync(this.workspaceDir, { recursive: true })
    const shell = shellCommand(trimmed)
    const startedAt = Date.now()

    return new Promise((resolve, reject) => {
      const child = spawn(shell.executable, shell.args, {
        cwd: this.workspaceDir,
        env: safeEnvironment(),
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const stdout = createOutputCollector()
      const stderr = createOutputCollector()
      let timedOut = false
      let settled = false
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null

      child.stdout?.on('data', (chunk: Buffer | string) => stdout.append(chunk))
      child.stderr?.on('data', (chunk: Buffer | string) => stderr.append(chunk))

      const timer = setTimeout(() => {
        timedOut = true
        terminateChild(child.pid, 'SIGTERM')
        forceKillTimer = setTimeout(() => terminateChild(child.pid, 'SIGKILL'), 1_000)
      }, this.timeoutMs)

      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        reject(new Error(`无法启动命令：${error.message}`))
      })

      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        resolve({
          command: trimmed,
          cwd: this.workspaceDir,
          exitCode: code,
          stdout: cleanOutput(stdout.text()),
          stderr: cleanOutput(stderr.text()),
          timedOut,
          truncated: stdout.truncated() || stderr.truncated(),
          durationMs: Date.now() - startedAt
        })
      })
    })
  }
}

function shellCommand(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      executable: process.env.ComSpec || 'powershell.exe',
      args: process.env.ComSpec
        ? ['/d', '/s', '/c', command]
        : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    }
  }
  return {
    executable: process.env.SHELL || '/bin/sh',
    args: ['-lc', command]
  }
}

/** 只把命令运行所需的普通系统变量传入子进程，不继承 API Key 等应用环境。 */
function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'PATHEXT',
    'ComSpec'
  ]
  const result: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  result.NO_COLOR = '1'
  result.CI = '1'
  return result
}

function createOutputCollector(): {
  append: (chunk: Buffer | string) => void
  text: () => string
  truncated: () => boolean
} {
  const chunks: Buffer[] = []
  let size = 0
  let didTruncate = false
  return {
    append(chunk) {
      if (size >= MAX_STREAM_BYTES) {
        didTruncate = true
        return
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = MAX_STREAM_BYTES - size
      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining))
        size += remaining
        didTruncate = true
        return
      }
      chunks.push(buffer)
      size += buffer.length
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => didTruncate
  }
}

function cleanOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .trimEnd()
}

function terminateChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal)
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // 进程可能已自行退出。
    }
  }
}

function targetsSensitiveData(command: string): boolean {
  const normalized = command.toLowerCase()
  const sensitivePatterns = [
    /models\.local\.json/,
    /feishu\.local\.json/,
    /(^|[\s/])\.env([\s/]|$)/,
    /(^|[;&|\s])(env|printenv)([;&|\s]|$)/,
    /process\.env/,
    /\/proc\/[^\s/]+\/environ/,
    /\.ssh\/(id_[a-z0-9_-]+|config)/,
    /\.aws\/credentials/,
    /\.npmrc/,
    /\.netrc/,
    /security\s+find-(generic|internet)-password/
  ]
  return sensitivePatterns.some((pattern) => pattern.test(normalized))
}

function isPotentiallyDestructive(command: string): boolean {
  const normalized = command.toLowerCase()
  const patterns = [
    /(^|[;&|]\s*|\s)(sudo|su)(\s|$)/,
    /(^|[;&|]\s*|\s)rm\s+[^\n]*(?:-r|-f|--recursive|--force)/,
    /(^|[;&|]\s*|\s)(shutdown|reboot|halt|poweroff)(\s|$)/,
    /(^|[;&|]\s*|\s)(mkfs|diskutil|fdisk|format)(\s|$)/,
    /git\s+(reset\s+--hard|clean\s+-[^\s]*f)/,
    /(^|[;&|]\s*|\s)(chmod|chown)\s+-r(\s|$)/,
    /(^|[;&|]\s*|\s)(killall|pkill)(\s|$)/,
    /(curl|wget)[^\n|]*\|\s*(sh|bash|zsh|powershell)/
  ]
  return patterns.some((pattern) => pattern.test(normalized))
}
