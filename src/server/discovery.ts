import type { Dirent, Stats } from "node:fs"
import { open, readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataRootDir } from "../shared/branding"
import type { AgentProvider } from "../shared/types"
import { resolveLocalPath } from "./paths"

/**
 * Read only the first few KB of a file. Codex session logs run to many MB and
 * only their first line (session_meta) matters here — reading whole files made
 * discovery block the event loop for seconds on large Codex histories.
 */
const FILE_HEAD_BYTES = 64 * 1024

async function readFileHead(filePath: string): Promise<string> {
  const handle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(FILE_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FILE_HEAD_BYTES, 0)
    return buffer.toString("utf8", 0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Upper bound on file handles one scan holds open at once. A Codex history
 * has thousands of session files; opening them all together would hit EMFILE.
 */
const SCAN_CONCURRENCY = 32

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; keeps input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}

async function pathExists(filePath: string) {
  return (await statOrNull(filePath)) !== null
}

export interface DiscoveredProject {
  localPath: string
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface ProjectDiscoveryAdapter {
  provider: AgentProvider
  scan(homeDir?: string): Promise<ProviderDiscoveredProject[]>
}

export async function resolveEncodedClaudePath(folderName: string) {
  const segments = folderName.replace(/^-/, "").split("-").filter(Boolean)
  let currentPath = ""
  let remainingSegments = [...segments]

  while (remainingSegments.length > 0) {
    let found = false

    for (let index = remainingSegments.length; index >= 1; index -= 1) {
      const segment = remainingSegments.slice(0, index).join("-")
      const candidate = `${currentPath}/${segment}`

      if (await pathExists(candidate)) {
        currentPath = candidate
        remainingSegments = remainingSegments.slice(index)
        found = true
        break
      }
    }

    if (!found) {
      const [head, ...tail] = remainingSegments
      currentPath = `${currentPath}/${head}`
      remainingSegments = tail
    }
  }

  return currentPath || "/"
}

async function normalizeExistingDirectory(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!(await stat(normalized)).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function isInternalKannaProjectPath(localPath: string, homeDir: string) {
  return resolveLocalPath(localPath) === resolveLocalPath(getDataRootDir(homeDir))
}

function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.localPath)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.localPath, {
        localPath: project.localPath,
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export class ClaudeProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "claude" as const

  async scan(homeDir: string = homedir()): Promise<ProviderDiscoveredProject[]> {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!(await pathExists(projectsDir))) {
      return []
    }

    const entries = await readdir(projectsDir, { withFileTypes: true })
    const scanned = await mapWithConcurrency(entries, SCAN_CONCURRENCY, async (entry): Promise<ProviderDiscoveredProject | null> => {
      if (!entry.isDirectory()) return null

      const resolvedPath = await resolveEncodedClaudePath(entry.name)
      const normalizedPath = await normalizeExistingDirectory(resolvedPath)
      if (!normalizedPath) {
        return null
      }
      if (isInternalKannaProjectPath(normalizedPath, homeDir)) {
        return null
      }

      const stats = await stat(path.join(projectsDir, entry.name))
      return {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: stats.mtimeMs,
      }
    })
    const projects = scanned.filter((project): project is ProviderDiscoveredProject => project !== null)

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function readCodexSessionIndex(indexPath: string) {
  const updatedAtById = new Map<string, number>()
  if (!(await pathExists(indexPath))) {
    return updatedAtById
  }

  for (const line of (await readFile(indexPath, "utf8")).split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = updatedAtById.get(id)
    if (existing === undefined || updatedAt > existing) {
      updatedAtById.set(id, updatedAt)
    }
  }

  return updatedAtById
}

async function collectCodexSessionFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return []
  }

  const entries = await readdir(directory, { withFileTypes: true })
  // Subdirectories are walked in parallel but flattened in readdir order, so
  // the file list (and which duplicate session id wins) matches a serial walk.
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return collectCodexSessionFiles(fullPath)
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      return [fullPath]
    }
    return []
  }))
  return nested.flat()
}

