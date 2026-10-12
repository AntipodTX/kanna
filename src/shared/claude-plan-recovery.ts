import type { TranscriptEntry } from "./types"

type ToolCallEntry = Extract<TranscriptEntry, { kind: "tool_call" }>
type ClaudePlanFileOperation =
  | { toolKind: "write_file"; filePath: string; content: string }
  | { toolKind: "edit_file"; filePath: string; oldString: string; newString: string; replaceAll: boolean }

function isClaudePlanFilePath(value: unknown): value is string {
  if (typeof value !== "string") return false
  const normalized = value.replaceAll("\\", "/")
  return normalized.includes("/.claude/plans/") && normalized.endsWith(".md")
}

export function isEmptyClaudeExitPlan(entry: TranscriptEntry): boolean {
  return entry.kind === "tool_call"
    && entry.tool.toolKind === "exit_plan_mode"
    && !(typeof entry.tool.input.plan === "string" && entry.tool.input.plan.length > 0)
}

function readOperation(entry: ToolCallEntry): ClaudePlanFileOperation | null {
  const { tool } = entry
  if ((tool.toolKind !== "write_file" && tool.toolKind !== "edit_file") || !isClaudePlanFilePath(tool.input.filePath)) return null
  if (tool.toolKind === "write_file" && typeof tool.input.content === "string") {
    return { toolKind: "write_file", filePath: tool.input.filePath, content: tool.input.content }
  }
  if (tool.toolKind === "edit_file" && typeof tool.input.oldString === "string" && typeof tool.input.newString === "string") {
    return {
      toolKind: "edit_file", filePath: tool.input.filePath,
      oldString: tool.input.oldString, newString: tool.input.newString,
      replaceAll: tool.rawInput?.replace_all === true,
    }
  }
  return null
}

/**
 * Chronological plan reconstruction shared by stored headers and legacy full
 * client entries. A server advances only through an empty exit that needs it;
 * successful plan operations alone ask for their payload, once per lifecycle.
 */
export class ClaudeExitPlanRecovery {
  private length = 0
  private readonly pendingFileOperations = new Map<string, { entry: ToolCallEntry; operation?: ClaudePlanFileOperation | null }>()
  private readonly appliedFileOperations = new Set<string>()
  private readonly planFiles = new Map<string, string>()
  readonly recoveredPlans = new Map<string, string>()
  private latestPlanFilePath: string | null = null

  /**
   * Conservative retained-byte estimate for the server's recovery budget.
   * Strings cost two bytes per code unit plus a header; shared strings are
   * charged at every reference. Map/Set nodes and pending operation objects
   * are included. Pending source entries already belong to the header cache;
   * their references are charged here, while hydrated operation bodies are
   * charged in full. No hydrated raw input is retained by this state.
   */
  getEstimatedBytes(): number {
    const stringBytes = (value: string) => 64 + value.length * 2
    let bytes = 512 // Recovery, cache wrapper and collection objects.
    for (const [toolId, pending] of this.pendingFileOperations) {
      bytes += 256 + stringBytes(toolId)
      const operation = pending.operation
      if (!operation) continue
      bytes += stringBytes(operation.filePath)
      bytes += operation.toolKind === "write_file"
        ? stringBytes(operation.content)
        : stringBytes(operation.oldString) + stringBytes(operation.newString)
    }
    for (const toolId of this.appliedFileOperations) bytes += 128 + stringBytes(toolId)
    for (const [filePath, content] of this.planFiles) bytes += 128 + stringBytes(filePath) + stringBytes(content)
    for (const [toolId, plan] of this.recoveredPlans) bytes += 128 + stringBytes(toolId) + stringBytes(plan)
    if (this.latestPlanFilePath !== null) bytes += stringBytes(this.latestPlanFilePath)
    return bytes
  }

  update(entries: TranscriptEntry[], end = entries.length, hydrate: (entry: ToolCallEntry) => ToolCallEntry = (entry) => entry) {
    for (; this.length < end; this.length += 1) {
      const entry = entries[this.length]!
      if (entry.kind === "tool_call") {
        const { tool } = entry
        if ((tool.toolKind === "write_file" || tool.toolKind === "edit_file") && isClaudePlanFilePath(tool.input.filePath)) {
          this.pendingFileOperations.set(tool.toolId, { entry })
        }
        if (tool.toolKind === "exit_plan_mode") {
          if (isEmptyClaudeExitPlan(entry)) {
            const recoveredPlan = this.latestPlanFilePath ? this.planFiles.get(this.latestPlanFilePath) : undefined
            if (recoveredPlan) this.recoveredPlans.set(tool.toolId, recoveredPlan)
          }
          this.latestPlanFilePath = null
        }
        continue
      }
      if (entry.kind !== "tool_result" || entry.isError || this.appliedFileOperations.has(entry.toolId)) continue
      const pending = this.pendingFileOperations.get(entry.toolId)
      if (!pending) continue
      const filePath = pending.entry.tool.toolKind === "write_file" || pending.entry.tool.toolKind === "edit_file"
        ? pending.entry.tool.input.filePath : undefined
      if (!filePath) continue
      // An edit without a known base cannot reconstruct anything, so even its
      // targeted payload read is unnecessary.
      if (pending.entry.tool.toolKind === "edit_file" && !this.planFiles.has(filePath)) continue
      if (pending.operation === undefined) pending.operation = readOperation(hydrate(pending.entry))
      const operation = pending.operation
      if (!operation) {
        if (pending.entry.trimmed) {
          // A successful stored operation with a lost body made this file
          // unknowable. Do not let later edits reuse an obsolete base.
          this.planFiles.delete(filePath)
          this.latestPlanFilePath = filePath
          this.appliedFileOperations.add(entry.toolId)
          this.pendingFileOperations.delete(entry.toolId)
        }
        continue
      }
      if (operation.toolKind === "write_file") {
        this.planFiles.set(filePath, operation.content)
      } else {
        const currentPlan = this.planFiles.get(filePath)
        if (currentPlan === undefined || !currentPlan.includes(operation.oldString)) continue
        this.planFiles.set(filePath, operation.replaceAll
          ? currentPlan.replaceAll(operation.oldString, operation.newString)
          : currentPlan.replace(operation.oldString, operation.newString))
      }
      this.latestPlanFilePath = filePath
      this.appliedFileOperations.add(entry.toolId)
      this.pendingFileOperations.delete(entry.toolId)
    }
    return this.recoveredPlans
  }
}

export function recoverClaudeExitPlans(entries: TranscriptEntry[]): Map<string, string> {
  return new ClaudeExitPlanRecovery().update(entries)
}
