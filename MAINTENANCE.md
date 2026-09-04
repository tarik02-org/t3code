# Fork maintenance

This is the operating runbook for `tarik02-org/t3code`.

Use it as routing:

- `actualize`: rebuild the fork stack on the current `upstream/main`.
- `feature` or `fix`: deliver one fork change through a squash PR.
- `backport`: bring a selected upstream change into the fork, then deliver it as one fork commit.
- `release`: update the stable draft, promote its release commit, and wait for stable approval.

## History contract

The canonical `main` history has these strata, in order:

```text
upstream/main
fork CI and workflow replacement
fork packaging infrastructure
fork feature and fix commits
```

`upstream/main` is a protected mirror. The sync workflow imports upstream objects, updates the mirror, snapshots current `main` into `actualization/incoming`, and opens a Draft PR against `upstream/main`. Scheduled syncs leave the mirror unchanged while that PR is open; a manual sync with `refresh` moves it to the live upstream tip and resets the PR.

The PR intentionally starts conflicted so GitHub can run checks against the mirrored upstream base after its head is rebuilt. Manual work rebuilds the fork commits on that base. After checks pass, promotion pushes the first fork commit to a temporary base, retargets the PR there, and asks GitHub to rebase-merge the remaining reviewed commits. Only that complete staged result is force-pushed to `main`, guarded by a lease. The default branch never exposes incomplete history. GitHub assigns new commit IDs during the merge, so the resulting `main` tip differs from the reviewed PR head.

Release-state commits belong only to release preparation, not to the actualization stack. The four releasable package manifests must still carry the last published fork stable CalVer after actualization; nightly versioning derives its next patch from the desktop manifest. Dependency declarations stay with the feature or fix that needs them. Intermediate lockfiles and Nix hashes are consolidated by the release flow.

History above the upstream base is linear. `history/validated` must pass before a stable release can be promoted. It validates descent, not currency: `main` based on an older `upstream/main` commit is valid while an actualization is pending, and the check never gates on the mirror tip. Promotion separately requires the candidate to sit exactly on the base it declares, so a stale base is rejected there rather than here. Release tags preserve published chronology; no extra backup branch is required for normal work.

## Feature and fix delivery

1. Start from the current `org/main`.
2. Make one logical change. Keep all clients, contracts, providers, and connection modes in scope when they apply.
3. Keep the branch buildable. If dependencies change, update the lockfile and Nix hash for the branch so CI can build it offline.
4. Open a PR to `main` and squash it into one durable commit.
5. Fixes made while developing on top of a feature may remain separate until integration. When actualization rebases the fork stack, fold those fixes into their owning feature commits with `fixup`; do not preserve repair-only commits in the rebuilt stack.
6. After the squash lands, run `actualize` before the next stable release.

If `main` is rewritten while a feature PR is open, rebuild the branch from the new `main`. Do not carry the old ancestry forward.

## Backporting upstream

1. Start from current `org/main`.
2. Identify the upstream commit or PR and check whether the change is already in the current upstream base.
3. Apply and adapt only the requested behavior. Preserve the upstream reference in the commit body.
4. Run focused checks for the touched clients, providers, contracts, and server seams.
5. Squash the result into a PR to `main`.
6. Run `actualize` after integration.

Drop a backport when the behavior is already in upstream or no longer fits the current architecture. Do not resurrect removed fork architecture just to replay an old commit.

## Actualization

Actualization is a local rebuild of the Draft actualization PR on the live upstream tip. The agent's job ends at a green PR; promotion is a human decision.

1. Run `Sync upstream main` manually with `refresh` enabled. It moves `upstream/main` to the live `pingdotgg/t3code` tip even while an actualization PR is open, resets `actualization/incoming` to the current `main` snapshot, and opens or updates the Draft PR with fresh markers. Never rebuild on a mirror that lags the live upstream tip.
2. Fetch `upstream/main` and `org/main`. Record the old upstream base and the current fork-only delta.
3. Rebuild the fork strata on the new `upstream/main` in a temporary `actualize/<date>` branch, folding repair commits into their owning features with `fixup`.
4. Resolve conflicts by current intent:
   - keep fork workflows and packaging;
   - keep behavior still required by the fork;
   - drop behavior now supplied by upstream;
   - port provider, orchestration, projection, composer, sidebar, and terminal changes to current seams;
   - leave upstream documentation upstream.
