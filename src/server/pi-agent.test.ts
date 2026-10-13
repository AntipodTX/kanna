import { describe, expect, test } from "bun:test"
import { normalizeToolCall } from "../shared/tools"
import { buildRegistryModel, preparePiNativeSession, extractPiToolResultContent, normalizePiUsage, translatePiTool, PI_TOOL_NAMES, type PiConnection } from "./pi-agent"

describe("translatePiTool", () => {
  test("maps read onto Read/read_file with offset and limit", () => {
    const { toolName, input } = translatePiTool("read", { path: "/repo/src/index.ts", offset: 10, limit: 50 })
    const tool = normalizeToolCall({ toolName, toolId: "t1", input })
    expect(tool.toolKind).toBe("read_file")
    expect(tool.input).toMatchObject({ filePath: "/repo/src/index.ts" })
  })

  test("maps bash onto Bash and converts the timeout to milliseconds", () => {
    const { toolName, input } = translatePiTool("bash", { command: "bun test", timeout: 90 })
    const tool = normalizeToolCall({ toolName, toolId: "t2", input })
    expect(tool.toolKind).toBe("bash")
    expect(tool.input).toMatchObject({ command: "bun test", timeoutMs: 90_000 })
  })

  test("maps a single edit onto Edit/edit_file", () => {
    const { toolName, input } = translatePiTool("edit", {
      path: "/repo/a.ts",
      edits: [{ oldText: "const a = 1", newText: "const a = 2" }],
    })
    const tool = normalizeToolCall({ toolName, toolId: "t3", input })
    expect(tool.toolKind).toBe("edit_file")
    expect(tool.input).toMatchObject({
      filePath: "/repo/a.ts",
      oldString: "const a = 1",
      newString: "const a = 2",
    })
  })

  test("joins multi-edit calls into one edit_file pair", () => {
    const { toolName, input } = translatePiTool("edit", {
      path: "/repo/a.ts",
      edits: [
        { oldText: "one", newText: "uno" },
        { oldText: "two", newText: "dos" },
      ],
    })
    const tool = normalizeToolCall({ toolName, toolId: "t4", input })
    expect(tool.toolKind).toBe("edit_file")
    expect(tool.input).toMatchObject({ oldString: "one\ntwo", newString: "uno\ndos" })
  })

  test("maps write onto Write/write_file", () => {
    const { toolName, input } = translatePiTool("write", { path: "/repo/new.ts", content: "hi" })
    const tool = normalizeToolCall({ toolName, toolId: "t5", input })
    expect(tool.toolKind).toBe("write_file")
    expect(tool.input).toMatchObject({ filePath: "/repo/new.ts", content: "hi" })
  })

  test("maps grep onto Grep/grep", () => {
    const { toolName, input } = translatePiTool("grep", { pattern: "TODO", path: "src", ignoreCase: true })
    const tool = normalizeToolCall({ toolName, toolId: "t6", input })
    expect(tool.toolKind).toBe("grep")
    expect(tool.input).toMatchObject({ pattern: "TODO" })
  })

  test("maps find onto Glob/glob", () => {
    const { toolName, input } = translatePiTool("find", { pattern: "**/*.ts", path: "src" })
    const tool = normalizeToolCall({ toolName, toolId: "t7", input })
    expect(tool.toolKind).toBe("glob")
    expect(tool.input).toMatchObject({ pattern: "**/*.ts" })
  })

  test("maps ls onto Glob/glob with a directory pattern", () => {
    const { toolName, input } = translatePiTool("ls", { path: "src/server/" })
    const tool = normalizeToolCall({ toolName, toolId: "t8", input })
    expect(tool.toolKind).toBe("glob")
    expect(tool.input).toMatchObject({ pattern: "src/server/*" })
  })

  test("ls without a path lists the working directory", () => {
    const { input } = translatePiTool("ls", {})
    expect(input.pattern).toBe("./*")
  })

  test("every built-in pi tool maps onto a known Kanna tool kind", () => {
    for (const name of PI_TOOL_NAMES) {
      const { toolName, input } = translatePiTool(name, { path: "x", pattern: "y", command: "z", edits: [] })
      const tool = normalizeToolCall({ toolName, toolId: `id-${name}`, input })
      expect(tool.toolKind).not.toBe("unknown_tool")
    }
  })

  test("unknown tools fall through and render as unknown_tool", () => {
    const { toolName, input } = translatePiTool("custom_thing", { foo: 1 })
    const tool = normalizeToolCall({ toolName, toolId: "t9", input })
    expect(tool.toolKind).toBe("unknown_tool")
  })
})

describe("extractPiToolResultContent", () => {
  test("collapses text blocks to a string", () => {
    expect(
      extractPiToolResultContent({ content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] })
    ).toBe("hello world")
  })

  test("keeps block structure when images are present", () => {
    const result = extractPiToolResultContent({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    })
    expect(result).toEqual({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] })
  })

  test("passes through plain strings", () => {
    expect(extractPiToolResultContent("plain output")).toBe("plain output")
  })
})

