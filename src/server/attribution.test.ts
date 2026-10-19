import { describe, expect, test } from "bun:test"
import {
  KANNA_COMMIT_FOOTER,
  KANNA_COMMIT_TRAILER,
  appendKannaAttribution,
  buildKannaCommitAttribution,
  hasKannaFooter,
  hasKannaTrailer,
} from "./attribution"

describe("hasKannaTrailer", () => {
  test("detects the trailer on its own line", () => {
    expect(hasKannaTrailer(`fix: thing\n\n${KANNA_COMMIT_TRAILER}`)).toBe(true)
  })

  test("is case-insensitive on the trailer token", () => {
    expect(hasKannaTrailer("fix: thing\n\nco-authored-by: Kanna <noreply@kanna.sh>")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasKannaTrailer("document the Co-Authored-By: Kanna <noreply@kanna.sh> trailer")).toBe(false)
  })

  test("does not match another tool's trailer", () => {
    expect(hasKannaTrailer("fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe(false)
  })
})

describe("hasKannaFooter", () => {
  test("detects the footer line", () => {
    expect(hasKannaFooter(`fix: thing\n\n${KANNA_COMMIT_FOOTER}`)).toBe(true)
  })

  test("detects it without the emoji", () => {
    expect(hasKannaFooter("fix: thing\n\nShipped with Kanna — https://kanna.sh")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasKannaFooter("this release was shipped with Kanna and other tools")).toBe(false)
  })
})

describe("buildKannaCommitAttribution", () => {
  test("returns both parts for a bare message", () => {
    expect(buildKannaCommitAttribution("fix: thing")).toBe(`${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)
  })

  test("returns only the missing part", () => {
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_FOOTER}`)).toBe(KANNA_COMMIT_TRAILER)
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_TRAILER}`)).toBe(KANNA_COMMIT_FOOTER)
  })

  test("returns null when fully attributed", () => {
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)).toBeNull()
  })
})

describe("appendKannaAttribution", () => {
  test("appends footer then trailer, trailer last", () => {
    expect(appendKannaAttribution("fix: thing")).toBe(
      `fix: thing\n\n${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`
    )
  })

  test("is idempotent", () => {
    const once = appendKannaAttribution("fix: thing")
    expect(appendKannaAttribution(once)).toBe(once)
  })

  test("handles an empty message", () => {
    expect(appendKannaAttribution("   ")).toBe(`${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)
  })
})
