/**
 * Attribution for commits created directly by Kanna's git sidebar.
 * Agent prompts carry no Kanna attribution instructions.
 */

export const KANNA_COMMIT_TRAILER = "Co-Authored-By: Kanna <noreply@kanna.sh>"

export const KANNA_COMMIT_FOOTER = "🌸 Shipped with Kanna — https://kanna.sh"

/**
 * Both matchers are line-anchored so a mention inside prose (a commit that
 * documents the attribution, say) never counts as the attribution itself. The
 * trailer token is matched case-insensitively: git writes `Co-authored-by`,
 * agents tend to write `Co-Authored-By`, and either should suppress a duplicate.
 */
const KANNA_TRAILER_PATTERN = /^co-authored-by:\s*kanna\s*<noreply@kanna\.sh>$/i
const KANNA_FOOTER_PATTERN = /^\u{1F338}?\s*shipped with kanna\b.*$/iu

function matchesLine(message: string, pattern: RegExp): boolean {
  return message.split("\n").some((line) => pattern.test(line.trim()))
}

export function hasKannaTrailer(message: string): boolean {
  return matchesLine(message, KANNA_TRAILER_PATTERN)
}

export function hasKannaFooter(message: string): boolean {
  return matchesLine(message, KANNA_FOOTER_PATTERN)
}

/**
 * The attribution block missing from `message`, or null when it already carries
 * both parts. Each part is checked independently so a half-attributed message
 * gains only what it lacks. Never emits an agent trailer: the only caller is
 * the git sidebar, where no agent wrote the commit.
 */
export function buildKannaCommitAttribution(message: string): string | null {
  const parts: string[] = []
  if (!hasKannaFooter(message)) parts.push(KANNA_COMMIT_FOOTER)
  if (!hasKannaTrailer(message)) parts.push(KANNA_COMMIT_TRAILER)
  return parts.length > 0 ? parts.join("\n\n") : null
}

/** Idempotent: appends whatever attribution is missing as trailing paragraphs. */
export function appendKannaAttribution(message: string): string {
  const trimmed = message.trim()
  const attribution = buildKannaCommitAttribution(trimmed)
  if (!attribution) return trimmed
  return trimmed.length > 0 ? `${trimmed}\n\n${attribution}` : attribution
}