5. Remove the old release-state commit. In the fork packaging stratum, restore the last published fork stable CalVer in `apps/{desktop,server,web}/package.json` and `packages/contracts/package.json`; verify all four match and the nightly resolver derives the next CalVer patch. Set `t3codeUpstreamVersion` in `apps/server/package.json` to the upstream base manifest version; provider compatibility policies evaluate their `t3CodeRange` against it. Do not add a replacement release-state commit. Stable release preparation owns the next stable version and generated lock/hash state.
6. Run `range-diff`, the full fork delta review, focused checks for every conflict area, `history/validated`, and the Nix runtime build.
7. Force-push the rebuilt branch to `actualization/incoming` with a lease on the snapshot the sync created.
8. Babysit the PR after every push until every required check is green. Read each failure, fix code or workflow defects, rerun failures that are demonstrably transient, push the correction, and repeat. If the same failure returns, treat it as a defect instead of hiding it behind another rerun.
9. Stop at a green PR and hand it to a human. Agents never comment `/promote`. The human's `/promote` validates the candidate against `upstream/main`, pushes its first fork commit to a temporary base, and rebase-merges the PR there. It then force-pushes the complete merge result to `main` with a lease. GitHub records the PR as merged, and the workflow deletes both temporary branches.

If `main` moves before promotion, or the human wants a newer upstream, rerun step 1 with `refresh` and rebuild. Sync and promotion share one concurrency group, so neither can change refs during the other's final checks and cleanup. The final `main` push uses a lease. A failed promotion leaves its PR and staging branch visible for manual recovery.

## Stable release

The bot maintains a Draft `release/stable` PR only after `main` passes `history/validated` and the current package version has a stable tag.

The bot updates the date-based version and the four package manifests. It keeps the manual fork changelog section between its markers and refreshes only the generated upstream section. Dependency drift belongs in actualization, not in this PR.

The release PR is applied only through `/promote`:

1. The workflow verifies that `main` is still the PR base and that its history is validated.
2. It takes the release PR tree and creates a new release-state commit with the parent of the old release-state commit.
3. It force-updates `main` with that replacement commit and closes the PR.
4. The stable build waits for CI and the matching build for that exact SHA.
5. The `stable` GitHub Environment requires `tarik02` approval before publication.

If the build fails, rerun it on the same SHA. No release exists until the publish job succeeds. A newly published stable release causes the bot to refresh the next Draft release PR.

## Nightly releases

Every push to `main` starts the nightly build. A stable preparation commit is excluded from nightly packaging.

Nightly notes compare the previous channel tag and the upstream bases of the two release commits. Fork-only commits are omitted. Stable notes include the generated upstream section plus the manual fork section from the release PR.

Release publication requires successful CI, successful `history/validated`, and a successful matching build for the same SHA.

## Canary release trees

Canary trees are independent, manual histories. Keep the upstream experiment only in the local `upstream` remote and keep the canary tree as a fork branch when it needs to be built:

```text
canary/codex-turn-mapping
```

Fetch `t3code/codex-turn-mapping` directly from the local `upstream` remote when rebuilding. There is no fork-side `upstream/codex-turn-mapping` mirror and no canary PR flow. Rebuild and promote the canary branch manually when its upstream base or patch stack changes.

Pushes to `canary/*` run CI and history validation against the matching upstream branch fetched directly from `pingdotgg/t3code`. A manually dispatched release build can package that branch with `channel=canary`; it publishes a separate prerelease tag, web channel, desktop updater channel, and isolated desktop data directory. Canary promotion is only a deliberate force-push of the reviewed canary ref; it never changes `main`.

## Promotion rules

- `/promote` is a human decision. It is accepted only from repository members, collaborators, or the owner; agents never issue it.
- `actualization` rebase-merges on a temporary staging base, then moves `main` to the complete staged result with a lease.
- `release` adds the release-state commit after an actualization, or replaces the previous release-state commit when one exists.
- A stale base, failed check, or non-linear history blocks promotion. Release-state validation applies to release PRs, not actualization PRs.
- The GitHub App bypasses the `main` non-fast-forward rule. Human stable approval remains a separate Environment gate.

## Completion

An agent's actualization task is complete when the Draft PR head is rebuilt on the live upstream tip and every required check is green. A red or pending check requires continued babysitting and repair.

A promoted actualization is complete when GitHub records its PR as merged, `main` points at the rebase-merge result without a release-state commit, `history/validated` passes, and both temporary branches are gone.

A release is complete when the stable Environment job publishes the tag and assets, the release body contains the upstream and manual sections, and the next Draft release PR reflects the new stable tag.
