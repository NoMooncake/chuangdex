// Skill 运行时安装：从公开 GitHub 仓库下载一个完整 Skill 目录。
// 这里只下载并保存文件，不执行仓库中的脚本、命令或安装步骤。

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join, posix, resolve, sep } from 'path'
import { Readable } from 'stream'
import { gunzipSync } from 'zlib'
import { extract, type Headers } from 'tar-stream'
import { parseSkillFile } from './loader'
import type { Skill } from './types'

export interface ParsedRepo {
  owner: string
  repo: string
  /** GitHub tree/blob 链接中指定的分支或提交；普通仓库链接为空。 */
  ref?: string
  /** Skill 在仓库中的目录；普通仓库根目录链接为空。 */
  path?: string
}

export interface SkillPackageFile {
  /** 相对 Skill 根目录的 POSIX 路径。 */
  path: string
  content: Uint8Array
}

export interface DownloadedSkillPackage {
  skill: Skill
  files: SkillPackageFile[]
  sourceUrl: string
  commitSha: string
  skillRoot: string
}

interface ArchiveEntry {
  path: string
  type: Headers['type']
  size: number
}

const MAX_FILE_COUNT = 300
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_COMPRESSED_ARCHIVE_BYTES = 30 * 1024 * 1024
const MAX_UNPACKED_ARCHIVE_BYTES = 100 * 1024 * 1024

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

/**
 * 支持：
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo/tree/ref/path/to/skill
 * - https://github.com/owner/repo/blob/ref/path/to/skill/SKILL.md
 */
export function parseGitHubRepo(input: string): ParsedRepo | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(safeDecodeSegment)
  if (segments.some((segment) => segment === null)) return null

  const parts = segments as string[]
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  if (!isSafeGitHubPart(owner) || !isSafeGitHubPart(repo)) return null
  if (parts.length === 2) return { owner, repo }

  const kind = parts[2]
  const ref = parts[3]
  if ((kind !== 'tree' && kind !== 'blob') || !ref) return null

  const remainder = parts.slice(4)
  if (kind === 'blob') {
    if (remainder.at(-1)?.toLowerCase() !== 'skill.md') return null
    remainder.pop()
  }

  const path = normalizeRepoPath(remainder.join('/'))
  if (path === null) return null
  return { owner, repo, ref, ...(path ? { path } : {}) }
}

/** 提取用户文本中的 GitHub 链接；仅用于授权校验，不用于判断安装意图。 */
export function extractGitHubUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/github\.com\/[^\s<>"']+/gi) ?? []
  return matches
    .map((url) => url.replace(/[，。；：！？、.,;:!?)\]}]+$/g, ''))
    .filter((url) => parseGitHubRepo(url) !== null)
}

/** 用于比较模型工具参数与用户提供链接是否指向同一位置。 */
export function canonicalRepoKey(repo: ParsedRepo): string {
  return [repo.owner.toLowerCase(), repo.repo.toLowerCase(), repo.ref ?? '', repo.path ?? ''].join('|')
}

/** 下载仓库中一个完整 Skill 目录，并在写盘前完成大小、路径和格式校验。 */
export async function downloadSkillPackage(
  repo: ParsedRepo,
  sourceUrl: string
): Promise<DownloadedSkillPackage> {
  const requestedRef = repo.ref ?? 'HEAD'
  const archive = await downloadSourceArchive(repo.owner, repo.repo, requestedRef)
  const entries = await readArchiveEntries(archive.tar)
  const skillRoot = findSkillRoot(entries, repo.path)
  const prefix = skillRoot ? `${skillRoot}/` : ''

  const scopedEntries = entries.filter(
    (entry) => entry.path === skillRoot || entry.path.startsWith(prefix)
  )
  if (scopedEntries.some((entry) => entry.type === 'symlink' || entry.type === 'link')) {
    throw new SkillInstallError('Skill 目录包含符号链接，当前不能安全地安装')
  }

  const fileEntries = scopedEntries.filter(
    (entry) => entry.type === 'file' || entry.type === 'contiguous-file'
  )
  if (fileEntries.length === 0 || fileEntries.length > MAX_FILE_COUNT) {
    throw new SkillInstallError(`Skill 文件数量必须在 1–${MAX_FILE_COUNT} 个之间`)
  }
  let declaredBytes = 0
  for (const entry of fileEntries) {
    const relativePath = toRelativeSkillPath(entry.path, skillRoot)
    if (!relativePath) throw new SkillInstallError(`Skill 包含不安全路径：${entry.path}`)
    if (entry.size > MAX_SINGLE_FILE_BYTES) {
      throw new SkillInstallError(`文件过大：${relativePath}`)
    }
    declaredBytes += entry.size
  }
  if (declaredBytes > MAX_TOTAL_BYTES) {
    throw new SkillInstallError('Skill 总大小超过 20 MB，停止安装')
  }

  const files = await collectSkillFiles(archive.tar, skillRoot)

  const skillFile = files.find((file) => file.path.toLowerCase() === 'skill.md')
  if (!skillFile) throw new SkillInstallError('所选目录根部没有 SKILL.md')

  let markdown: string
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.content)
  } catch {
    throw new SkillInstallError('SKILL.md 不是有效的 UTF-8 文本')
  }
  const skill = validateSkillMarkdown(markdown, sourceUrl)
  if (!skill) {
    throw new SkillInstallError('SKILL.md 格式无效或缺少 name / description')
  }
  if (!isSafeSkillName(skill.name)) {
    throw new SkillInstallError(`Skill 名称「${skill.name}」不安全，只允许字母、数字、下划线和连字符`)
  }

  return { skill, files, sourceUrl, commitSha: archive.snapshot, skillRoot }
}

