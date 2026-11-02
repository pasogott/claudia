/**
 * HandoffLinks — the thin strip above a chat that belongs to a handoff chain.
 *
 * A session that handed off (`session.handoff`) points forward to the one that
 * took over; the one that took over points back. Both read from the session
 * list rows, so the strip appears as soon as the nav knows about the link.
 */

import { Link, type SessionInfo } from "@anima/ui";
import { ArrowLeft, ArrowRight } from "lucide-react";

function label(sessionId: string, sessions: SessionInfo[]): string {
  const session = sessions.find((s) => s.sessionId === sessionId);
  return session?.title || session?.firstPrompt || `session ${sessionId.slice(0, 8)}`;
}

export function HandoffLinks({
  workspaceId,
  sessionId,
  sessions,
}: {
  workspaceId: string;
  sessionId: string;
  sessions: SessionInfo[];
}) {
  const current = sessions.find((s) => s.sessionId === sessionId);
  const previous = current?.previousSessionId;
  const next = current?.handedOffTo;
  if (!previous && !next) return null;

  const linkClass = "inline-flex min-w-0 items-center gap-1 text-blue-700 hover:underline";
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-1.5 text-xs text-gray-600">
      {previous ? (
        <Link to={`/chat/${workspaceId}/${previous}`} className={linkClass}>
          <ArrowLeft className="h-3 w-3 shrink-0" />
          <span className="truncate">Continued from {label(previous, sessions)}</span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link to={`/chat/${workspaceId}/${next}`} className={linkClass}>
          <span className="truncate">Continued in {label(next, sessions)}</span>
          <ArrowRight className="h-3 w-3 shrink-0" />
        </Link>
      )}
    </div>
  );
}
