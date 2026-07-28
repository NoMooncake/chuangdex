// ─────────────────────────────────────────────────────────────
// Skill 安装来源发现与确认
//
// 状态机：
//   classify_input（GitHub URL / owner/repo / 纯 Skill 名称）
//   → discover（联网搜索：GitHub 优先，其次官网，最后市场/安装文档）
//   → verify（GitHub 确定性验证：仓库公开、SKILL.md 有效、名称匹配）
//   → propose（生成待确认提案，等待“确认安装 / 取消安装”）
//   → install（复用 installer.ts 的安全安装器，由 service.ts 调用）
//
// 安全边界：
// · 搜索结果是不可信外部内容——只作为发现候选的线索，
//   不作为安装授权，其中的任何指令都不会被执行。
// · 只有用户亲自提供的 GitHub URL 才能直接进入安装流程；
//   搜索发现的候选必须经过 GitHub 验证 + 用户明确确认。
// ─────────────────────────────────────────────────────────────

import {
  canonicalRepoKey,
  extractGitHubUrls,
  parseGitHubRepo,
  probeSkillArchive,
  type ParsedRepo,
  type SkillArchiveProbeResult
} from './installer'
import { parseSkillFile } from './loader'
import type { Skill } from './types'
import type {
  SkillDiscoveryCandidate,
  SkillDiscoverySearcher
} from '../providers/types'

export class SkillDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillDiscoveryError'
  }
}

/** GitHub API 限流/拒绝（403、429）：触发受限 archive 降级验证。 */
export class GithubRateLimitedError extends SkillDiscoveryError {
  constructor(message: string) {
    super(message)
    this.name = 'GithubRateLimitedError'
  }
}

/** GitHub 目录树被截断：不能据此断言仓库没有 SKILL.md，触发 archive 降级。 */
export class GithubTreeTruncatedError extends SkillDiscoveryError {
  constructor(message: string) {
    super(message)
    this.name = 'GithubTreeTruncatedError'
  }
}

// ── 1. 输入分类 ─────────────────────────────────────────────

export type SkillInstallInput =
  | { kind: 'github_url'; url: string; repo: ParsedRepo }
  | { kind: 'github_repo'; url: string; repo: ParsedRepo }
  | { kind: 'skill_name'; skillName: string }
  | { kind: 'unsupported' }

/** 明显的否定/取消语境不算安装意图。 */
const NEGATIVE_INSTALL = /(不要|不用|别|无需|不需要|禁止|取消)[^。！？!?\n]{0,15}(安装|install)/i

/**
 * 询问、评估、安全咨询、安装教程等语境：即使包含“安装”和 GitHub URL，
 * 也永远不是安装指令，只能进入普通问答。
 */
const QUESTION_OR_REVIEW_PATTERNS: RegExp[] = [
  // 怎么 / 如何 / 怎样 … 安装（安装教程类提问）
  /(?:怎么|怎样|如何)[^。！？!?\n]{0,15}(?:安装|install)/i,
  // 安装 … 安全吗 / 可靠吗 / 有风险（安全评估咨询）
  /(?:安装|install)[^。！？!?\n]{0,40}(?:安全吗|可靠吗|靠谱吗|有风险|会不会)/i,
  // 可以 / 能不能 / 能否 / 要不要 … 安装（征求意见）
  /(?:可以|能不能|能否|可不可以|要不要|该不该)[^。！？!?\n]{0,10}(?:安装|install)/i,
  // 了解 / 介绍 / 学习 … 安装（了解安装方式）
  /(?:了解|知道|学习|介绍|讲讲|说说|看看|解释一下)[^。！？!?\n]{0,12}(?:安装|install)/i,
  // 安装方式 / 方法 / 教程 / 步骤 / 流程 / 指南 / 文档
  /(?:安装|install)(?:方式|方法|教程|步骤|流程|指南|文档)/i,
  // 疑问句结尾
  /[?？]\s*$/,
  /(?:吗|么|呢)\s*$/
]

