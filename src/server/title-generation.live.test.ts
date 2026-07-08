import { describe, expect, test } from "bun:test"
import { CodexAppServerManager } from "./codex-app-server"
import { fallbackTitleFromMessage, generateTitleForChatDetailed } from "./generate-title"
import { QuickResponseAdapter, runClaudeStructured, runCodexStructured } from "./quick-response"

const shouldRunAllLiveTitleTests = process.env.KANNA_RUN_LIVE_TITLE_TESTS === "1"
const shouldRunClaudeLiveTitleTest = shouldRunAllLiveTitleTests || process.env.KANNA_RUN_LIVE_CLAUDE_TITLE_TEST === "1"
const shouldRunCodexLiveTitleTest = shouldRunAllLiveTitleTests || process.env.KANNA_RUN_LIVE_CODEX_TITLE_TEST === "1"
const LIVE_MESSAGE = "Please help me debug a websocket reconnection issue in a Bun server app"

// Live provider tests are opt-in so the normal full test suite never spends
// real provider tokens or depends on local CLI authentication state.
if (shouldRunClaudeLiveTitleTest || shouldRunCodexLiveTitleTest) {
  describe("live title generation", () => {
    if (shouldRunClaudeLiveTitleTest) {
      test("generates a title with Claude", async () => {
        const adapter = new QuickResponseAdapter({
          runClaudeStructured,
          runCodexStructured: async () => {
            throw new Error("Codex fallback should not be used in the Claude live title test")
          },
        })

        const result = await generateTitleForChatDetailed(LIVE_MESSAGE, process.cwd(), adapter, {
          preferredProvider: "claude",
          useConfiguredProvider: false,
        })

        if (result.usedFallback) {
          throw new Error(`Claude live title generation fell back: ${JSON.stringify({
            failureMessage: result.failureMessage,
            attempts: result.attempts,
          })}`)
        }

        expect(result.usedFallback).toBe(false)
        expect(result.failureMessage).toBeNull()
        expect(result.provider).toBe("claude")
        expect(typeof result.title).toBe("string")
        expect(result.title).not.toBe(fallbackTitleFromMessage(LIVE_MESSAGE))
      }, 20_000)
    }

    if (shouldRunCodexLiveTitleTest) {
      test("generates a title with Codex", async () => {
        const codexManager = new CodexAppServerManager()
        const adapter = new QuickResponseAdapter({
          runClaudeStructured: async () => {
            throw new Error("Claude should not be used in the Codex live title test")
          },
          runCodexStructured: async (args) => runCodexStructured(codexManager, args),
        })

        const result = await generateTitleForChatDetailed(LIVE_MESSAGE, process.cwd(), adapter, {
          preferredProvider: "codex",
          useConfiguredProvider: false,
        })

        if (result.usedFallback) {
          throw new Error(`Codex live title generation fell back: ${JSON.stringify({
            failureMessage: result.failureMessage,
            attempts: result.attempts,
          })}`)
        }

        expect(result.usedFallback).toBe(false)
        expect(result.failureMessage).toBeNull()
        expect(result.provider).toBe("codex")
        expect(typeof result.title).toBe("string")
        expect(result.title).not.toBe(fallbackTitleFromMessage(LIVE_MESSAGE))
      }, 30_000)
    }
  })
}
