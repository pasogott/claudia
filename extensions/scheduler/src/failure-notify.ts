/**
 * Tell Michael when a scheduled task breaks, and when it recovers.
 *
 * A failure that only lands in the execution history is invisible: Wings
 * failed every morning for weeks on Anima Sedes before anyone looked. So a
 * finished run is compared with the task's earlier finished runs, and only
 * the transitions are news:
 *
 *   the Nth error in a row (N = alertAfterFailures, default 1)   "failed"
 *   a success after an alerted streak                            "recovered"
 *
 * Not every failure: the lights task runs every five minutes, and a broken one
 * would otherwise text him all night. A task can also wait for several failed
 * runs in a row (`alertAfterFailures`) before it says anything, for flaky
 * things like a light on weak Wi-Fi.
 */

import type { ExtensionContext } from "@anima/shared";

export type Transition = "failed" | "recovered";

/** How many runs at the front of `outcomes` failed in a row. */
function errorStreak(outcomes: string[]): number {
  const firstOk = outcomes.findIndex((o) => o !== "error");
  return firstOk === -1 ? outcomes.length : firstOk;
}

/**
 * `outcomes` are the task's finished runs, newest first, the run that just
 * ended included. A failure is news once, when the streak reaches
 * `alertAfter`; recovery is news only if that alert went out.
 */
export function transitionFor(outcomes: string[], alertAfter: number): Transition | null {
  const [current, ...earlier] = outcomes;
  if (current === "error") return errorStreak(outcomes) === alertAfter ? "failed" : null;
  if (current === "success") return errorStreak(earlier) >= alertAfter ? "recovered" : null;
  return null;
}

/** First line of an error, trimmed to what fits in a text message. */
function headline(error: string): string {
  const line =
    error
      .replace(/^Error:\s*/, "")
      .split("\n")[0]
      ?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

export async function notifyTransition(
  ctx: ExtensionContext,
  task: { id: string; name: string },
  transition: Transition,
  error?: string,
): Promise<void> {
  const message =
    transition === "failed"
      ? `Scheduled task "${task.name}" failed${error ? `: ${headline(error)}` : "."}\nanima scheduler get_history --taskId ${task.id}`
      : `Scheduled task "${task.name}" is working again.`;
  try {
    await ctx.call("notify.send", {
      title: transition === "failed" ? "Task failed" : "Task recovered",
      message,
      source: "scheduler",
    });
  } catch (err) {
    // Best effort: a host without the notify extension still runs its tasks.
    ctx.log.warn("Could not send task notification", {
      task: task.name,
      transition,
      error: String(err),
    });
  }
}
