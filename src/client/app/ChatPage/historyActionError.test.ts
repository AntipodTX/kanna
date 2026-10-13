import { expect, test } from "bun:test"
import { getHistoryActionError, getHistoryRepairNotice } from "./historyActionError"

const gap = { messageId: "b", error: "Edit and resend the first unsynchronized message" }

test("retained absent messages do not produce a blocking warning on local action refresh", () => {
  expect(getHistoryActionError({ actions: { a: "ordinary", b: "ordinary", c: "ordinary" }, gap, messages: { b: "missing" } })).toBeNull()
})

test("recovering a usable target does not show an unrelated saved missing-message warning", () => {
  expect(getHistoryActionError({ actions: { a: "ordinary", b: "ordinary" }, gap, messages: { b: "missing" } }, "a")).toBeNull()
  expect(getHistoryActionError({ actions: { b: "merge-turn" }, gap, messages: { b: "missing" } }, "b")).toBeNull()
})

test("an unknown gap still explains why its boundary cannot be recovered", () => {
  expect(getHistoryActionError({ actions: { a: "ordinary", b: "recover" }, gap })).toBe(gap.error)
  expect(getHistoryActionError({ actions: { b: "recover" }, gap, messages: { b: "unknown" } }, "b")).toBe(gap.error)
})

test("an unusable selected boundary retains its error even when absence is known", () => {
  expect(getHistoryActionError({ actions: { b: "recover" }, gap, messages: { b: "missing" } }, "b")).toBe(gap.error)
  expect(getHistoryActionError({ actions: {} }, "b")).toBe("The selected message's Codex boundary could not be established")
})

test("a current operation error takes precedence over an earlier completed history notice", () => {
  expect(getHistoryRepairNotice({ phase: "done", message: "History checked" }, "Codex unavailable", false)).toBe("Codex unavailable")
})

test("an active check keeps its progress notice and a completed check can show its result", () => {
  expect(getHistoryRepairNotice({ phase: "running", message: "Checking history" }, "Previous error", false)).toBe("Checking history")
  expect(getHistoryRepairNotice(undefined, null, true)).toBe("Checking message correspondence with Codex…")
  expect(getHistoryRepairNotice({ phase: "done", message: "History checked" }, null, false)).toBe("History checked")
})
