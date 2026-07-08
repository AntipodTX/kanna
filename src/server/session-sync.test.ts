import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import { getDataRootDir, LOG_PREFIX } from "../shared/branding"
import { EventStore } from "./event-store"
import type { GenerateChatTitleResult } from "./generate-title"
import { syncExternalSessions } from "./session-sync"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function projectFolderName(localPath: string) {
  return localPath.replaceAll("/", "-")
}

function messageKinds(entries: TranscriptEntry[]) {
  return entries.map((entry) => entry.kind)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("syncExternalSessions", () => {
  test("uses the Web UI title-generation flow for newly imported chats", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const titleCalls: Array<{ messageContent: string; cwd: string; preferredProvider?: "claude" | "codex" }> = []
    const generatedTitle: GenerateChatTitleResult = {
      title: "Auth flow bugfix",
      usedFallback: false,
      failureMessage: null,
    }

    const buildCodexThread = (name: string, preview = name) => ({
      id: "thread-1",
      preview,
      ephemeral: false,
      modelProvider: "openai" as const,
      createdAt: 1_710_000_000,
      updatedAt: 1_710_000_005,
      status: "idle" as const,
      path: null,
      cwd: projectDir,
      cliVersion: "0.0.0",
      source: "cli" as const,
      name,
      turns: [{
        id: "turn-1",
        status: "completed" as const,
        error: null,
        items: [
          {
            type: "userMessage" as const,
            id: "user-msg-1",
            content: [{
              type: "text" as const,
              text: "Please fix the login race and flaky retry loop in auth before release",
              text_elements: [] as [],
            }],
          },
        ],
      }],
    })

    let currentThreadName = "Please fix the login race and flaky retry loop in auth before release"

    const syncArgs = {
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      generateTitle: async (messageContent: string, cwd: string, preferredProvider?: "claude" | "codex") => {
        titleCalls.push({ messageContent, cwd, preferredProvider })
        return generatedTitle
      },
      codexClient: {
        async listThreads() {
          return [buildCodexThread(currentThreadName, currentThreadName)]
        },
        async readThread() {
          return buildCodexThread(currentThreadName, currentThreadName)
        },
      },
    } satisfies Parameters<typeof syncExternalSessions>[0]

    await syncExternalSessions(syncArgs)

    const [project] = store.listProjects()
    let [chat] = store.listChatsByProject(project!.id)
    expect(chat?.title).toBe("Auth flow bugfix")
    expect(chat?.hasLocalTitleOverride).toBe(false)
    expect(titleCalls).toEqual([{
      messageContent: "Please fix the login race and flaky retry loop in auth before release",
      cwd: projectDir,
      preferredProvider: "codex",
    }])

    currentThreadName = "Provider title changed later but should not sync back"
    await syncExternalSessions(syncArgs)

    ;[chat] = store.listChatsByProject(project!.id)
    expect(chat?.title).toBe("Auth flow bugfix")
    expect(chat?.hasLocalTitleOverride).toBe(false)
    expect(titleCalls).toHaveLength(1)
  })

  test("imports Claude history files and normalizes Kanna attachment prompts back into user messages", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-session-1"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Review this file\n\n<kanna-attachments>\n<attachment kind=\"file\" path=\"/tmp/spec.txt\" project_path=\"./spec.txt\" size_bytes=\"32\" display_name=\"spec.txt\" mime_type=\"text/plain\" />\n</kanna-attachments>",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-2",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "/tmp/project\n", is_error: false },
          ],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => ({
        title: "Review this file",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [project] = store.listProjects()
    expect(project?.localPath).toBe(projectDir)

    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.provider).toBe("claude")
    expect(chat?.sessionToken).toBe(sessionId)
    expect(chat?.title).toBe("Review this file")

    const messages = store.getMessages(chat!.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: "Review this file",
    })
  })

  test("skips unreadable Claude history files while importing the rest", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const badSessionId = "claude-unreadable-session"
    const badTranscriptPath = join(sessionDir, `${badSessionId}.jsonl`)
    await writeFile(badTranscriptPath, "unreadable\n", "utf8")
    await chmod(badTranscriptPath, 0)

    const goodSessionId = "claude-readable-session"
    await writeFile(join(sessionDir, `${goodSessionId}.jsonl`), JSON.stringify({
      type: "user",
      sessionId: goodSessionId,
      uuid: "user-readable",
      timestamp: "2026-04-01T10:00:00.000Z",
      message: {
        role: "user",
        content: "Keep importing the readable session",
      },
    }), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const progressMessages: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      generateTitle: async () => ({
        title: "Readable session",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
      onProgress: (message) => {
        progressMessages.push(message)
      },
    })

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.sessionToken).toBe(goodSessionId)
    expect(progressMessages.some((message) => (
      message.includes("Claude session read failed")
      && message.includes(`session=${badSessionId}`)
    ))).toBe(true)
  })

  test("skips unreadable Claude project directories while importing Codex sessions", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await chmod(sessionDir, 0)

    const store = new EventStore(dataDir)
    await store.initialize()
    const progressMessages: string[] = []
    const codexThread = {
      id: "thread-unreadable-claude-dir",
      preview: "Import this Codex thread even if Claude scan fails",
      ephemeral: false,
      modelProvider: "openai" as const,
      createdAt: 1_710_000_000,
      updatedAt: 1_710_000_005,
      status: "idle" as const,
      path: null,
      cwd: projectDir,
      cliVersion: "0.0.0",
      source: "cli" as const,
      name: "",
      turns: [{
        id: "turn-1",
        status: "completed" as const,
        error: null,
        items: [
          {
            type: "userMessage" as const,
            id: "user-msg-1",
            content: [{
              type: "text" as const,
              text: "Import this Codex thread even if Claude scan fails",
              text_elements: [] as [],
            }],
          },
        ],
      }],
    }

    try {
      await syncExternalSessions({
        store,
        homeDir,
        discoveredProjects: [{
          localPath: projectDir,
          title: "Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        }],
        generateTitle: async () => ({
          title: "Codex session",
          usedFallback: false,
          failureMessage: null,
        }),
        codexClient: {
          async listThreads() {
            return [codexThread]
          },
          async readThread() {
            return codexThread
          },
        },
        onProgress: (message) => {
          progressMessages.push(message)
        },
      })
    } finally {
      await chmod(sessionDir, 0o700)
    }

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.provider).toBe("codex")
    expect(chat?.sessionToken).toBe(codexThread.id)
    expect(progressMessages.some((message) => (
      message.includes("Claude project dir read failed")
      && message.includes(`path=${projectDir}`)
      && message.includes(`dir=${sessionDir}`)
    ))).toBe(true)
  })

  test("skips Claude attachment-only prompts when attachment import is unavailable", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-attachment-only-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-attachment-only",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Please inspect the attached files.\n\n<kanna-attachments>\n<attachment kind=\"file\" path=\"/tmp/spec.txt\" project_path=\"./spec.txt\" size_bytes=\"32\" display_name=\"spec.txt\" mime_type=\"text/plain\" />\n</kanna-attachments>",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for attachment-only prompts")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips Claude local command records during history import", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-local-command-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            "<command-name>/model</command-name>",
            "<command-message>model</command-message>",
            "<command-args></command-args>",
          ].join("\n"),
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to \u001b[1mOpus 4.7 (1M context)\u001b[22m</local-command-stdout>",
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-2",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Login successful</local-command-stdout>",
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Now inspect the deployment config",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => ({
        title: "Inspect deployment config",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    const messages = store.getMessages(chat!.id)

    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
  })

  test("preserves previously imported Claude local command records on resync", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-local-command-resync-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const localCommandContent = [
      "<command-name>/model</command-name>",
      "<command-message>model</command-message>",
      "<command-args></command-args>",
    ].join("\n")
    const localCommandOutput = "<local-command-stdout>Login successful</local-command-stdout>"
    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandContent,
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandOutput,
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Now inspect the deployment config",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    await store.appendMessage(chat.id, {
      _id: "local-command-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandContent,
    })
    await store.appendMessage(chat.id, {
      _id: "local-command-output-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandOutput,
    })
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: Date.parse("2026-04-01T10:00:01.000Z"),
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: Date.parse("2026-04-01T10:00:02.000Z"),
      kind: "assistant_text",
      text: "I will inspect it.",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const messages = store.getMessages(chat.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "user_prompt",
      "user_prompt",
      "assistant_text",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: localCommandContent,
    })
    expect(messages[1]).toMatchObject({
      kind: "user_prompt",
      content: localCommandOutput,
    })
    expect(messages[2]).toMatchObject({
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
  })

  test("leaves existing Claude chats unchanged when local command filtering makes the source session empty", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-exit-command-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const localCommandOutput = "<local-command-stdout>Goodbye!</local-command-stdout>"
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandOutput,
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id, { title: "Exit Command Session" })
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    await store.appendMessage(chat.id, {
      _id: "local-command-output-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandOutput,
    })

    const logs: string[] = []
    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(store.getMessages(chat.id)).toMatchObject([{
      kind: "user_prompt",
      content: localCommandOutput,
    }])
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=empty_skipped duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)}$`
        )
      )
    )
  })

  test("skips Claude service-only sessions during history import", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-service-only-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "system",
        subtype: "init",
        sessionId,
        uuid: "system-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        model: "claude-opus-4-7",
        tools: [],
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "resume-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation that ran out of context.",
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        sessionId,
        uuid: "compact-1",
        timestamp: "2026-04-01T10:00:02.000Z",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        sessionId,
        uuid: "result-1",
        timestamp: "2026-04-01T10:00:03.000Z",
        is_error: false,
        duration_ms: 10,
        result: "",
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:03.000Z"),
      }],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for service-only sessions")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips importing external sessions with no messages", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const claudeProjectDir = await createTempDir("kanna-sync-claude-project-")
    const codexProjectDir = await createTempDir("kanna-sync-codex-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(claudeProjectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, "claude-empty.jsonl"), "", "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    let titleCalls = 0
    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [
        {
          localPath: claudeProjectDir,
          title: "Claude Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
        {
          localPath: codexProjectDir,
          title: "Codex Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
      ],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for empty chats")
      },
      codexClient: {
        async listThreads() {
          return [{
            id: "codex-empty",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: codexProjectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "codex-empty",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: codexProjectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [],
          }
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips importing provider sessions hidden after chat edits", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-superseded-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Old prompt before edit",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    await store.hideProviderSession("claude", sessionId)
    const logs: string[] = []
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for hidden provider sessions")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=hidden duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)}$`
        )
      )
    )
    expect(logs.at(-1)).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: complete in \\d+ms; 1 processed, 0 created, 0 appended, 0 reconciled, 0 unchanged, 1 hidden, 0 empty skipped, 0 title skipped$`)
    )
  })

  test("skips importing a new external chat when title generation falls back", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => ({
        title: "Please fix the login race and flaky...",
        usedFallback: true,
        failureMessage: "claude returned no result; codex returned no result",
        provider: null,
        attempts: [
          {
            provider: "claude",
            outcome: "no_result",
            durationMs: 5000,
          },
          {
            provider: "codex",
            outcome: "no_result",
            durationMs: 2500,
          },
        ],
      }),
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "Please fix the login race and flaky retry loop in auth before release",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{
                    type: "text",
                    text: "Please fix the login race and flaky retry loop in auth before release",
                    text_elements: [],
                  }],
                },
              ],
            }],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "Please fix the login race and flaky retry loop in auth before release",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{
                    type: "text",
                    text: "Please fix the login race and flaky retry loop in auth before release",
                    text_elements: [],
                  }],
                },
              ],
            }],
          }
        },
      },
    })

    expect(store.listProjects()).toHaveLength(0)
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=title_skipped duration=\\d+ms provider=codex session=thread-1 project=${escapeRegex(projectDir)} title=fallback titleAttempts=claude:no_result:5000ms,codex:no_result:2500ms titleMs=\\d+ms$`
        )
      )
    )
  })

  test("excludes the Kanna data root from startup sync even when it exists in discovered and saved projects", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const internalProjectDir = getDataRootDir(homeDir)
    await mkdir(internalProjectDir, { recursive: true })
    const internalSessionId = "claude-internal-session"
    const internalSessionDir = join(homeDir, ".claude", "projects", projectFolderName(internalProjectDir))
    await mkdir(internalSessionDir, { recursive: true })
    await writeFile(join(internalSessionDir, `${internalSessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId: internalSessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Internal quick-response session",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    await store.openProject(internalProjectDir, "Internal")

    const codexCwds: string[] = []
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [
        {
          localPath: internalProjectDir,
          title: "Internal",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
        {
          localPath: projectDir,
          title: "Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
      ],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        throw new Error("title generation should not run for the internal workspace")
      },
      codexClient: {
        async listThreads({ cwd }) {
          codexCwds.push(cwd)
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [internalProject] = store.listProjects()
    expect(internalProject?.localPath).toBe(internalProjectDir)
    expect(store.listChatsByProject(internalProject!.id)).toHaveLength(0)
    expect(codexCwds).toEqual([projectDir])
    expect(logs[0]).toBe(`${LOG_PREFIX} session sync: starting for 1 projects`)
    expect(logs.some((message) => message.includes(internalProjectDir))).toBe(false)
  })

  test("reports startup sync progress through onProgress", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-session-logs"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Inspect auth sync logs",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => ({
        title: "Auth logs",
        usedFallback: false,
        failureMessage: null,
        provider: "claude",
        attempts: [{
          provider: "claude",
          outcome: "success",
          durationMs: 12,
        }],
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(logs[0]).toBe(`${LOG_PREFIX} session sync: starting for 1 projects`)
    expect(logs[1]).toBe(`${LOG_PREFIX} session sync: scanning Claude sessions`)
    expect(logs[2]).toMatch(new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Claude scan complete in \\d+ms; 1 sessions$`))
    expect(logs[3]).toBe(`${LOG_PREFIX} session sync: scanning Codex sessions`)
    expect(logs[4]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 listThreads complete in \\d+ms \\(0 threads\\) path=${escapeRegex(projectDir)}$`)
    )
    expect(logs[5]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 readThread complete in \\d+ms \\(0 threads\\) path=${escapeRegex(projectDir)}$`)
    )
    expect(logs[6]).toMatch(new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex scan complete in \\d+ms; 0 sessions$`))
    expect(logs[7]).toBe(`${LOG_PREFIX} session sync: found 1 external sessions (1 Claude, 0 Codex)`)
    expect(logs[8]).toBe(
      `${LOG_PREFIX} session sync: processing 1/1 provider=claude session=${sessionId} project=${projectDir}`
    )
    expect(logs[9]).toMatch(
      new RegExp(
        `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=created\\+appended duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)} title=generated titleProvider=claude titleAttempts=claude:success:12ms titleMs=\\d+ms$`
      )
    )
    expect(logs[10]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: complete in \\d+ms; 1 processed, 1 created, 1 appended, 0 reconciled, 0 unchanged, 0 hidden, 0 empty skipped, 0 title skipped$`)
    )
  })

  test("includes the Codex listThreads failure reason in startup logs", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      codexClient: {
        async listThreads() {
          throw new Error("spawn codex ENOENT")
        },
        async readThread() {
          return null
        },
      },
    })

    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 listThreads failed in \\d+ms path=${escapeRegex(projectDir)} error=spawn codex ENOENT$`
        )
      )
    )
  })

  test("merges Codex API history into an existing chat without duplicating already logged transcript entries", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "thread-1")
    await store.renameChat(chat.id, "Manual alias")
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: 1,
      kind: "user_prompt",
      content: "Hello",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: 2,
      kind: "assistant_text",
      text: "Hi there",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "Hello",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "Hello",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{ type: "text", text: "Hello", text_elements: [] }],
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-1",
                  text: "Hi there",
                },
                {
                  type: "commandExecution",
                  id: "cmd-1",
                  command: "pwd",
                  status: "completed",
                  aggregatedOutput: "/tmp/project\n",
                  exitCode: 0,
                },
              ],
            }],
          }
        },
      },
    })

    const syncedChat = store.getChat(chat.id)
    expect(syncedChat?.title).toBe("Manual alias")

    const messages = store.getMessages(chat.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
    ])
    expect(messages[2]).toMatchObject({
      kind: "tool_call",
    })
    expect(messages[3]).toMatchObject({
      kind: "tool_result",
      toolId: "cmd-1",
      content: "/tmp/project\n",
    })
  })

  test("rewrites diverged provider history while preserving anchored Kanna-specific entries", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "thread-1")
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: 1,
      kind: "user_prompt",
      content: "Old prompt",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: 2,
      kind: "assistant_text",
      text: "Old answer",
    })
    await store.appendMessage(chat.id, {
      _id: "tool-call-1",
      createdAt: 3,
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName: "AskUserQuestion",
        toolId: "ask-1",
        input: { questions: [{ question: "Continue?" }] },
      },
    })
    await store.appendMessage(chat.id, {
      _id: "tool-result-1",
      createdAt: 4,
      kind: "tool_result",
      toolId: "ask-1",
      content: { answers: { Continue: ["Yes"] } },
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-2",
      createdAt: 5,
      kind: "assistant_text",
      text: "Shared tail",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "New prompt",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_010,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "New prompt",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_010,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{ type: "text", text: "New prompt", text_elements: [] }],
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-1",
                  text: "New answer",
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-2",
                  text: "Shared tail",
                },
              ],
            }],
          }
        },
      },
    })

    const messages = store.getMessages(chat.id)
    expect(messages).toMatchObject([
      { kind: "user_prompt", content: "New prompt" },
      { kind: "assistant_text", text: "New answer" },
      {
        kind: "tool_call",
        tool: {
          toolKind: "ask_user_question",
          toolId: "ask-1",
        },
      },
      {
        kind: "tool_result",
        toolId: "ask-1",
      },
      { kind: "assistant_text", text: "Shared tail" },
    ])
    expect(messages.map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "assistant_text",
    ])

    const transcriptSyncPath = join(dataDir, "transcript-sync", `${chat.id}.json`)
    const transcriptSync = JSON.parse(await readFile(transcriptSyncPath, "utf8")) as {
      canonicalHash: string
      providerSequence: unknown[]
    }
    expect(typeof transcriptSync.canonicalHash).toBe("string")
    expect(transcriptSync.providerSequence).toHaveLength(3)
  })
})
