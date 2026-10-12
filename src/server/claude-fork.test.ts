import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk"
import { prepareClaudeTranscriptFork } from "./claude-fork"
import { timestamped } from "./transcript"

function fixture() {
  const source: SessionStoreEntry[] = [
    { type: "user", uuid: "u1", parentUuid: null, sessionId: "source", message: { role: "user", content: "repeat" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "source", message: { role: "assistant", content: "repeat" } },
    { type: "progress", uuid: "p1", parentUuid: "a1", sessionId: "source" },
    { type: "user", uuid: "u2", parentUuid: "p1", sessionId: "source", message: { role: "user", content: "repeat" } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", sessionId: "source", message: { role: "assistant", content: "repeat" } },
  ]
  const forked: SessionStoreEntry[] = source.filter((entry) => entry.type !== "progress").map((entry) => ({
    ...entry, uuid: `fork-${entry.uuid}`, sessionId: "forked", parentUuid: entry.uuid === "u1" ? null
      : `fork-${entry.parentUuid === "p1" ? "a1" : entry.parentUuid}`,
    forkedFrom: { sessionId: "source", messageUuid: entry.uuid },
  }))
  const prefix = [
    timestamped({ kind: "user_prompt", messageId: "u1", content: "repeat" }),
    timestamped({ kind: "assistant_text", messageId: "a1", text: "repeat" }),
    timestamped({ kind: "tool_call", messageId: "a1", tool: { kind: "tool", toolKind: "read", toolId: "t1",
      toolName: "Read", input: { filePath: "x" } } }),
    timestamped({ kind: "result", messageId: "runtime-result", subtype: "success", isError: false,
      durationMs: 0, result: "done" }),
    timestamped({ kind: "user_prompt", messageId: "u2", content: "repeat" }),
    timestamped({ kind: "assistant_text", messageId: "a2", text: "repeat" }),
  ]
  const removed: string[] = []
  const reader = { read: async (id: string) => id === "source" ? source : forked,
    fork: async () => "forked", remove: async (id: string) => { removed.push(id) } }
  const args = { localPath: "/fixture", sessionToken: "source", resumeSessionAt: "a2", transcriptPrefix: prefix }
  return { source, forked, prefix, removed, reader, args }
}

describe("Claude native fork UUID mapping", () => {
  test("child provenance without a parent tool ID does not require a main-thread UUID mapping", async () => {
    const f = fixture()
    const child = timestamped({ kind: "assistant_text", text: "child output", messageId: "child-only", claudeSidechain: true })
    f.args.transcriptPrefix = [...f.prefix, child]
    const mapped = await prepareClaudeTranscriptFork(f.args, f.reader)
    expect(mapped.transcriptPrefix.at(-1)).toEqual(child)
    expect(mapped.transcriptPrefix[1]?.messageId).toBe("fork-a1")
  })
  test("maps repeated text and multiple rows per UUID by exact provenance, including progress parents", async () => {
    const f = fixture()
    const mapped = await prepareClaudeTranscriptFork(f.args, f.reader)
    expect(mapped.sessionToken).toBe("forked")
    expect(mapped.transcriptPrefix.map((entry) => entry.messageId)).toEqual([
      "fork-u1", "fork-a1", "fork-a1", "runtime-result", "fork-u2", "fork-a2",
    ])
    for (let i = 0; i < f.prefix.length; i++) {
      expect(mapped.transcriptPrefix[i]?._id).toBe(f.prefix[i]?._id)
      expect(mapped.transcriptPrefix[i]?.createdAt).toBe(f.prefix[i]?.createdAt)
    }
    expect(f.prefix[1]?.messageId).toBe("a1")
  })

  test.each(["missing provenance", "wrong parent", "changed content", "missing prefix", "duplicate provenance"])(
    "refuses %s without publishing history and removes only its new artifact", async (failure) => {
      const f = fixture()
      if (failure === "missing provenance") delete (f.forked[0] as Record<string, unknown>).forkedFrom
      if (failure === "wrong parent") f.forked[3]!.parentUuid = "fork-u1"
      if (failure === "changed content") f.forked[1]!.message = { role: "assistant", content: "changed" }
      if (failure === "missing prefix") f.forked.splice(1, 1)
      if (failure === "duplicate provenance") f.forked.push({ ...f.forked[1]!, uuid: "duplicate" })
      const before = JSON.stringify(f.prefix)
      await expect(prepareClaudeTranscriptFork(f.args, f.reader)).rejects.toThrow("Claude")
      expect(JSON.stringify(f.prefix)).toBe(before)
      expect(f.removed).toEqual(["forked"])
    }
  )

  test("rejects a missing source boundary before creating a native fork", async () => {
    const f = fixture()
    let forks = 0
    f.reader.fork = async () => { forks++; return "forked" }
    await expect(prepareClaudeTranscriptFork({ ...f.args, resumeSessionAt: "unknown" }, f.reader))
      .rejects.toThrow("resume point")
    expect(forks).toBe(0)
  })

  test("resolves old imported UUIDs from exact native ancestry rather than identical text", async () => {
    const f = fixture()
    f.source[1]!.forkedFrom = { sessionId: "old-session", messageUuid: "old-answer" }
    f.prefix[1] = { ...f.prefix[1]!, messageId: "old-answer", debugRaw: JSON.stringify({ sessionId: "old-session" }) }
    const mapped = await prepareClaudeTranscriptFork(f.args, f.reader)
    expect(mapped.transcriptPrefix[1]).toMatchObject({ messageId: "fork-a1", claudeSessionToken: "forked" })
  })

  test("does not use raw record position to map a compacted transcript", async () => {
    const f = fixture()
    f.source.splice(3, 0, { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: null,
      sessionId: "source", compactMetadata: { trigger: "auto", preTokens: 50 } })
    f.forked.push({ type: "system", subtype: "compact_boundary", uuid: "fork-compact", parentUuid: null,
      sessionId: "forked", compactMetadata: { trigger: "auto", preTokens: 50 },
      forkedFrom: { sessionId: "source", messageUuid: "compact" } })
    f.forked.reverse()
    const mapped = await prepareClaudeTranscriptFork(f.args, f.reader)
    expect(mapped.transcriptPrefix[1]?.messageId).toBe("fork-a1")
    expect(mapped.transcriptPrefix[5]?.messageId).toBe("fork-a2")
  })

  test("refuses imported native rows whose UUID is missing before creating a fork", async () => {
    const f = fixture()
    f.prefix[0] = { ...f.prefix[0]!, messageId: "missing-user", claudeSessionToken: "source" }
    let forks = 0
    f.reader.fork = async () => { forks++; return "forked" }
    await expect(prepareClaudeTranscriptFork(f.args, f.reader)).rejects.toThrow("verified native")
    expect(forks).toBe(0)
  })

  test("keeps earlier handoff context while mapping the current native history", async () => {
    const f = fixture()
    const context = timestamped({ kind: "assistant_text", messageId: "codex-answer", text: "older context" })
    f.args.transcriptPrefix = [context, timestamped({ kind: "handoff_boundary", fromProvider: "codex", toProvider: "claude" }), ...f.prefix]
    const mapped = await prepareClaudeTranscriptFork(f.args, f.reader)
    expect(mapped.transcriptPrefix[0]).toBe(context)
    expect(mapped.transcriptPrefix[3]?.messageId).toBe("fork-a1")
  })

  test("uses the installed SDK on raw native files and keeps repeated forks valid after restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claude-fork-native-"))
    try {
      const config = path.join(dir, "config")
      const cwd = path.join(dir, "project")
      const nativeDir = path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
      mkdirSync(nativeDir, { recursive: true })
      mkdirSync(cwd, { recursive: true })
      const sessionId = "11111111-1111-4111-8111-111111111111"
      const entries = [
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "repeat" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "msg1", role: "assistant", content: [{ type: "text", text: "one" }] } },
        { type: "system", subtype: "compact_boundary", uuid: "compact", parentUuid: "a1", compactMetadata: { trigger: "auto", preTokens: 50 } },
        { type: "user", uuid: "summary", parentUuid: "compact", isCompactSummary: true,
          message: { role: "user", content: "Compacted summary" } },
        { type: "user", uuid: "u2", parentUuid: "summary", message: { role: "user", content: "repeat" } },
        { type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "msg2", role: "assistant", content: [{ type: "text", text: "two" }] } },
      ].map((entry) => ({ ...entry, sessionId, cwd, timestamp: "2026-10-01T00:00:00.000Z", isSidechain: false }))
      const nativeFile = path.join(nativeDir, `${sessionId}.jsonl`)
      writeFileSync(nativeFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
      const output = path.join(dir, "output.json")
      const helper = path.join(import.meta.dir, "claude-fork.ts")
      const script = `
        import { prepareClaudeTranscriptFork } from ${JSON.stringify(helper)};
        import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
        const prefix = [{kind:'user_prompt',_id:'prompt-1',createdAt:1,content:'repeat'},
          {kind:'assistant_text',_id:'answer-1',createdAt:2,messageId:'a1',text:'one'},
          {kind:'user_prompt',_id:'prompt-2',createdAt:3,content:'repeat'},
          {kind:'assistant_text',_id:'answer-2',createdAt:4,messageId:'a2',text:'two'}];
        const first = await prepareClaudeTranscriptFork({localPath:${JSON.stringify(cwd)},sessionToken:${JSON.stringify(sessionId)},resumeSessionAt:'a2',transcriptPrefix:prefix});
        writeFileSync(${JSON.stringify(output)},JSON.stringify(first));
        unlinkSync(${JSON.stringify(nativeFile)});
        const persisted = JSON.parse(readFileSync(${JSON.stringify(output)},'utf8'));
        const second = await prepareClaudeTranscriptFork({localPath:${JSON.stringify(cwd)},sessionToken:persisted.sessionToken,
          resumeSessionAt:persisted.transcriptPrefix[1].messageId,boundarySessionToken:persisted.sessionToken,
          transcriptPrefix:persisted.transcriptPrefix.slice(0,2)});
        writeFileSync(${JSON.stringify(output)},JSON.stringify({first,second}));
      `
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdout: "pipe", stderr: "pipe",
      })
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(0)
      const result = JSON.parse(readFileSync(output, "utf8"))
      expect(result.first.transcriptPrefix[1].messageId).not.toBe("a1")
      expect(result.second.transcriptPrefix[1].messageId).not.toBe(result.first.transcriptPrefix[1].messageId)
      expect(result.second.transcriptPrefix[1]).toMatchObject({ _id: "answer-1", createdAt: 2,
        claudeSessionToken: result.second.sessionToken })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