async function readCodexConfiguredProjects(configPath: string) {
  const projects = new Map<string, number>()
  const configStat = await statOrNull(configPath)
  if (!configStat) {
    return projects
  }

  const configMtime = configStat.mtimeMs
  for (const line of (await readFile(configPath, "utf8")).split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

interface CodexSessionMetadata {
  sessionId: string
  cwd: string
  modifiedAt: number
}

function parseCodexSessionHead(head: string, mtimeMs: number): CodexSessionMetadata | null {
  const firstLine = head.split("\n", 1)[0]
  if (!firstLine?.trim()) return null

  const record = parseJsonRecord(firstLine)
  if (!record || record.type !== "session_meta") return null

  const payload = record.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null

  const payloadRecord = payload as Record<string, unknown>
  const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
  const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
  if (!sessionId || !cwd) return null

  const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
  const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
  const modifiedAt = [recordTimestamp, payloadTimestamp, mtimeMs].find((value) => !Number.isNaN(value)) ?? mtimeMs

  return { sessionId, cwd, modifiedAt }
}

interface CachedCodexSession {
  mtimeMs: number
  size: number
  metadata: CodexSessionMetadata | null
}

export interface CodexProjectDiscoveryOptions {
  /** Injectable for tests that count how often a session file is opened. */
  readFileHead?: (filePath: string) => Promise<string>
}

export class CodexProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "codex" as const
  private readonly readHead: (filePath: string) => Promise<string>
  /**
   * Parsed session_meta per session file, keyed by sessions dir then file path.
   * Discovery reruns on every local-projects subscribe, so each WebSocket
   * reconnect used to reopen and parse every Codex session file on the main
   * thread (~0.5 s per run on a real history). Codex appends to a session file
   * but never rewrites its first line, so an unchanged mtime + size means the
   * cached parse still holds.
   */
  private readonly sessionCache = new Map<string, Map<string, CachedCodexSession>>()

  constructor(options: CodexProjectDiscoveryOptions = {}) {
    this.readHead = options.readFileHead ?? readFileHead
  }

  private async readCodexSessionMetadata(sessionsDir: string) {
    const previous = this.sessionCache.get(sessionsDir)
    // Rebuilt from scratch each scan, so files that disappeared fall out.
    const next = new Map<string, CachedCodexSession>()
    const sessionFiles = await collectCodexSessionFiles(sessionsDir)

    const results = await mapWithConcurrency(sessionFiles, SCAN_CONCURRENCY, async (sessionFile) => {
      // Codex can delete or rotate a session between readdir and stat/open;
      // skip it rather than fail the whole discovery.
      try {
        const fileStat = await stat(sessionFile)
        const cached = previous?.get(sessionFile)
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
          next.set(sessionFile, cached)
          return cached.metadata
        }
        const metadata = parseCodexSessionHead(await this.readHead(sessionFile), fileStat.mtimeMs)
        next.set(sessionFile, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, metadata })
        return metadata
      } catch {
        return null
      }
    })
    this.sessionCache.set(sessionsDir, next)

    const metadataById = new Map<string, { cwd: string; modifiedAt: number }>()
    for (const metadata of results) {
      if (!metadata) continue
      metadataById.set(metadata.sessionId, { cwd: metadata.cwd, modifiedAt: metadata.modifiedAt })
    }
    return metadataById
  }

  async scan(homeDir: string = homedir()): Promise<ProviderDiscoveredProject[]> {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const [updatedAtById, metadataById, configuredProjects] = await Promise.all([
      readCodexSessionIndex(indexPath),
      this.readCodexSessionMetadata(sessionsDir),
      readCodexConfiguredProjects(configPath),
    ])

    const sessionProjects = await mapWithConcurrency([...metadataById.entries()], SCAN_CONCURRENCY, async ([sessionId, metadata]): Promise<ProviderDiscoveredProject | null> => {
      const modifiedAt = updatedAtById.get(sessionId) ?? metadata.modifiedAt
      const cwd = metadata.cwd
      if (!cwd) {
        return null
      }
      if (!path.isAbsolute(cwd)) {
        return null
      }

      const normalizedPath = await normalizeExistingDirectory(cwd)
      if (!normalizedPath) {
        return null
      }
      if (isInternalKannaProjectPath(normalizedPath, homeDir)) {
        return null
      }

      return {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      }
    })

    const configProjects = await mapWithConcurrency([...configuredProjects.entries()], SCAN_CONCURRENCY, async ([configuredPath, modifiedAt]): Promise<ProviderDiscoveredProject | null> => {
      if (!path.isAbsolute(configuredPath)) {
        return null
      }

      const normalizedPath = await normalizeExistingDirectory(configuredPath)
      if (!normalizedPath) {
        return null
      }
      if (isInternalKannaProjectPath(normalizedPath, homeDir)) {
        return null
      }

      return {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt,
      }
    })

    const projects = [...sessionProjects, ...configProjects]
      .filter((project): project is ProviderDiscoveredProject => project !== null)

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

export class GrokProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "grok" as const

  async scan(homeDir: string = homedir()): Promise<ProviderDiscoveredProject[]> {
    const sessionsDir = path.join(homeDir, ".grok", "sessions")
    if (!(await pathExists(sessionsDir))) return []

    // The grok CLI owns this directory and can delete or rewrite session
    // folders while we scan. Discovery runs at boot and on refresh for every
    // provider, so a folder that vanishes mid-scan is skipped, never thrown.
    let entries: Dirent[]
    try {
      entries = await readdir(sessionsDir, { withFileTypes: true })
    } catch {
      return []
    }

    const scanned = await mapWithConcurrency(entries, SCAN_CONCURRENCY, async (entry): Promise<ProviderDiscoveredProject | null> => {
      if (!entry.isDirectory()) return null
      let cwd: string
      try {
        cwd = decodeURIComponent(entry.name)
      } catch {
        return null
      }
      if (!path.isAbsolute(cwd)) return null
      const normalizedPath = await normalizeExistingDirectory(cwd)
      if (!normalizedPath) return null
      const folderStat = await statOrNull(path.join(sessionsDir, entry.name))
      if (!folderStat) return null
      return {
        provider: this.provider,
        localPath: normalizedPath,
        title: path.basename(normalizedPath) || normalizedPath,
        modifiedAt: folderStat.mtimeMs,
      }
    })
    const projects = scanned.filter((project): project is ProviderDiscoveredProject => project !== null)

    return mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))
  }
}

