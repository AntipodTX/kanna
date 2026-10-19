import { Loader2, Search } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  getTrimmedToolEntryIds,
  mergeTranscriptSearchPayloads,
  searchTranscriptEntries,
  type ChatSearchEntryResult,
} from "../../../../shared/chatSearch"
import type { TranscriptEntry } from "../../../../shared/types"
import { useToolPayloadLoader } from "../../../components/messages/tool-payload-context"
import { cn } from "../../../lib/utils"
import { Button } from "../../ui/button"
import {
  WIDGET_STRIP_INPUT_CLASS,
  WidgetError,
  WidgetList,
  WidgetRow,
  WidgetStatic,
  WidgetStrip,
} from "./parts"
import { WidgetCard } from "./WidgetCard"

interface PendingSearch {
  id: number
  query: string
  includeToolEntries: boolean
}

interface SearchResult {
  query: string
  matches: ChatSearchEntryResult[]
}

export function ChatSearchWidget({
  chatId,
  entries,
  localPath,
  ready,
  hasOlderMessages,
  onLoadOlderMessages,
  onJumpToEntry,
}: {
  chatId: string
  entries: readonly TranscriptEntry[]
  localPath?: string | null
  /** True only when `entries` belongs to this exact chat. */
  ready: boolean
  hasOlderMessages: boolean
  onLoadOlderMessages: (options: { all: true }) => Promise<boolean>
  onJumpToEntry: (entryId: string, revealEntryId?: string) => void
}) {
  const loadToolPayloads = useToolPayloadLoader()
  const [query, setQuery] = useState("")
  const [includeToolEntries, setIncludeToolEntries] = useState(false)
  const [pending, setPending] = useState<PendingSearch | null>(null)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [status, setStatus] = useState<"idle" | "loading-history" | "searching">("idle")
  const [error, setError] = useState<string | null>(null)
  const nextRequestIdRef = useRef(0)
  const runningRequestIdRef = useRef<number | null>(null)

  useEffect(() => {
    nextRequestIdRef.current += 1
    runningRequestIdRef.current = null
    setPending(null)
    setResult(null)
    setStatus("idle")
    setError(null)
  }, [chatId])

  useEffect(() => {
    if (ready) return
    nextRequestIdRef.current += 1
    runningRequestIdRef.current = null
    setPending(null)
    setResult(null)
    setStatus("idle")
    setError(null)
  }, [ready])

  useEffect(() => () => {
    nextRequestIdRef.current += 1
  }, [])

  const runSearch = useCallback(async (request: PendingSearch, sourceEntries: readonly TranscriptEntry[]) => {
    try {
      if (request.id !== nextRequestIdRef.current) return
      const payloads = request.includeToolEntries
        ? await loadToolPayloads(getTrimmedToolEntryIds(sourceEntries))
        : []
      if (request.id !== nextRequestIdRef.current) return

      const searchableEntries = request.includeToolEntries
        ? mergeTranscriptSearchPayloads(sourceEntries, payloads)
        : sourceEntries
      setResult({
        query: request.query,
        matches: searchTranscriptEntries(searchableEntries, request.query, {
          chatId,
          localPath,
          includeToolEntries: request.includeToolEntries,
        }),
      })
      setError(null)
    } catch (caught) {
      if (request.id !== nextRequestIdRef.current) return
      setResult(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request.id === nextRequestIdRef.current) {
        runningRequestIdRef.current = null
        setPending(null)
        setStatus("idle")
      }
    }
  }, [chatId, loadToolPayloads, localPath])

  // `chat.loadOlder({ all: true })` pushes the widened snapshot before it
  // acknowledges. Waiting for hasOlderMessages to clear guarantees that this
  // search indexes the new entries rather than the callback's previous props.
  useEffect(() => {
    if (!ready || !pending || hasOlderMessages || runningRequestIdRef.current === pending.id) return
    runningRequestIdRef.current = pending.id
    setStatus("searching")
    void runSearch(pending, entries)
  }, [entries, hasOlderMessages, pending, ready, runSearch])

  async function submitSearch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const trimmedQuery = query.trim()
    if (!ready || !trimmedQuery || status !== "idle") return

    const request: PendingSearch = {
      id: nextRequestIdRef.current + 1,
      query: trimmedQuery,
      includeToolEntries,
    }
    nextRequestIdRef.current = request.id
    runningRequestIdRef.current = null
    setPending(request)
    setResult(null)
    setError(null)

    if (!hasOlderMessages) {
      setStatus("searching")
      return
    }

    setStatus("loading-history")
    const loaded = await onLoadOlderMessages({ all: true })
    if (request.id !== nextRequestIdRef.current || loaded) return
    setPending(null)
    setStatus("idle")
    setError("Unable to load the full chat history.")
  }

  const matches = result?.matches ?? []
  const trimmedQuery = query.trim()
  const isBusy = !ready || status !== "idle"
  const liveStatus = !ready
    ? "Loading chat…"
    : error
      ? ""
      : status === "loading-history"
        ? "Loading full chat history…"
        : status === "searching"
          ? "Searching…"
          : result
            ? `${matches.length} match${matches.length === 1 ? "" : "es"}`
            : ""

  return (
    <div aria-busy={isBusy}>
      <WidgetCard
        icon={<Search />}
        title="Search Chat"
        count={result ? matches.length : undefined}
      >
      <div className="sr-only" role="status" aria-live="polite">{liveStatus}</div>
      <WidgetStrip
        field
        leading={status === "idle" ? <Search /> : <Loader2 className="animate-spin" />}
        form={{ onSubmit: submitSearch }}
        trailing={(
          <Button
            type="submit"
            variant="ghost"
            size="none"
            disabled={!trimmedQuery || isBusy}
            className="h-6 rounded-md px-2 text-xs text-muted-foreground hover:!bg-transparent hover:text-foreground"
          >
            Search
          </Button>
        )}
      >
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search current chat"
          aria-label="Search current chat"
          disabled={isBusy}
          className={WIDGET_STRIP_INPUT_CLASS}
        />
      </WidgetStrip>
      <label className="flex min-h-8 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={includeToolEntries}
          onChange={(event) => setIncludeToolEntries(event.target.checked)}
          disabled={isBusy}
          className="size-3.5 accent-foreground"
        />
        <span>Include tool calls and results</span>
      </label>
      {error ? (
        <WidgetStatic className="pt-0">
          <div role="alert"><WidgetError>{error}</WidgetError></div>
        </WidgetStatic>
      ) : null}
      {!error && !ready ? (
        <WidgetStatic className="pt-1 text-sm text-muted-foreground">Loading chat…</WidgetStatic>
      ) : null}
      {!error && ready && status === "loading-history" ? (
        <WidgetStatic className="pt-1 text-sm text-muted-foreground">Loading full chat history…</WidgetStatic>
      ) : null}
      {!error && ready && status === "searching" ? (
        <WidgetStatic className="pt-1 text-sm text-muted-foreground">Searching…</WidgetStatic>
      ) : null}
      {!error && ready && status === "idle" && result ? (
        matches.length > 0 ? (
          <WidgetList className="max-h-96 overflow-y-auto border-t border-border">
            {matches.map((match) => (
              <WidgetRow
                key={match.entryId}
                icon={<Search />}
                title={<span className="line-clamp-2">{match.preview}</span>}
                subtitle={formatEntryKind(match.kind)}
                meta={`${match.matchCount} match${match.matchCount === 1 ? "" : "es"}`}
                onActivate={() => onJumpToEntry(match.targetEntryId, match.revealEntryId)}
              />
            ))}
          </WidgetList>
        ) : (
          <WidgetStatic className="border-t border-border text-sm text-muted-foreground">No matches</WidgetStatic>
        )
      ) : null}
      {!error && ready && status === "idle" && !result ? (
        <WidgetStatic className={cn("border-t border-border text-sm text-muted-foreground", "py-2.5")}>
          Search the full current chat history
        </WidgetStatic>
      ) : null}
      </WidgetCard>
    </div>
  )
}

function formatEntryKind(kind: ChatSearchEntryResult["kind"]) {
  return kind.replace(/_/g, " ")
}
