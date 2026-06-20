import { CODEX_SLASH_COMMANDS, type AgentProvider, type InstalledSkillSummary } from "../../shared/types"

export type CompletionTriggerKind = "command" | "skill"

export interface CompletionTrigger {
  kind: CompletionTriggerKind
  token: string
  query: string
  start: number
  end: number
}

export interface ChatCompletionItem {
  id: string
  kind: CompletionTriggerKind
  label: string
  detail?: string
  insertText: string
  skillName?: string
  skillPath?: string
}

const TRIGGER_BY_PREFIX: Record<string, CompletionTriggerKind> = {
  "/": "command",
  "$": "skill",
}

function normalizeCommand(command: string) {
  const trimmed = command.trim()
  if (!trimmed) return ""
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.toLowerCase())
}

function isExactQuery(value: string, query: string) {
  return value.toLowerCase() === query.toLowerCase()
}

function getCodexSkillMentionName(skill: Pick<InstalledSkillSummary, "name" | "pluginName">) {
  return skill.pluginName ? `${skill.pluginName}:${skill.name}` : skill.name
}

export function getActiveCompletionTrigger(value: string, caret: number): CompletionTrigger | null {
  const boundedCaret = Math.max(0, Math.min(value.length, caret))
  const tokenStart = value.slice(0, boundedCaret).search(/[^\s]*$/u)
  if (tokenStart !== 0) return null

  const token = value.slice(tokenStart, boundedCaret)
  const prefix = token[0]
  if (!prefix || !(prefix in TRIGGER_BY_PREFIX)) {
    return null
  }

  return {
    kind: TRIGGER_BY_PREFIX[prefix],
    token,
    query: token.slice(1),
    start: tokenStart,
    end: boundedCaret,
  }
}

export function buildChatCompletionItems(args: {
  provider: AgentProvider
  triggerKind: CompletionTriggerKind
  query: string
  slashCommands: string[]
  installedSkills: Pick<InstalledSkillSummary, "name" | "source" | "skillPath" | "pluginName">[]
}): ChatCompletionItem[] {
  if (args.triggerKind === "command") {
    const commands = args.provider === "codex"
      ? args.slashCommands.filter((command) => CODEX_SLASH_COMMANDS.includes(normalizeCommand(command) as typeof CODEX_SLASH_COMMANDS[number]))
      : args.slashCommands

    return [...new Set(commands.map(normalizeCommand).filter(Boolean))]
      .filter((command) => matchesQuery(command.slice(1), args.query))
      .filter((command) => !isExactQuery(command.slice(1), args.query))
      .sort((a, b) => a.localeCompare(b))
      .map((command) => ({
        id: `command:${command}`,
        kind: "command",
        label: command.slice(1),
        insertText: command,
      }))
  }

  return args.installedSkills
    .map((skill) => {
      const mentionName = args.provider === "codex" ? getCodexSkillMentionName(skill) : skill.name
      return { skill, mentionName }
    })
    .filter(({ mentionName }) => matchesQuery(mentionName, args.query))
    .filter(({ mentionName }) => !isExactQuery(mentionName, args.query))
    .sort((a, b) => a.mentionName.localeCompare(b.mentionName))
    .map((skill) => ({
      id: `skill:${skill.mentionName}`,
      kind: "skill",
      label: skill.mentionName,
      detail: skill.skill.source || skill.skill.pluginName || undefined,
      insertText: args.provider === "claude" ? `/${skill.skill.name}` : `$${skill.mentionName}`,
      skillName: skill.mentionName,
      skillPath: skill.skill.skillPath,
    }))
}

export function replaceCompletionToken(args: {
  value: string
  trigger: CompletionTrigger
  insertText: string
}) {
  const value = `${args.value.slice(0, args.trigger.start)}${args.insertText}${args.value.slice(args.trigger.end)}`
  return {
    value,
    caret: args.trigger.start + args.insertText.length,
  }
}
