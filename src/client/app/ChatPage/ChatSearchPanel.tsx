import { useEffect, useRef, useState } from "react"
import { Loader2, Search } from "lucide-react"
import type { ChatSearchCommandResult, ChatSearchEntryResult } from "../../../shared/chatSearch"
import { Button } from "../../components/ui/button"
import { cn } from "../../lib/utils"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../chatFocusPolicy"

interface ChatSearchPanelProps {
  open: boolean
  disabled: boolean
  onClose: () => void
  onSearch: (query: string, includeToolEntries: boolean) => Promise<ChatSearchCommandResult>
  onSelectResult: (result: ChatSearchEntryResult) => Promise<void>
}

type SearchInputLike = {
  focus: (options?: FocusOptions) => void
}

export function focusChatSearchInput(input: SearchInputLike | null) {
  input?.focus({ preventScroll: true })
}

export function ChatSearchPanel({
  open,
  disabled,
  onClose,
  onSearch,
  onSelectResult,
}: ChatSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState("")
  const [includeToolEntries, setIncludeToolEntries] = useState(false)
  const [result, setResult] = useState<ChatSearchCommandResult | null>(null)
  const [status, setStatus] = useState<"idle" | "searching" | "loading-target">("idle")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const frameId = window.requestAnimationFrame(() => focusChatSearchInput(inputRef.current))
    return () => window.cancelAnimationFrame(frameId)
  }, [open])

  if (!open) return null

  const trimmedQuery = query.trim()
  const matches = result?.matches ?? []
  const isBusy = status !== "idle"

  async function submitSearch() {
    if (!trimmedQuery || disabled || isBusy) return
    setStatus("searching")
    setError(null)
    try {
      setResult(await onSearch(trimmedQuery, includeToolEntries))
    } catch (searchError) {
      setResult(null)
      setError(searchError instanceof Error ? searchError.message : String(searchError))
    } finally {
      setStatus("idle")
    }
  }

  async function selectResult(searchResult: ChatSearchEntryResult) {
    if (isBusy) return
    setStatus("loading-target")
    setError(null)
    try {
      await onSelectResult(searchResult)
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError))
    } finally {
      setStatus("idle")
    }
  }

  return (
    <div
      {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
      data-state="open"
      className="h-full min-h-0 border-l border-border bg-background md:min-w-[370px]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-[49px] shrink-0 items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void submitSearch()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                onClose()
              }
            }}
            placeholder="Search current chat"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Button
            variant="ghost"
            size="none"
            onClick={() => void submitSearch()}
            disabled={!trimmedQuery || disabled || isBusy}
            className="h-8 px-2 text-xs disabled:opacity-50"
          >
            {status === "searching" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Search"}
          </Button>
        </div>
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeToolEntries}
            onChange={(event) => setIncludeToolEntries(event.target.checked)}
            className="h-3.5 w-3.5 accent-foreground"
          />
          <span>Include tool calls and results</span>
        </label>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {error ? (
            <div className="px-2 py-2 text-sm text-destructive">{error}</div>
          ) : null}
          {!error && result ? (
            matches.length > 0 ? (
              <div className="flex flex-col gap-1">
                {matches.map((match) => (
                  <button
                    key={match.entryId}
                    type="button"
                    onClick={() => void selectResult(match)}
                    className={cn(
                      "w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted",
                      status === "loading-target" && "opacity-70"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">{formatEntryKind(match.kind)}</span>
                      <span className="shrink-0">{match.matchCount} match{match.matchCount === 1 ? "" : "es"}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm text-foreground">{match.preview}</div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">No matches</div>
            )
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">Search the full current chat history</div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatEntryKind(kind: ChatSearchEntryResult["kind"]) {
  return kind.replace(/_/g, " ")
}