describe("normalizePiUsage", () => {
  test("maps pi usage into a context window snapshot", () => {
    const usage = normalizePiUsage(
      { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, totalTokens: 1800 },
      262_144,
    )
    expect(usage).toMatchObject({
      usedTokens: 1800,
      inputTokens: 1600,
      cachedInputTokens: 500,
      outputTokens: 200,
      maxTokens: 262_144,
    })
  })

  test("returns null for empty usage", () => {
    expect(normalizePiUsage({}, 100)).toBeNull()
    expect(normalizePiUsage(undefined)).toBeNull()
  })
})

describe("buildRegistryModel", () => {
  const openrouter: PiConnection = {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "k",
  }

  test("synthesizes an OpenRouter model with the openrouter thinking format", () => {
    const model = buildRegistryModel(openrouter, "someone/some-new-model")
    expect(model).toMatchObject({
      id: "someone/some-new-model",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    })
    expect(model.compat?.thinkingFormat).toBe("openrouter")
  })

  test("synthesizes an OpenAI model with the openai thinking format", () => {
    const model = buildRegistryModel(
      { provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      "gpt-5.4-mini",
    )
    expect(model).toMatchObject({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    })
    expect(model.compat?.thinkingFormat).toBe("openai")
  })

  test("targets custom endpoints verbatim", () => {
    const model = buildRegistryModel(
      { provider: "custom", baseUrl: "https://llm.internal.example/v1", apiKey: "k" },
      "local-coder",
    )
    expect(model).toMatchObject({
      provider: "custom",
      baseUrl: "https://llm.internal.example/v1",
      id: "local-coder",
    })
    expect(model.compat?.thinkingFormat).toBe("openai")
  })
})


describe("Pi native startup outcome", () => {
  test("classifies real loaded, forked and missing context before any prompt", async () => {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent")
    const { mkdtemp, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "pi-outcome-"))
    try {
      const native = SessionManager.create(dir, dir)
      native.appendMessage({ role: "user", content: "old", timestamp: 1 })
      native.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }], api: "openai-completions", provider: "openai", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 })
      const token = native.getSessionFile()!
      const resumed = preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: false })
      expect(resumed.startupOutcome).toEqual({ kind: "resumed" })
      expect(resumed.sessionManager.getSessionId()).toBe(native.getSessionId())
      const forked = preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: true })
      expect(forked.startupOutcome).toEqual({ kind: "forked" })
      expect(forked.sessionManager.getSessionId()).not.toBe(native.getSessionId())
      expect(forked.sessionManager.getBranch()).toEqual(native.getBranch())
      await rm(token)
      expect(preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: false }).startupOutcome).toEqual({ kind: "fresh" })
    } finally { await rm(dir, { recursive: true, force: true }) }
  }, 120000)

  test("does not silently truncate a corrupt native resume artifact", async () => {
    const { SessionManager } = await import("@mariozechner/pi-coding-agent")
    const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = await mkdtemp(join(tmpdir(), "pi-corrupt-"))
    const token = join(dir, "corrupt.jsonl")
    try {
      await writeFile(token, "{broken native artifact")
      expect(() => preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: false })).toThrow("Cannot verify Pi session")
      expect(await readFile(token, "utf8")).toBe("{broken native artifact")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

test("Pi rejects a misplaced native header and preserves its original bytes", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent")
  const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "pi-header-"))
  const token = join(dir, "misplaced.jsonl")
  const original = JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: "kept", timestamp: 1 } }) + "\n" + JSON.stringify({ type: "session", id: "native-id", version: 3, cwd: dir, timestamp: new Date().toISOString() }) + "\n"
  try {
    await writeFile(token, original)
    expect(() => preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: false })).toThrow("Cannot verify Pi session")
    expect(await readFile(token, "utf8")).toBe(original)
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 120000)

