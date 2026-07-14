/**
 * Deploy-gate checker for `waiting-on-deploy` ledger blockers (THINK-285
 * follow-up): decides whether a release newer than a given instant has
 * FINISHED deploying, so the engine can relaunch a deploy-gated phase without
 * an operator touching labels.
 *
 * Semantics: the gate clears when a release tag matching the scheme's deploy
 * tag template (the last extra template when extras exist — thinkwork's
 * desktop tag is what deploys apps/web — else the primary) was created after
 * `sinceIso` AND that tag's newest GitHub Actions run concluded successfully.
 * Tag-created-after-the-wait is sufficient freshness: the wait's attempt
 * launched after the work merged, so any later tag contains the merge.
 *
 * Results are cached for CACHE_TTL_MS per `sinceIso` — the daemon asks every
 * tick, but a `git fetch` + `gh run list` every 30s per waiting issue would
 * hammer the network for a gate that changes on operator-release cadence.
 */

import { tagGlob, type ReleaseConfig } from "./domain/release.js";
import type { Logger } from "./logger.js";

export const DEPLOY_GATE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface DeployGateDeps {
  transport: {
    exec(
      command: string,
      args: string[],
      opts?: { cwd?: string; timeoutMs?: number },
    ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  };
  repoPath: string;
  release: ReleaseConfig;
  log: Logger;
  /** Injectable clock (tests). */
  now?: () => number;
  cacheTtlMs?: number;
}

/** The tag template whose Actions run is the deploy signal. */
export function deployTagTemplate(release: ReleaseConfig): string {
  return release.extraTagTemplates.length > 0
    ? release.extraTagTemplates[release.extraTagTemplates.length - 1]
    : release.tagTemplate;
}

export function createDeployGateCheck(
  deps: DeployGateDeps,
): (sinceIso: string) => Promise<boolean> {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.cacheTtlMs ?? DEPLOY_GATE_CACHE_TTL_MS;
  let cache: { at: number; since: string; result: boolean } | null = null;

  return async (sinceIso: string): Promise<boolean> => {
    if (
      cache !== null &&
      cache.since === sinceIso &&
      // A cleared gate stays cleared for this floor (tags don't un-push);
      // only a "not yet" result expires and gets re-checked.
      (cache.result || now() - cache.at < ttl)
    ) {
      return cache.result;
    }

    let result = false;
    try {
      const fetch = await deps.transport.exec(
        "git",
        ["fetch", "--tags", "--quiet", "origin"],
        { cwd: deps.repoPath, timeoutMs: 60_000 },
      );
      if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr}`);

      const template = deployTagTemplate(deps.release);
      const tags = await deps.transport.exec(
        "git",
        [
          "tag",
          "--list",
          tagGlob(template),
          "--sort=-creatordate",
          "--format=%(refname:short)\t%(creatordate:iso-strict)",
        ],
        { cwd: deps.repoPath, timeoutMs: 30_000 },
      );
      const floor = new Date(sinceIso).getTime();
      // Newest-first; only the tags created after the wait matter. Check the
      // few newest — the first with a successful run clears the gate.
      for (const line of tags.stdout.split("\n").slice(0, 5)) {
        const [tag, created] = line.trim().split("\t");
        if (!tag || !created) continue;
        if (new Date(created).getTime() <= floor) break; // sorted — all older
        const runs = await deps.transport.exec(
          "gh",
          [
            "run",
            "list",
            "--branch",
            tag,
            "--limit",
            "1",
            "--json",
            "status,conclusion",
          ],
          { cwd: deps.repoPath, timeoutMs: 30_000 },
        );
        if (runs.code !== 0) continue;
        try {
          const parsed = JSON.parse(runs.stdout) as {
            status?: string;
            conclusion?: string;
          }[];
          if (
            parsed[0]?.status === "completed" &&
            parsed[0]?.conclusion === "success"
          ) {
            result = true;
            deps.log.info("deploy gate cleared", { tag, since: sinceIso });
            break;
          }
        } catch {
          // Unparseable gh output — try the next tag.
        }
      }
    } catch (e) {
      // Unreachable git/gh → not cleared; the engine keeps waiting quietly.
      deps.log.warn("deploy gate check failed — treating as not cleared", {
        error: String(e),
      });
      result = false;
    }

    cache = { at: now(), since: sinceIso, result };
    return result;
  };
}
