import { describe, expect, test } from "bun:test"
import {
  buildChatCompletionItems,
  getActiveCompletionTrigger,
  replaceCompletionToken,
} from "./chatInputCompletions"

describe("getActiveCompletionTrigger", () => {
  test("detects a slash command at the start of the input", () => {
    expect(getActiveCompletionTrigger("/co", 3)).toEqual({
      kind: "command",
      token: "/co",
      query: "co",
      start: 0,
      end: 3,
    })
  })

  test("detects a skill at the start of the input", () => {
    expect(getActiveCompletionTrigger("$skill", 6)).toEqual({
      kind: "skill",
      token: "$skill",
      query: "skill",
      start: 0,
      end: 6,
    })
  })

  test("ignores slash command triggers after the first character", () => {
    expect(getActiveCompletionTrigger("please /co", 10)).toBeNull()
  })

  test("ignores skill triggers after the first character", () => {
    expect(getActiveCompletionTrigger("use $skill", 10)).toBeNull()
  })

  test("ignores triggers in the middle of a word", () => {
    expect(getActiveCompletionTrigger("email/a", 7)).toBeNull()
  })
})

describe("buildChatCompletionItems", () => {
  test("uses slash syntax for Claude skills", () => {
    expect(buildChatCompletionItems({
      provider: "claude",
      triggerKind: "skill",
      query: "test",
      slashCommands: ["/test-runner", "/compact"],
      installedSkills: [{ name: "test-runner", source: "owner/repo" }],
    })).toEqual([
      {
        id: "skill:test-runner",
        kind: "skill",
        label: "test-runner",
        detail: "owner/repo",
        insertText: "/test-runner",
        skillName: "test-runner",
      },
    ])
  })

  test("uses dollar syntax for Codex skills", () => {
    expect(buildChatCompletionItems({
      provider: "codex",
      triggerKind: "skill",
      query: "skill",
      slashCommands: [],
      installedSkills: [{ name: "skill-creator", source: "openai/skills", skillPath: "/tmp/SKILL.md" }],
    })).toEqual([
      {
        id: "skill:skill-creator",
        kind: "skill",
        label: "skill-creator",
        detail: "openai/skills",
        insertText: "$skill-creator",
        skillName: "skill-creator",
        skillPath: "/tmp/SKILL.md",
      },
    ])
  })

  test("uses plugin-qualified syntax for Codex plugin skills", () => {
    expect(buildChatCompletionItems({
      provider: "codex",
      triggerKind: "skill",
      query: "template-bridge",
      slashCommands: [],
      installedSkills: [{
        name: "unified-workflow",
        source: "local",
        pluginName: "template-bridge",
        skillPath: "/tmp/template-bridge/skills/unified-workflow/SKILL.md",
      }],
    })).toEqual([
      {
        id: "skill:template-bridge:unified-workflow",
        kind: "skill",
        label: "template-bridge:unified-workflow",
        detail: "local",
        insertText: "$template-bridge:unified-workflow",
        skillName: "template-bridge:unified-workflow",
        skillPath: "/tmp/template-bridge/skills/unified-workflow/SKILL.md",
      },
    ])
  })

  test("filters slash commands by query", () => {
    const items = buildChatCompletionItems({
      provider: "codex",
      triggerKind: "command",
      query: "co",
      slashCommands: ["/compact", "/help"],
      installedSkills: [],
    })
    expect(items.map((item) => item.insertText)).toEqual(["/compact"])
    expect(items.map((item) => item.label)).toEqual(["compact"])
  })

  test("only offers executable Codex slash commands", () => {
    const items = buildChatCompletionItems({
      provider: "codex",
      triggerKind: "command",
      query: "",
      slashCommands: ["/status", "/compact", "/help"],
      installedSkills: [],
    })
    expect(items.map((item) => item.insertText)).toEqual(["/compact"])
  })

  test("keeps Claude slash commands from the runtime command list", () => {
    const items = buildChatCompletionItems({
      provider: "claude",
      triggerKind: "command",
      query: "",
      slashCommands: ["/status", "/compact", "/help"],
      installedSkills: [],
    })
    expect(items.map((item) => item.insertText)).toEqual(["/compact", "/help", "/status"])
  })

  test("omits an exact slash command match so Enter can submit it", () => {
    expect(buildChatCompletionItems({
      provider: "codex",
      triggerKind: "command",
      query: "compact",
      slashCommands: ["/compact"],
      installedSkills: [],
    })).toEqual([])
  })

  test("omits an exact skill match so Enter can submit it", () => {
    expect(buildChatCompletionItems({
      provider: "codex",
      triggerKind: "skill",
      query: "skill-creator",
      slashCommands: [],
      installedSkills: [{ name: "skill-creator", source: "openai/skills" }],
    })).toEqual([])
  })
})

describe("replaceCompletionToken", () => {
  test("replaces the active token and keeps trailing text", () => {
    expect(replaceCompletionToken({
      value: "run /co now",
      trigger: { kind: "command", token: "/co", query: "co", start: 4, end: 7 },
      insertText: "/compact",
    })).toEqual({
      value: "run /compact now",
      caret: 12,
    })
  })
})