/** 将完整 Skill 包原子写入用户目录。 */
export function installSkillPackageToUserDir(
  skillPackage: DownloadedSkillPackage,
  userSkillsDir: string
): Skill {
  if (!userSkillsDir) throw new SkillInstallError('用户 Skills 目录未配置')
  const { skill, files } = skillPackage
  if (!isSafeSkillName(skill.name)) throw new SkillInstallError(`Skill 名称不安全：${skill.name}`)

  const userDir = resolve(userSkillsDir)
  const finalDir = resolve(join(userDir, skill.name))
  if (!finalDir.startsWith(userDir + sep)) throw new SkillInstallError('安装路径超出了用户 Skills 目录')
  if (existsSync(finalDir)) throw new SkillInstallError(`名为「${skill.name}」的 Skill 已存在`)

  mkdirSync(userDir, { recursive: true })
  const tempDir = join(userDir, `.tmp-install-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  try {
    mkdirSync(tempDir, { recursive: false })
    const resolvedTempDir = resolve(tempDir)
    for (const file of files) {
      const relativePath = normalizeRepoPath(file.path)
      if (!relativePath) throw new SkillInstallError(`Skill 包含不安全路径：${file.path}`)
      const target = resolve(join(resolvedTempDir, ...relativePath.split('/')))
      if (!target.startsWith(resolvedTempDir + sep)) {
        throw new SkillInstallError(`Skill 文件超出安装目录：${file.path}`)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.content)
    }
    renameSync(tempDir, finalDir)
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // 清理失败不覆盖原始错误
    }
    throw err
  }

  return { ...skill, path: join(finalDir, 'SKILL.md') }
}

/** 兼容旧测试和单文件调用；新安装流程应使用完整 Skill 包。 */
export function installSkillToUserDir(skill: Skill, content: string, userSkillsDir: string): Skill {
  return installSkillPackageToUserDir(
    {
      skill,
      sourceUrl: skill.path,
      commitSha: '',
      skillRoot: '',
      files: [{ path: 'SKILL.md', content: new TextEncoder().encode(content) }]
    },
    userSkillsDir
  )
}

/** 兼容旧调用：只返回所选 Skill 的 SKILL.md 文本。 */
export async function downloadSkillMarkdown(owner: string, repo: string): Promise<string | null> {
  try {
    const sourceUrl = `https://github.com/${owner}/${repo}`
    const downloaded = await downloadSkillPackage({ owner, repo }, sourceUrl)
    const skillFile = downloaded.files.find((file) => file.path.toLowerCase() === 'skill.md')
    return skillFile ? new TextDecoder().decode(skillFile.content) : null
  } catch {
    return null
  }
}

export function validateSkillMarkdown(content: string, source: string): Skill | null {
  return parseSkillFile(source, content)
}

export function isSafeSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

function findSkillRoot(entries: ArchiveEntry[], requestedPath?: string): string {
  if (requestedPath !== undefined) {
    const root = normalizeRepoPath(requestedPath)
    if (root === null) throw new SkillInstallError('GitHub 链接中的 Skill 路径不安全')
    const skillPath = root ? `${root}/SKILL.md` : 'SKILL.md'
    if (!entries.some((entry) => isArchiveFile(entry) && entry.path.toLowerCase() === skillPath.toLowerCase())) {
      throw new SkillInstallError('指定目录根部没有 SKILL.md')
    }
    return root
  }

  if (entries.some((entry) => isArchiveFile(entry) && entry.path.toLowerCase() === 'skill.md')) {
    return ''
  }
  const candidates = entries
    .filter((entry) => isArchiveFile(entry) && entry.path.toLowerCase().endsWith('/skill.md'))
    .map((entry) => posix.dirname(entry.path))
  const unique = [...new Set(candidates)]
  if (unique.length === 0) throw new SkillInstallError('仓库中没有找到 SKILL.md')
  if (unique.length > 1) {
    throw new SkillInstallError('仓库包含多个 Skill，请提供指向具体 Skill 目录的 GitHub tree 链接')
  }
  return unique[0]
}

