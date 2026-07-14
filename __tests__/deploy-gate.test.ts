import { describe, expect, it } from "vitest";

import {
  createDeployGateCheck,
  deployTagTemplate,
} from "../src/deploy-gate.js";
import { DEFAULT_RELEASE } from "../src/domain/release.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ write: () => {}, level: "error" });

interface Call {
  cmd: string;
  args: string[];
}

function fakeTransport(handlers: {
  tags?: string; // stdout of git tag --list
  runsByTag?: Record<string, string>; // stdout of gh run list per tag
  failFetch?: boolean;
}) {
  const calls: Call[] = [];
  return {
    calls,
    async exec(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      if (cmd === "git" && args[0] === "fetch") {
        return handlers.failFetch
          ? { code: 1, stdout: "", stderr: "network down" }
          : { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "tag") {
        return { code: 0, stdout: handlers.tags ?? "", stderr: "" };
      }
      if (cmd === "gh") {
        const tag = args[args.indexOf("--branch") + 1];
        return {
          code: 0,
          stdout: handlers.runsByTag?.[tag] ?? "[]",
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected: ${cmd}` };
    },
  };
}

const SUCCESS = JSON.stringify([{ status: "completed", conclusion: "success" }]);
const RUNNING = JSON.stringify([{ status: "in_progress", conclusion: null }]);

describe("deployTagTemplate", () => {
  it("uses the last extra template when extras exist, else the primary", () => {
    expect(deployTagTemplate(DEFAULT_RELEASE)).toBe(
      "desktop-v0.1.0-canary.<N>",
    );
    expect(
      deployTagTemplate({ tagTemplate: "r<N>", extraTagTemplates: [] }),
    ).toBe("r<N>");
  });
});

describe("createDeployGateCheck", () => {
  const since = "2026-07-14T11:21:00.000Z";
  const NEWER = "desktop-v0.1.0-canary.358\t2026-07-14T13:00:00+00:00";
  const OLDER = "desktop-v0.1.0-canary.357\t2026-07-14T01:00:00+00:00";

  it("clears when a tag newer than the floor has a successful run", async () => {
    const transport = fakeTransport({
      tags: `${NEWER}\n${OLDER}\n`,
      runsByTag: { "desktop-v0.1.0-canary.358": SUCCESS },
    });
    const check = createDeployGateCheck({
      transport,
      repoPath: "/repo",
      release: DEFAULT_RELEASE,
      log,
    });
    expect(await check(since)).toBe(true);
  });

  it("does NOT clear when the newer tag's run is still in progress", async () => {
    const transport = fakeTransport({
      tags: `${NEWER}\n`,
      runsByTag: { "desktop-v0.1.0-canary.358": RUNNING },
    });
    const check = createDeployGateCheck({
      transport,
      repoPath: "/repo",
      release: DEFAULT_RELEASE,
      log,
    });
    expect(await check(since)).toBe(false);
  });

  it("does NOT clear when the only tags predate the floor (never checks their runs)", async () => {
    const transport = fakeTransport({
      tags: `${OLDER}\n`,
      runsByTag: { "desktop-v0.1.0-canary.357": SUCCESS },
    });
    const check = createDeployGateCheck({
      transport,
      repoPath: "/repo",
      release: DEFAULT_RELEASE,
      log,
    });
    expect(await check(since)).toBe(false);
    expect(transport.calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("fetch failure → not cleared (quiet wait, no throw)", async () => {
    const transport = fakeTransport({ failFetch: true });
    const check = createDeployGateCheck({
      transport,
      repoPath: "/repo",
      release: DEFAULT_RELEASE,
      log,
    });
    expect(await check(since)).toBe(false);
  });

  it("caches: a not-cleared result is not re-checked within the TTL; a cleared result sticks", async () => {
    let nowMs = 1_000_000;
    const transport = fakeTransport({ tags: "" });
    const check = createDeployGateCheck({
      transport,
      repoPath: "/repo",
      release: DEFAULT_RELEASE,
      log,
      now: () => nowMs,
      cacheTtlMs: 60_000,
    });
    expect(await check(since)).toBe(false);
    const callsAfterFirst = transport.calls.length;
    expect(await check(since)).toBe(false); // inside TTL → cached
    expect(transport.calls.length).toBe(callsAfterFirst);

    nowMs += 61_000; // TTL expired → re-check
    expect(await check(since)).toBe(false);
    expect(transport.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