test("Pi refuses an unverifiable legacy fork before creating a truncated native copy", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent")
  const { mkdtemp, rm, writeFile, readdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "pi-legacy-"))
  const token = join(dir, "legacy.jsonl")
  const original = [
    { type: "session", id: "legacy", version: 1, cwd: dir, timestamp: new Date().toISOString() },
    { type: "message", message: { role: "user", content: "first", timestamp: 1 } },
    { type: "message", message: { role: "user", content: "second", timestamp: 2 } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n"
  try {
    await writeFile(token, original)
    expect(() => preparePiNativeSession(SessionManager, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: true })).toThrow("Cannot verify Pi session")
    expect(await readdir(dir)).toEqual(["legacy.jsonl"])
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 120000)

test("Pi warm native reuse waits for lazy content preparation before accepting input", async () => {
  const { PiAgentManager } = await import("./pi-agent")
  const manager = new PiAgentManager({ dataDir: "/unused/pi-test" })
  const prompts: string[] = []
  let prepared!: () => void
  const blocked = new Promise<void>(resolve => { prepared = resolve })
  const session = {
    isStreaming: false, messages: [], sessionFile: "/missing/native/session.jsonl",
    subscribe: () => () => {}, prompt: async (content: string) => { prompts.push(content) }, dispose: () => {},
  }
  ;(manager as any).sessions.set("chat", { session, authStorage: { setRuntimeApiKey: () => {} },
    cwd: "/repo", model: "model", effort: "off", connectionProvider: "openrouter", connectionBaseUrl: "https://example.invalid", promptAgentId: "pi/model" })
  let observed: unknown
  const starting = manager.startTurn({ chatId: "chat", cwd: "/repo", content: "unprepared", model: "model", effort: "off", sessionToken: session.sessionFile, forkSession: false,
    connection: { provider: "openrouter", apiKey: "unused", baseUrl: "https://example.invalid" },
    prepareContent: async outcome => { observed = outcome; await blocked; return "prepared" },
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(observed).toEqual({ kind: "reused" })
  expect(prompts).toEqual([])
  prepared()
  const turn = await starting
  expect(prompts[0]).toContain("prepared")
  expect(prompts[0]).not.toContain("unprepared")
  turn.close()
  manager.dispose()
})

test("Pi detects a legacy native history replacement during the actual open", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent")
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = await mkdtemp(join(tmpdir(), "pi-legacy-change-"))
  const token = join(dir, "legacy.jsonl")
  const header = JSON.stringify({ type: "session", id: "legacy", version: 1, cwd: dir, timestamp: new Date().toISOString() })
  const source = header + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: "original", timestamp: 1 } }) + "\n"
  try {
    await writeFile(token, source)
    const nativeApi = { open: () => { writeFileSync(token, source.replace("original", "different")); return SessionManager.open(token, dir, dir) } }
    expect(() => preparePiNativeSession(nativeApi as never, { cwd: dir, sessionsDir: dir, sessionToken: token, forkSession: false })).toThrow("Cannot verify Pi session")
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 120000)

for (const replacement of [false, true]) {
  test(`Pi cancelled preparation disposes only its newly owned unsent handle (replacement=${replacement})`, async () => {
    const { PiAgentManager } = await import("./pi-agent")
    const manager = new PiAgentManager({ dataDir: "/unused/pi-test" })
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const observed = new Promise<void>(resolve => { entered = resolve })
    let current = true, disposed = 0, replacementDisposed = 0
    const prompts: string[] = []
    const native = { session: { isStreaming: false, dispose: () => { disposed++ }, prompt: async (content: string) => { prompts.push(content) } }, startupOutcome: { kind: "fresh" } }
    const next = { session: { dispose: () => { replacementDisposed++ } } }
    ;(manager as any).openSession = async () => { (manager as any).sessions.set("chat", native); return native }
    const starting = manager.startTurn({ chatId: "chat", cwd: "/repo", content: "unprepared", model: "model", effort: "off", sessionToken: null, forkSession: false,
      connection: { provider: "openrouter", apiKey: "unused", baseUrl: "https://example.invalid" }, isCurrentTurn: () => current,
      prepareContent: async () => { entered(); await blocked; return "cancelled input" },
    })
    try {
      await observed
      current = false
      if (replacement) (manager as any).sessions.set("chat", next)
      release()
      await expect(starting).rejects.toThrow("cancelled or replaced")
      expect(prompts).toEqual([])
      expect(disposed).toBe(1)
      expect(replacementDisposed).toBe(0)
      expect((manager as any).sessions.get("chat")).toBe(replacement ? next : undefined)
    } finally { release(); await starting.catch(() => {}); manager.dispose() }
  })
}

test("Pi cancellation while aborting an old streaming run prevents the prepared input", async () => {
  const { PiAgentManager } = await import("./pi-agent")
  const manager = new PiAgentManager({ dataDir: "/unused/pi-test" })
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const observed = new Promise<void>(resolve => { entered = resolve })
  let current = true, disposed = 0
  const prompts: string[] = []
  const session = { isStreaming: true, dispose: () => { disposed++ }, abort: async () => { entered(); await blocked }, prompt: async (content: string) => { prompts.push(content) } }
  const native = { session, startupOutcome: { kind: "reused" } }
  ;(manager as any).sessions.set("chat", native)
  ;(manager as any).openSession = async () => native
  const starting = manager.startTurn({ chatId: "chat", cwd: "/repo", content: "unprepared", model: "model", effort: "off", sessionToken: null, forkSession: false,
    connection: { provider: "openrouter", apiKey: "unused", baseUrl: "https://example.invalid" }, isCurrentTurn: () => current,
    prepareContent: async () => "prepared input",
  })
  try {
    await observed; current = false; release()
    await expect(starting).rejects.toThrow("cancelled or replaced")
    expect(prompts).toEqual([])
    expect(disposed).toBe(0)
    expect((manager as any).sessions.get("chat")).toBe(native)
  } finally { release(); await starting.catch(() => {}); manager.dispose() }
})