function toRelativeSkillPath(repoPath: string, skillRoot: string): string | null {
  const relative = skillRoot ? repoPath.slice(skillRoot.length + 1) : repoPath
  return normalizeRepoPath(relative)
}

function normalizeRepoPath(input: string): string | null {
  if (!input) return ''
  if (input.includes('\\') || input.includes('\0') || input.startsWith('/')) return null
  const normalized = posix.normalize(input)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null
  return normalized
}

function safeDecodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded === '.' || decoded === '..') return null
    return decoded
  } catch {
    return null
  }
}

function isSafeGitHubPart(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

async function downloadSourceArchive(
  owner: string,
  repo: string,
  ref: string
): Promise<{ tar: Buffer; snapshot: string }> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${encodeURIComponent(ref)}`
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new SkillInstallError('无法连接 GitHub，请检查网络后重试')
  }
  if (response.status === 404) throw new SkillInstallError('GitHub 仓库或分支不存在')
  if (!response.ok) throw new SkillInstallError(`GitHub 源码下载失败（HTTP ${response.status}）`)

  const compressed = await readResponseWithLimit(response, MAX_COMPRESSED_ARCHIVE_BYTES)
  let tar: Buffer
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES })
  } catch {
    throw new SkillInstallError('GitHub 源码包无效或解压后超过 100 MB')
  }
  const snapshot = response.headers.get('etag')?.replaceAll('"', '') || ref
  return { tar, snapshot }
}

async function readResponseWithLimit(response: Response, limit: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new SkillInstallError('GitHub 源码压缩包超过 30 MB，停止安装')
  }
  if (!response.body) throw new SkillInstallError('GitHub 源码下载响应为空')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new SkillInstallError('GitHub 源码压缩包超过 30 MB，停止安装')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function readArchiveEntries(tar: Buffer): Promise<ArchiveEntry[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const entries: ArchiveEntry[] = []
    const unpack = extract()
    unpack.on('entry', (header, stream, next) => {
      try {
        const path = stripArchiveRoot(header.name)
        if (path) entries.push({ path, type: header.type, size: header.size ?? 0 })
        stream.on('end', () => next())
        stream.resume()
      } catch (err) {
        stream.resume()
        next(err)
      }
    })
    unpack.on('finish', () => resolvePromise(entries))
    unpack.on('error', rejectPromise)
    Readable.from(tar).pipe(unpack)
  })
}

function collectSkillFiles(tar: Buffer, skillRoot: string): Promise<SkillPackageFile[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const files: SkillPackageFile[] = []
    let totalBytes = 0
    const prefix = skillRoot ? `${skillRoot}/` : ''
    const unpack = extract()

    unpack.on('entry', (header, stream, next) => {
      void (async () => {
        const archivePath = stripArchiveRoot(header.name)
        const isScoped = Boolean(archivePath) &&
          (archivePath === skillRoot || archivePath.startsWith(prefix))
        if (!isScoped || (header.type !== 'file' && header.type !== 'contiguous-file')) {
          stream.resume()
          await new Promise<void>((resolveEnd) => stream.on('end', resolveEnd))
          next()
          return
        }

        const relativePath = toRelativeSkillPath(archivePath, skillRoot)
        if (!relativePath) throw new SkillInstallError(`Skill 包含不安全路径：${archivePath}`)
        const chunks: Buffer[] = []
        let fileBytes = 0
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          fileBytes += buffer.byteLength
          if (fileBytes > MAX_SINGLE_FILE_BYTES) throw new SkillInstallError(`文件过大：${relativePath}`)
          chunks.push(buffer)
        }
        totalBytes += fileBytes
        if (totalBytes > MAX_TOTAL_BYTES) throw new SkillInstallError('Skill 实际下载大小超过 20 MB，停止安装')
        files.push({ path: relativePath, content: Buffer.concat(chunks) })
        next()
      })().catch((err) => next(err))
    })
    unpack.on('finish', () => resolvePromise(files))
    unpack.on('error', rejectPromise)
    Readable.from(tar).pipe(unpack)
  })
}

function stripArchiveRoot(input: string): string {
  if (!input || input.includes('\\') || input.includes('\0') || input.startsWith('/')) {
    throw new SkillInstallError('GitHub 源码包包含不安全路径')
  }
  const withoutTrailingSlash = input.replace(/\/+$/, '')
  const normalized = posix.normalize(withoutTrailingSlash)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SkillInstallError('GitHub 源码包包含路径穿越')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new SkillInstallError('GitHub 源码包包含不安全路径')
  }
  return parts.length > 1 ? parts.slice(1).join('/') : ''
}

function isArchiveFile(entry: ArchiveEntry): boolean {
  return entry.type === 'file' || entry.type === 'contiguous-file'
}
