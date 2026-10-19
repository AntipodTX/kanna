import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

// Isolate the SDK mock so the other coordinator tests use their own adapters.
test("Claude startup keeps the Ultracode flag when the SDK caps effort", () => {
  const script = `
    import { mock } from "bun:test"
    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    let options
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...sdk,
      query: args => { options = args.options; throw new Error("captured query") },
    }))
    const { AgentCoordinator } = await import("./src/server/agent")
    const { applyClaudeSdkModels } = await import("./src/server/provider-catalog")
    applyClaudeSdkModels([{ value: "opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] }])
    const coordinator = new AgentCoordinator({ store: {}, onStateChange: () => {} })
    try {
      await coordinator.startClaudeSessionFn({ chatId: "chat", localPath: "/tmp", model: "opus",
        effort: "ultracode", planMode: false, autoPlan: false })
    } catch (error) { if (error.message !== "captured query") throw error }
    console.log(JSON.stringify({ effort: options.effort, ultracode: options.settings.ultracode }))
  `
  const result = spawnSync(process.execPath, ["--eval", script], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({ effort: "high", ultracode: true })
}, 30_000)
