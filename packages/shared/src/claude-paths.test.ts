import { describe, expect, test } from "bun:test";
import { claudeProjectSlug } from "./claude-paths";

describe("claudeProjectSlug", () => {
  test("matches Claude Code's folder naming", () => {
    expect(claudeProjectSlug("/Users/michael/Projects/iamclaudia-ai/anima")).toBe(
      "-Users-michael-Projects-iamclaudia-ai-anima",
    );
    expect(claudeProjectSlug("/Users/me/.hammerspoon")).toBe("-Users-me--hammerspoon");
    expect(claudeProjectSlug("/Users/me/swarm.worktrees/kiliman/fix")).toBe(
      "-Users-me-swarm-worktrees-kiliman-fix",
    );
  });

  test("replaces every character but letters and digits (verified with a probe folder)", () => {
    expect(claudeProjectSlug("/a/tmp/slug_probe dir+x")).toBe("-a-tmp-slug-probe-dir-x");
  });
});
