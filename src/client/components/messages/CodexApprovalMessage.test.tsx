import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  CodexApprovalToolResult,
  HydratedCodexApprovalToolCall,
} from "../../../shared/types"
import { CodexApprovalMessage } from "./CodexApprovalMessage"

function renderApproval(
  input: HydratedCodexApprovalToolCall["input"],
  result?: CodexApprovalToolResult,
) {
  const message: HydratedCodexApprovalToolCall = {
    id: "approval-1",
    kind: "tool",
    toolKind: "codex_approval",
    toolName: "CodexApproval",
    toolId: "mcp:serena:mcp-approval-1:approval",
    input,
    result,
    timestamp: new Date().toISOString(),
  }

  return renderToStaticMarkup(
    <CodexApprovalMessage
      message={message}
      onDecision={() => undefined}
      isLatest={true}
    />
  )
}

test("renders MCP tool approval details and advertised persistence actions", () => {
  const html = renderApproval({
    approvalKind: "mcp_tool_call",
    serverName: "serena",
    message: "Allow Serena to write this project memory?",
    toolName: "write_memory",
    toolTitle: "Write memory",
    toolDescription: "Write a Serena project memory",
    toolParams: { memory_name: "tech_stack" },
    persistModes: ["session", "always"],
  })

  expect(html).toContain("Approve MCP tool")
  expect(html).toContain("Allow Serena to write this project memory?")
  expect(html).toContain("serena")
  expect(html).toContain("Write memory")
  expect(html).toContain("Write a Serena project memory")
  expect(html).toContain("memory_name")
  expect(html).toContain("tech_stack")
  expect(html).toContain("Approve for session")
  expect(html).toContain("Always allow")
  expect(html).toContain("Cancel")
})

test("hides MCP persistence actions that were not advertised", () => {
  const html = renderApproval({
    approvalKind: "mcp_tool_call",
    serverName: "serena",
    message: "Allow Serena to read memory?",
    toolName: "read_memory",
    persistModes: [],
  })

  expect(html).not.toContain("Approve for session")
  expect(html).not.toContain("Always allow")
  expect(html).toContain("Approve")
  expect(html).toContain("Cancel")
})

test("renders completed always-allow MCP approvals", () => {
  const html = renderApproval({
    approvalKind: "mcp_tool_call",
    serverName: "serena",
    message: "Allow Serena to write memory?",
    toolName: "write_memory",
    persistModes: ["always"],
  }, {
    decision: "acceptAlways",
  })

  expect(html).toContain("Always approved")
})
