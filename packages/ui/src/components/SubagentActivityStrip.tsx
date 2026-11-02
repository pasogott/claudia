import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import type { SubagentInfo } from "../hooks/useChatGateway";
import { Link } from "../router";

interface SubagentActivityStripProps {
  subagents: SubagentInfo[];
  /**
   * Where a subagent's own session lives, for clients with routes (the web).
   * Without it the strip shows the preview only.
   */
  subagentHref?: (subagentId: string) => string;
}

function shortSubagentId(subagentId: string): string {
  return subagentId.length > 16 ? `${subagentId.slice(0, 16)}...` : subagentId;
}

function formatAgo(value?: string): string {
  if (!value) return "now";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 1_000) return "now";
  const elapsedSec = Math.floor(elapsedMs / 1_000);
  if (elapsedSec < 60) return `${elapsedSec}s ago`;
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const elapsedHr = Math.floor(elapsedMin / 60);
  if (elapsedHr < 24) return `${elapsedHr}h ago`;
  const elapsedDay = Math.floor(elapsedHr / 24);
  return `${elapsedDay}d ago`;
}

function statusLabel(status: SubagentInfo["status"]): string {
  if (status === "running") return "Busy";
  if (status === "completed") return "Done";
  if (status === "interrupted") return "Stopped";
  return "Failed";
}

function statusClasses(status: SubagentInfo["status"]): string {
  if (status === "running") {
    return "bg-orange-500";
  }
  if (status === "failed") {
    return "bg-red-500";
  }
  return "bg-emerald-500";
}

/** "2 running · 1 failed · 5 done": the counts that matter, busiest first. */
export function subagentSummary(subagents: SubagentInfo[]): string {
  const count = (status: SubagentInfo["status"]) =>
    subagents.filter((s) => s.status === status).length;
  const parts = [
    [count("running"), "running"],
    [count("failed"), "failed"],
    [count("interrupted"), "stopped"],
    [count("completed"), "done"],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

/**
 * The parent session's subagents, behind one bar.
 *
 * Collapsed by default: a session that delegates a lot can have dozens, and a
 * list of cards that size takes over the chat. The bar carries the counts and
 * a pulsing dot while any are busy; opening it lists every subagent (newest
 * work first, as the server sends them), each expandable, in a scrolling panel.
 */
export function SubagentActivityStrip({ subagents, subagentHref }: SubagentActivityStripProps) {
  const [open, setOpen] = useState(false);
  const [expandedSubagentId, setExpandedSubagentId] = useState<string | null>(null);

  if (subagents.length === 0) return null;
  const anyRunning = subagents.some((s) => s.status === "running");

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/70 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-zinc-400 transition-colors hover:text-zinc-200"
      >
        <Bot className="size-3.5 shrink-0" />
        <span className="font-medium text-zinc-300">
          {subagents.length === 1 ? "1 subagent" : `${subagents.length} subagents`}
        </span>
        {anyRunning && (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-orange-500" />
        )}
        <span className="truncate text-zinc-500">{subagentSummary(subagents)}</span>
        {open ? (
          <ChevronUp className="ml-auto size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="ml-auto size-3.5 shrink-0" />
        )}
      </button>
      {open && (
        <div className="mt-1.5 max-h-72 space-y-2 overflow-y-auto pb-1">
          {subagents.map((subagent) => {
            const expanded = expandedSubagentId === subagent.subagentId;
            const preview =
              subagent.previewText || subagent.error || subagent.prompt || "Waiting for output...";
            return (
              <div
                key={subagent.subagentId}
                className="rounded-lg border border-zinc-800 bg-zinc-900/80"
              >
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left transition-colors hover:bg-zinc-800/50"
                  onClick={() =>
                    setExpandedSubagentId((prev) =>
                      prev === subagent.subagentId ? null : subagent.subagentId,
                    )
                  }
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2.5 shrink-0 rounded-full ${statusClasses(subagent.status)} ${
                        subagent.status === "running" ? "animate-pulse" : ""
                      }`}
                    />
                    <span className="text-xs font-medium text-zinc-100">
                      {shortSubagentId(subagent.subagentId)}
                    </span>
                    <span className="text-xs text-zinc-400">{subagent.agent}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                      {subagent.purpose}
                    </span>
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-zinc-400">
                      {statusLabel(subagent.status)}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {formatAgo(subagent.updatedAt || subagent.startedAt)}
                    </span>
                    {expanded ? (
                      <ChevronUp className="size-3.5 text-zinc-500" />
                    ) : (
                      <ChevronDown className="size-3.5 text-zinc-500" />
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-300">{preview}</p>
                </button>
                {expanded && (
                  <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-300">
                    {subagent.prompt && (
                      <p className="mb-2 line-clamp-3 text-zinc-400">
                        Prompt: <span className="text-zinc-200">{subagent.prompt}</span>
                      </p>
                    )}
                    {subagent.previewText && (
                      <p className="mb-2 whitespace-pre-wrap break-words text-zinc-200">
                        {subagent.previewText}
                      </p>
                    )}
                    {subagent.cwd && (
                      <p className="truncate text-zinc-500">
                        CWD: <span className="text-zinc-300">{subagent.cwd}</span>
                      </p>
                    )}
                    {subagentHref && (
                      <Link
                        to={subagentHref(subagent.subagentId)}
                        className="mt-2 inline-flex items-center gap-1 text-blue-400 hover:underline"
                      >
                        Open session
                        <ExternalLink className="size-3" />
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