/**
 * 明确动作指令（祈使句）：
 * · “找 X 并安装 / 找到 X 再安装”
 * · 句首（或句界后）的“（请/帮我/我要…）安装 <目标>”
 * 目标必须以 ASCII 标识符或 URL 字符开头，因此“怎么安装”“安装方式”不会命中。
 */
const COMMAND_PATTERNS: RegExp[] = [
  /(?:找一下|帮我找|帮忙找|找找看|找到|搜索一下?)[^\n]{0,100}?(?:并|再|然后)\s*(?:安装|install)/i,
  /(?:^|[。！？!?\n,，;；]\s*)(?:请|帮我|给我|我要|我想|麻烦你?|帮忙|现在)?\s*(?:安装|装一下|装上|install)\s*[「『"“”'`]?\s*[a-zA-Z0-9/:.-]/i
]

/**
 * 保守的安装意图判断：
 * 先排除否定与一切询问/评估/咨询语境，再要求命中明确的祈使句指令。
 * 绝不再使用“只要包含安装二字就算安装意图”。
 */
export function hasSkillInstallIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (NEGATIVE_INSTALL.test(trimmed)) return false
  if (QUESTION_OR_REVIEW_PATTERNS.some((pattern) => pattern.test(trimmed))) return false
  return COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * 提取安装目标名称。只接受 ASCII 标识符（字母/数字/-/_ 以及 owner/repo 的 /），
 * 因此“怎么安装依赖”“安装一下”这类普通句子不会误提取出目标。
 */
const NAME_PATTERNS: RegExp[] = [
  /(?:找一下|帮我找|帮忙找|找找看|找到|搜索一下?)\s*[「『"“”'`]?\s*([a-zA-Z0-9][a-zA-Z0-9_/.-]{0,80})\s*[」』"“”'`]?\s*(?:(?:这个|款|个)\s*)?(?:skill|技能)?\s*(?:并|再|然后)\s*安装/i,
  /(?:安装|帮我安装|给我安装|装一下|帮我装|install)\s*[「『"“”'`]?\s*([a-zA-Z0-9][a-zA-Z0-9_/.-]{0,80})\s*[」』"“”'`]?\s*(?:(?:这个|款|个)\s*)?(?:skill|技能)?\s*[。！!？?]?$/i
]

export function extractInstallTargetName(text: string): string | null {
  for (const pattern of NAME_PATTERNS) {
    const match = pattern.exec(text)
    if (match?.[1]) return match[1]
  }
  return null
}

/** 把 `owner/repo`（可带 .git 后缀）规范化为仓库描述；不合法返回 null。 */
export function normalizeOwnerRepo(input: string): ParsedRepo | null {
  const cleaned = input.trim().replace(/\.git$/i, '')
  const match = /^([a-zA-Z0-9_.-]{1,100})\/([a-zA-Z0-9_.-]{1,100})$/.exec(cleaned)
  if (!match) return null
  const [, owner, repo] = match
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return { owner, repo }
}

/**
 * 分类一条安装请求。
 * 返回 null 表示这不是一条需要确定性路由的安装请求（交给普通模型对话）。
 */
export function classifySkillInstallInput(text: string): SkillInstallInput | null {
  const trimmed = text.trim()
  if (!hasSkillInstallIntent(trimmed)) return null

  // 用户亲自提供的完整 GitHub URL：优先级最高。
  const url = extractGitHubUrls(trimmed)[0]
  if (url) {
    const repo = parseGitHubRepo(url)
    if (repo) return { kind: 'github_url', url, repo }
  }

  const target = extractInstallTargetName(trimmed)
  if (!target) return { kind: 'unsupported' }

  // owner/repo：必须形如 a/b 且两部分都是合法 GitHub 名称；纯 Skill 名称不含 /。
  if (target.includes('/')) {
    const repo = normalizeOwnerRepo(target)
    if (!repo) return { kind: 'unsupported' }
    return { kind: 'github_repo', url: `https://github.com/${repo.owner}/${repo.repo}`, repo }
  }

  return { kind: 'skill_name', skillName: target }
}

// ── 2. GitHub 验证探针（可注入，测试不依赖真实网络）────────

export interface SkillTreeListing {
  /** 仓库中包含 SKILL.md 的目录（'' 表示仓库根目录），升序。 */
  dirs: string[]
  /** 分支当前快照 SHA，用于证据展示。 */
  sha: string
  /** GitHub 返回的目录树是否被截断（截断时不能断言没有 SKILL.md）。 */
  truncated: boolean
}

export interface GithubSkillProbe {
  /** 仓库是否存在且公开可访问。 */
  repoExists(owner: string, repo: string): Promise<boolean>
  /** 列出分支上所有 SKILL.md 所在目录。 */
  listSkillDirs(owner: string, repo: string, ref?: string): Promise<SkillTreeListing>
  /** 读取指定目录的 SKILL.md 文本（不存在返回 null；非 UTF-8 抛错）。 */
  fetchSkillMarkdown(owner: string, repo: string, ref: string | undefined, path: string): Promise<string | null>
  /**
   * 受限 archive 降级验证：下载一次源码压缩包（带大小限制），
   * 列出 SKILL.md 目录并读取内容。API 限流/树截断时使用。
   */
  probeArchive(owner: string, repo: string, ref?: string): Promise<SkillArchiveProbeResult>
}

const PROBE_TIMEOUT_MS = 20_000
const MAX_TREE_BYTES = 4 * 1024 * 1024
const MAX_MARKDOWN_BYTES = 256 * 1024

const GH_API_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}

export class HttpGithubSkillProbe implements GithubSkillProbe {
  // 包装一层调用，保证测试在构造之后替换 globalThis.fetch 仍然生效。
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async repoExists(owner: string, repo: string): Promise<boolean> {
    const res = await this.request(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    )
    if (res.status === 404) return false
    throwIfRateLimited(res)
    if (!res.ok) throw new SkillDiscoveryError(`GitHub 仓库检查失败（HTTP ${res.status}）`)
    return true
  }

  async listSkillDirs(owner: string, repo: string, ref?: string): Promise<SkillTreeListing> {
    const res = await this.request(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/git/trees/${encodeURIComponent(ref ?? 'HEAD')}?recursive=1`
    )
    if (res.status === 404) throw new SkillDiscoveryError('GitHub 仓库或分支不存在')
    throwIfRateLimited(res)
    if (!res.ok) throw new SkillDiscoveryError(`GitHub 目录检查失败（HTTP ${res.status}）`)

    const body = await readLimited(res, MAX_TREE_BYTES, 'GitHub 分支信息超过 4 MB，停止验证')
    let data: { sha?: unknown; tree?: unknown; truncated?: unknown }
    try {
      data = JSON.parse(new TextDecoder().decode(body)) as { sha?: unknown; tree?: unknown; truncated?: unknown }
    } catch {
      throw new SkillDiscoveryError('GitHub 返回的分支信息无效')
    }
    if (data.truncated === true) {
      // 目录树不完整，不能据此断言仓库没有 SKILL.md。
      throw new GithubTreeTruncatedError('GitHub 目录树过大被截断')
    }

    const dirs = new Set<string>()
    const tree = Array.isArray(data.tree) ? data.tree : []
    for (const entry of tree) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as { path?: unknown; type?: unknown }
      if (record.type !== 'blob' || typeof record.path !== 'string') continue
      if (!/(^|\/)skill\.md$/i.test(record.path)) continue
      dirs.add(record.path.slice(0, record.path.length - 'SKILL.md'.length).replace(/\/$/, ''))
    }
    return {
      dirs: [...dirs].sort(),
      sha: typeof data.sha === 'string' ? data.sha : '',
      truncated: false
    }
  }

  async fetchSkillMarkdown(
    owner: string,
    repo: string,
    ref: string | undefined,
    path: string
  ): Promise<string | null> {
    const relative = path ? `${path}/SKILL.md` : 'SKILL.md'
    const encodedPath = relative.split('/').map(encodeURIComponent).join('/')
    const res = await this.request(
      `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/${encodeURIComponent(ref ?? 'HEAD')}/${encodedPath}`
    )
    if (res.status === 404) return null
    throwIfRateLimited(res)
    if (!res.ok) throw new SkillDiscoveryError(`SKILL.md 读取失败（HTTP ${res.status}）`)
    const body = await readLimited(res, MAX_MARKDOWN_BYTES, 'SKILL.md 超过 256 KB，停止验证')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      throw new SkillDiscoveryError('SKILL.md 不是有效的 UTF-8 文本')
    }
  }

  /**
   * 降级验证：复用 installer 的受限 archive 下载（30MB/100MB 限制、路径与符号链接检查）。
   * 不伪造客户端身份，不需要任何 Token。
   */
  async probeArchive(owner: string, repo: string, ref?: string): Promise<SkillArchiveProbeResult> {
    return probeSkillArchive(owner, repo, ref)
  }

  private async request(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      return await this.fetchImpl(url, { headers: GH_API_HEADERS, signal: controller.signal })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SkillDiscoveryError('GitHub 验证请求超时，请检查网络后重试')
      }
      throw new SkillDiscoveryError('无法连接 GitHub，请检查网络后重试')
    } finally {
      clearTimeout(timer)
    }
  }
}

/** GitHub 响应为 403/429 时抛出限流错误，触发 archive 降级；消息包含剩余额度信息。 */
function throwIfRateLimited(res: Response): void {
  if (res.status !== 403 && res.status !== 429) return
  const remaining = res.headers.get('x-ratelimit-remaining')
  const detail = remaining !== null ? `，剩余额度 ${remaining}` : ''
  throw new GithubRateLimitedError(`GitHub API 限流（HTTP ${res.status}${detail}）`)
}

async function readLimited(res: Response, limit: number, tooBigMessage: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new SkillDiscoveryError(tooBigMessage)
  if (!res.body) throw new SkillDiscoveryError('GitHub 验证响应为空')
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new SkillDiscoveryError(tooBigMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

// ── 3. 候选验证 ─────────────────────────────────────────────

export interface VerifiedSkillCandidate {
  url: string
  repo: ParsedRepo
  canonicalKey: string
  skill: Skill
  /** 搜索模型给出的匹配理由（不可信，仅展示） */
  why: string
  /** 发现该候选的来源页面 */
  sourceUrl?: string
  /** 用户可见的确定性验证证据 */
  evidence: string[]
  confidence: 'high' | 'medium'
}

export type CandidateVerification =
  | { state: 'verified'; candidate: VerifiedSkillCandidate }
  | { state: 'rejected'; url: string; reason: string }
  | { state: 'ambiguous'; url: string; repo: ParsedRepo; dirs: string[] }

/** 按用户指定路径与 SKILL.md 目录列表确定唯一验证目标；多 Skill 仓库不猜测。 */
type ResolvedSkillPath =
  | { path: string | undefined }
  | { ambiguousDirs: string[] }
  | { reason: string }

function resolveSkillPath(requestedPath: string | undefined, dirs: string[]): ResolvedSkillPath {
  if (requestedPath !== undefined) {
    if (!dirs.includes(requestedPath)) {
      return { reason: `指定目录「${requestedPath || '根目录'}」根部没有 SKILL.md` }
    }
    return { path: requestedPath }
  }
  if (dirs.length === 0) return { reason: '仓库中没有找到 SKILL.md' }
  if (dirs.length > 1) return { ambiguousDirs: dirs }
  return { path: dirs[0] || undefined }
}

// ── 4. 待确认安装提案 ────────────────────────────────────────

export interface PendingSkillInstall {
  sessionId: string
  /** 用户最初输入的名称 */
  requestedName: string
  /** 经验证 SKILL.md 中的真实名称与描述 */
  skillName: string
  skillDescription: string
  url: string
  repo: ParsedRepo
  canonicalKey: string
  ref?: string
  path?: string
  sourceUrl?: string
  evidence: string[]
  createdAt: number
  expiresAt: number
}

export const DEFAULT_PENDING_INSTALL_TTL_MS = 15 * 60 * 1000

/** 会话级待确认安装提案；过期自动失效，确认后一次性取出。 */
export class PendingSkillInstallManager {
  private readonly pending = new Map<string, PendingSkillInstall>()

  constructor(readonly ttlMs: number = DEFAULT_PENDING_INSTALL_TTL_MS) {}

  create(input: Omit<PendingSkillInstall, 'createdAt' | 'expiresAt'>): PendingSkillInstall {
    const now = Date.now()
    const pending: PendingSkillInstall = { ...input, createdAt: now, expiresAt: now + this.ttlMs }
    this.pending.set(input.sessionId, pending)
    return pending
  }

  /** 低层写入（测试注入过期提案时使用）。 */
  set(pending: PendingSkillInstall): void {
    this.pending.set(pending.sessionId, pending)
  }

  /** 读取有效提案；过期即删除并返回 null。 */
  getValid(sessionId: string): PendingSkillInstall | null {
    const pending = this.pending.get(sessionId)
    if (!pending) return null
    if (Date.now() > pending.expiresAt) {
      this.pending.delete(sessionId)
      return null
    }
    return pending
  }

  /** 取出并删除（确认安装时使用，保证一次性）。 */
  take(sessionId: string): PendingSkillInstall | null {
    const pending = this.getValid(sessionId)
    if (pending) this.pending.delete(sessionId)
    return pending
  }

  cancel(sessionId: string): boolean {
    return this.pending.delete(sessionId)
  }
}

// ── 5. 发现编排 ─────────────────────────────────────────────

export type DiscoveryReport = (
  title: string,
  detail: string,
  status: 'running' | 'success' | 'failed'
) => void

export type SkillDiscoveryOutcome =
  | { kind: 'proposal'; candidate: VerifiedSkillCandidate }
  | { kind: 'multiple'; candidates: VerifiedSkillCandidate[] }
  | { kind: 'ambiguous'; url: string; repo: ParsedRepo; dirs: string[] }
  | { kind: 'marketplace_instructions'; url: string; note: string; searched: string[] }
  | { kind: 'none'; searched: string[]; rejected: { url: string; reason: string }[] }
  | { kind: 'error'; reason: string }

const MAX_CANDIDATES = 5

export class SkillDiscoveryService {
  constructor(
    private readonly searcher: SkillDiscoverySearcher | null,
    private readonly probe: GithubSkillProbe = new HttpGithubSkillProbe()
  ) {}

  isSearchAvailable(): boolean {
    return this.searcher !== null && this.searcher.isConfigured()
  }

  /**
   * 为一个纯 Skill 名称寻找可安装来源。
   * 任何阶段失败都不会退化为猜测；找不到就明确告诉调用方找不到。
   */
  async discover(skillName: string, report: DiscoveryReport): Promise<SkillDiscoveryOutcome> {
    if (!this.searcher || !this.isSearchAvailable()) {
      return { kind: 'error', reason: '联网搜索未配置' }
    }

    report(
      '正在搜索公开来源',
      `「${skillName}」· 优先 GitHub 仓库，其次官网与市场/安装文档`,
      'running'
    )
    let searchResult
    try {
      searchResult = await this.searcher.searchSkillSources({ skillName })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      report('联网搜索失败', reason, 'failed')
      return { kind: 'error', reason }
    }
    const searched =
      searchResult.searched.length > 0
        ? searchResult.searched
        : ['公开 GitHub 仓库', '官方网站', 'Skill 市场与安装文档']
    report(
      '搜索完成',
      `方向：${searched.join('；')} · 候选 ${searchResult.candidates.length} 个`,
      'success'
    )

    // 只允许 GitHub 地址进入验证；其余域名（包括注入内容）直接丢弃并记录。
    const usable: SkillDiscoveryCandidate[] = []
    const rejected: { url: string; reason: string }[] = []
    const seenKeys = new Set<string>()
    for (const candidate of searchResult.candidates.slice(0, MAX_CANDIDATES)) {
      const repo = parseGitHubRepo(candidate.url)
      if (!repo) {
        rejected.push({ url: candidate.url, reason: '不是允许的 GitHub 地址，已忽略' })
        continue
      }
      const key = canonicalRepoKey(repo)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      usable.push(candidate)
    }

    const verified: VerifiedSkillCandidate[] = []
    let ambiguous: { url: string; repo: ParsedRepo; dirs: string[] } | null = null
    for (const candidate of usable) {
      report('正在验证 Skill 候选', candidate.url, 'running')
      try {
        const result = await this.verifyCandidate(candidate, skillName)
        if (result.state === 'verified') {
          verified.push(result.candidate)
          report(
            '候选验证通过',
            `${result.candidate.skill.name} · ${result.candidate.repo.owner}/${result.candidate.repo.repo}` +
              `${result.candidate.repo.path ? `/${result.candidate.repo.path}` : ''}`,
            'success'
          )
        } else if (result.state === 'ambiguous') {
          ambiguous = result
          report('仓库包含多个 Skill', `共 ${result.dirs.length} 个目录，需要用户指定`, 'success')
        } else {
          rejected.push({ url: result.url, reason: result.reason })
          report('候选未通过验证', result.reason, 'failed')
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        rejected.push({ url: candidate.url, reason })
        report('候选验证失败', reason, 'failed')
      }
    }

    if (verified.length === 1) return { kind: 'proposal', candidate: verified[0] }
    if (verified.length > 1) return { kind: 'multiple', candidates: verified }
    if (ambiguous) return { kind: 'ambiguous', url: ambiguous.url, repo: ambiguous.repo, dirs: ambiguous.dirs }
    if (searchResult.marketplace?.installNote) {
      return {
        kind: 'marketplace_instructions',
        url: searchResult.marketplace.url,
        note: searchResult.marketplace.installNote,
        searched
      }
    }
    return { kind: 'none', searched, rejected }
  }

  /**
   * 对单个候选做确定性 GitHub 验证：
   * 优先使用 GitHub API 轻量探针；API 限流（403/429）或目录树截断时，
   * 降级为受限 archive 下载验证。两条路径都不合格时明确拒绝，绝不猜测。
   */
  async verifyCandidate(
    candidate: SkillDiscoveryCandidate,
    requestedName: string
  ): Promise<CandidateVerification> {
    const repo = parseGitHubRepo(candidate.url)
    if (!repo) {
      return { state: 'rejected', url: candidate.url, reason: '不是允许的 GitHub 地址' }
    }

    try {
      return await this.verifyViaApi(repo, candidate, requestedName)
    } catch (err) {
      if (err instanceof GithubRateLimitedError || err instanceof GithubTreeTruncatedError) {
        // 安全降级：archive 下载不依赖 GitHub API 配额，也不需要 Token。
        return this.verifyViaArchive(repo, candidate, requestedName, err.message)
      }
      throw err
    }
  }

  /** 轻量路径：repos 元信息 + git/trees + 单个 SKILL.md。 */
  private async verifyViaApi(
    repo: ParsedRepo,
    candidate: SkillDiscoveryCandidate,
    requestedName: string
  ): Promise<CandidateVerification> {
    if (!(await this.probe.repoExists(repo.owner, repo.repo))) {
      return { state: 'rejected', url: candidate.url, reason: '仓库不存在或不是公开仓库' }
    }
    const listing = await this.probe.listSkillDirs(repo.owner, repo.repo, repo.ref)
    const resolved = resolveSkillPath(repo.path, listing.dirs)
    if ('ambiguousDirs' in resolved) {
      return { state: 'ambiguous', url: candidate.url, repo, dirs: resolved.ambiguousDirs }
    }
    if ('reason' in resolved) {
      return { state: 'rejected', url: candidate.url, reason: resolved.reason }
    }
    const markdown = await this.probe.fetchSkillMarkdown(
      repo.owner,
      repo.repo,
      repo.ref,
      resolved.path ?? ''
    )
    if (markdown === null) {
      return { state: 'rejected', url: candidate.url, reason: 'SKILL.md 读取失败' }
    }
    return this.buildVerified(repo, resolved.path, markdown, candidate, requestedName, [
      '已验证 GitHub 仓库公开可访问',
      `验证方式：GitHub API 轻量探针${listing.sha ? ` · 快照 ${listing.sha.slice(0, 12)}` : ''}`
    ])
  }

  /** 降级路径：受限 archive 下载验证（保留大小、路径、符号链接限制）。 */
  private async verifyViaArchive(
    repo: ParsedRepo,
    candidate: SkillDiscoveryCandidate,
    requestedName: string,
    degradedReason: string
  ): Promise<CandidateVerification> {
    let probeResult: SkillArchiveProbeResult
    try {
      probeResult = await this.probe.probeArchive(repo.owner, repo.repo, repo.ref)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        state: 'rejected',
        url: candidate.url,
        reason: `GitHub API 不可用且 archive 验证失败：${reason}`
      }
    }
    const resolved = resolveSkillPath(repo.path, probeResult.dirs)
    if ('ambiguousDirs' in resolved) {
      return { state: 'ambiguous', url: candidate.url, repo, dirs: resolved.ambiguousDirs }
    }
    if ('reason' in resolved) {
      return { state: 'rejected', url: candidate.url, reason: resolved.reason }
    }
    const buffer = probeResult.readSkillMarkdown(resolved.path ?? '')
    if (!buffer) {
      return { state: 'rejected', url: candidate.url, reason: 'SKILL.md 读取失败' }
    }
    let markdown: string
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return { state: 'rejected', url: candidate.url, reason: 'SKILL.md 不是有效的 UTF-8 文本' }
    }
    return this.buildVerified(repo, resolved.path, markdown, candidate, requestedName, [
      '已验证 GitHub 仓库公开可访问',
      `验证方式：受限 archive 下载（${degradedReason}）` +
        `${probeResult.snapshot ? ` · 快照 ${probeResult.snapshot.slice(0, 12)}` : ''}`
    ])
  }

  /** 共用收尾：解析 SKILL.md、安全名称检查、名称匹配与证据组装。 */
  private buildVerified(
    repo: ParsedRepo,
    skillPath: string | undefined,
    markdown: string,
    candidate: SkillDiscoveryCandidate,
    requestedName: string,
    evidencePrefix: string[]
  ): CandidateVerification {
    const skill = parseSkillFile(candidate.url, markdown)
    if (!skill) {
      return { state: 'rejected', url: candidate.url, reason: 'SKILL.md 格式无效或缺少 name / description' }
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(skill.name)) {
      return { state: 'rejected', url: candidate.url, reason: `Skill 名称「${skill.name}」不安全` }
    }

    // 名称必须匹配：SKILL.md 的 name 与请求一致（高置信），
    // 或仓库名与请求相关（中置信）。两者都不匹配说明搜错了东西。
    const requested = requestedName.toLowerCase()
    const nameMatch = skill.name.toLowerCase() === requested
    const repoMatch =
      repo.repo.toLowerCase().includes(requested) || requested.includes(repo.repo.toLowerCase())
    if (!nameMatch && !repoMatch) {
      return {
        state: 'rejected',
        url: candidate.url,
        reason: `Skill 名称「${skill.name}」与请求的「${requestedName}」不匹配`
      }
    }

    const finalRepo: ParsedRepo = skillPath ? { ...repo, path: skillPath } : repo
    const finalUrl = skillPath
      ? `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.ref ?? 'HEAD'}/${skillPath}`
      : candidate.url
    const evidence = [
      candidate.sourceUrl ? `来源页面：${candidate.sourceUrl}` : '来源：联网搜索结果',
      ...evidencePrefix,
      `已验证${skillPath ? `目录 ${skillPath}/ ` : '仓库根目录'}存在有效 SKILL.md（name：${skill.name}）`
    ]

    return {
      state: 'verified',
      candidate: {
        url: finalUrl,
        repo: finalRepo,
        canonicalKey: canonicalRepoKey(finalRepo),
        skill,
        why: candidate.why,
        ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
        evidence,
        confidence: nameMatch ? 'high' : 'medium'
      }
    }
  }
}
