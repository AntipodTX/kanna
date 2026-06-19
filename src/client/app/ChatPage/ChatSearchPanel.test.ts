import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatSearchPanel, focusChatSearchInput } from "./ChatSearchPanel"

describe("focusChatSearchInput", () => {
  test("focuses the search input without scrolling the chat transcript", () => {
    const focusCalls: FocusOptions[] = []

    focusChatSearchInput({
      focus: (options?: FocusOptions) => {
        focusCalls.push(options ?? {})
      },
    })

    expect(focusCalls).toEqual([{ preventScroll: true }])
  })

  test("ignores a missing input", () => {
    expect(() => focusChatSearchInput(null)).not.toThrow()
  })
})

describe("ChatSearchPanel", () => {
  test("renders tool entry search as an unchecked option", () => {
    const html = renderToStaticMarkup(createElement(ChatSearchPanel, {
      open: true,
      disabled: false,
      onClose: () => undefined,
      onSearch: async (query: string) => ({ query, matches: [] }),
      onSelectResult: async () => undefined,
    }))

    expect(html).toContain("Include tool calls and results")
    expect(html).toContain("type=\"checkbox\"")
    expect(html).not.toContain("checked=\"\"")
  })
})