export const DEFAULT_PROJECT_DISCOVERY_ADAPTERS: ProjectDiscoveryAdapter[] = [
  new ClaudeProjectDiscoveryAdapter(),
  new CodexProjectDiscoveryAdapter(),
  new GrokProjectDiscoveryAdapter(),
]

/**
 * Scans in flight, per adapter set and home dir. Every client resubscribes to
 * local-projects on reconnect, and each subscribe asks for a fresh discovery;
 * a reconnect storm would otherwise stack one full scan per socket.
 */
const inFlightDiscoveries = new WeakMap<ProjectDiscoveryAdapter[], Map<string, Promise<DiscoveredProject[]>>>()

async function runDiscovery(homeDir: string, adapters: ProjectDiscoveryAdapter[]): Promise<DiscoveredProject[]> {
  const scans = await Promise.all(adapters.map((adapter) => adapter.scan(homeDir)))
  return mergeDiscoveredProjects(
    scans.flatMap((projects) => projects.map(({ provider: _provider, ...project }) => project))
  ).filter((project) => !isInternalKannaProjectPath(project.localPath, homeDir))
}

/**
 * Callers that arrive while a scan is running share its result instead of
 * starting another. The project commands that refresh discovery also save the
 * project in the store, and the local-projects snapshot lists saved projects
 * itself, so joining a scan that started a moment earlier loses nothing.
 */
export function discoverProjects(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS
): Promise<DiscoveredProject[]> {
  let byHome = inFlightDiscoveries.get(adapters)
  if (!byHome) {
    byHome = new Map()
    inFlightDiscoveries.set(adapters, byHome)
  }
  const existing = byHome.get(homeDir)
  if (existing) return existing

  const discovery = runDiscovery(homeDir, adapters).finally(() => {
    byHome.delete(homeDir)
  })
  byHome.set(homeDir, discovery)
  return discovery
}
