import { useEffect, useRef, useState, type UIEvent } from "react"
import { Loader2, Search, X } from "lucide-react"
import type { ProjectChatSearchCommandResult, ProjectChatSearchEntryResult } from "../../shared/chatSearch"
import { Button } from "../components/ui/button"
import { cn } from "../lib/utils"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "./chatFocusPolicy"

export interface ProjectChatSearchPopoverProps {
  open: boolean
  projectTitle: string
  disabled: boolean
  onClose: () => void
  initialResult?: ProjectChatSearchCommandResult | null
  onSearch: (query: string, includeArchived: boolean, cursor?: string) => Promise<ProjectChatSearchCommandResult>
  onSelectResult: (result: ProjectChatSearchEntryResult) => Promise<void>
}

type SearchInputLike = {
  focus: (options?: FocusOptions) => void
}

function focusProjectChatSearchInput(input: SearchInputLike | null) {
  input?.focus({ preventScroll: true })
}

export function ProjectChatSearchPopover({
  open,
  projectTitle,
  disabled,
  onClose,
  initialResult = null,
  onSearch,
  onSelectResult,
}: ProjectChatSearchPopoverProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState("")
  const [includeArchived, setIncludeArchived] = useState(false)
  const [result, setResult] = useState<ProjectChatSearchCommandResult | null>(initialResult)
  const [resultIncludeArchived, setResultIncludeArchived] = useState(false)
  const [status, setStatus] = useState<"idle" | "searching" | "loading-more" | "loading-target">("idle")
  const [error, setError] = useState<string | null>(null)
  const trimmedQuery = query.trim()
  const matches = result?.matches ?? []
  const isBusy = status !== "idle"
  const resultMatchesCurrentSearch = Boolean(result && result.query === trimmedQuery && resultIncludeArchived === includeArchived)
  const canLoadMore = Boolean(resultMatchesCurrentSearch && result?.hasMore && result.nextCursor)

  useEffect(() => {
    if (!open) return
    const frameId = window.requestAnimationFrame(() => focusProjectChatSearchInput(inputRef.current))
    return () => window.cancelAnimationFrame(frameId)
  }, [open])

  useEffect(() => {
    if (!open) return

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      event.preventDefault()
      onClose()
    }

    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [onClose, open])

  useEffect(() => {
    if (!open || !canLoadMore || isBusy) return
    const frameId = window.requestAnimationFrame(() => {
      const resultsElement = resultsRef.current
      if (!resultsElement) return
      if (resultsElement.scrollHeight - resultsElement.clientHeight - resultsElement.scrollTop <= 48) {
        void loadMoreResults()
      }
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [canLoadMore, isBusy, matches.length, open])

  if (!open) return null

  async function submitSearch() {
    if (!trimmedQuery || disabled || isBusy) return
    setStatus("searching")
    setError(null)
    try {
      setResult(await onSearch(trimmedQuery, includeArchived))
      setResultIncludeArchived(includeArchived)
    } catch (searchError) {
      setResult(null)
      setError(searchError instanceof Error ? searchError.message : String(searchError))
    } finally {
      setStatus("idle")
    }
  }

  async function loadMoreResults() {
    if (!trimmedQuery || disabled || isBusy || !canLoadMore || !result?.nextCursor) return
    setStatus("loading-more")
    setError(null)
    try {
      const nextResult = await onSearch(trimmedQuery, resultIncludeArchived, result.nextCursor)
      setResult({
        ...nextResult,
        matches: [...matches, ...nextResult.matches],
      })
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError))
    } finally {
      setStatus("idle")
    }
  }

  function handleResultsScroll(event: UIEvent<HTMLDivElement>) {
    if (!canLoadMore || isBusy) return
    const target = event.currentTarget
    const distanceFromBottom = target.scrollHeight - target.clientHeight - target.scrollTop
    if (distanceFromBottom <= 48) {
      void loadMoreResults()
    }
  }

  async function selectResult(searchResult: ProjectChatSearchEntryResult) {
    if (isBusy) return
    setStatus("loading-target")
    setError(null)
    try {
      await onSelectResult(searchResult)
      onClose()
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError))
    } finally {
      setStatus("idle")
    }
  }

  return (
    <div
      {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
      className="absolute inset-0 z-[70] flex items-center justify-center px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Search ${projectTitle}`}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-transparent"
        aria-label="Close Project Search"
        onClick={onClose}
      />
      <div
        data-project-search-panel
        className="relative flex max-h-[min(720px,calc(100%-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">Search {projectTitle}</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 !rounded"
            aria-label="Close Project Search"
            title="Close Project Search"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void submitSearch()
              }
            }}
            placeholder="Search all chats in this project"
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
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
            className="h-3.5 w-3.5 accent-foreground"
          />
          <span>Include archived chats</span>
        </label>

        <div ref={resultsRef} className="min-h-[180px] flex-1 overflow-y-auto p-2" onScroll={handleResultsScroll}>
          {error ? (
            <div className="px-2 py-2 text-sm text-destructive">{error}</div>
          ) : null}
          {!error && result ? (
            matches.length > 0 ? (
              <div className="flex flex-col gap-1">
                {matches.map((match) => (
                  <button
                    key={`${match.chatId}:${match.entryId}`}
                    type="button"
                    onClick={() => void selectResult(match)}
                    className={cn(
                      "w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-muted",
                      status === "loading-target" && "opacity-70"
                    )}
                  >
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{match.chatTitle}</span>
                        {match.isArchived ? (
                          <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Archived
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0">{match.matchCount} match{match.matchCount === 1 ? "" : "es"}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-sm text-foreground">{match.preview}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{formatEntryKind(match.kind)}</div>
                  </button>
                ))}
                {status === "loading-more" ? (
                  <div className="flex justify-center px-2 py-3 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">No matches</div>
            )
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">Search all chats in this project</div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatEntryKind(kind: ProjectChatSearchEntryResult["kind"]) {
  return kind.replace(/_/g, " ")
}
