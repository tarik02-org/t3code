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
one mutable release-state commit
```

The release-state commit contains package versions and any final generated lock/hash state. It is replaced during release preparation. Dependency declarations stay with the feature or fix that needs them. Intermediate lockfiles and Nix hashes are consolidated before release.

There are no merge commits above the upstream base. `history/validated` must pass before a stable release can be promoted. Release tags preserve published chronology; no extra backup branch is required for normal work.

## Feature and fix delivery

1. Start from the current `org/main`.
2. Make one logical change. Keep all clients, contracts, providers, and connection modes in scope when they apply.
3. Keep the branch buildable. If dependencies change, update the lockfile and Nix hash for the branch so CI can build it offline.
4. Open a PR to `main` and squash it into one durable commit.
5. After the squash lands, run `actualize` before the next stable release. A feature merged after release-state makes `main` temporarily unvalidated.

If `main` is rewritten while a feature PR is open, rebuild the branch from the new `main`. Do not merge the old ancestry back into it.

## Backporting upstream

1. Start from current `org/main`.
2. Identify the upstream commit or PR and check whether the change is already in the current upstream base.
3. Apply and adapt only the requested behavior. Preserve the upstream reference in the commit body.
4. Run focused checks for the touched clients, providers, contracts, and server seams.
5. Squash the result into a PR to `main`.
6. Run `actualize` after integration.

Drop a backport when the behavior is already in upstream or no longer fits the current architecture. Do not resurrect removed fork architecture just to replay an old commit.

## Actualization

Actualization is a local rebuild followed by a Draft PR. It is not a merge.

1. Fetch `upstream/main`, `org/main`, and tags from `org`.
2. Record the old upstream base and the current fork-only delta.
3. Rebuild a temporary `actualize/<date>` branch from the new `upstream/main`, replaying the fork strata in order.
4. Resolve conflicts by current intent:
   - keep fork workflows and packaging;
   - keep behavior still required by the fork;
   - drop behavior now supplied by upstream;
   - port provider, orchestration, projection, composer, sidebar, and terminal changes to current seams;
   - leave upstream documentation upstream.
5. Remove the old release-state commit. Consolidate generated lockfile and Nix hash changes, then add one release-state commit with the last published stable version.
6. Run `range-diff`, the full fork delta review, focused checks for every conflict area, `history/validated`, and the Nix runtime build.
7. Push the temporary branch and open a Draft PR labeled `actualization`.
8. After all checks pass, comment `/promote`. The promotion workflow verifies the PR base SHA, checks, ancestry, and label, then force-updates `main`, comments the new SHA, closes the PR, and deletes the temporary branch.

If `main` moves before promotion, refresh the PR. Promotion uses a lease and refuses a stale base.

## Stable release

The bot maintains a Draft `release/stable` PR only after `main` passes `history/validated` and the current package version has a stable tag.

The bot updates the date-based version and the four package manifests. It keeps the manual fork changelog section between its markers and refreshes only the generated upstream section. Dependency drift belongs in actualization, not in this PR.

The release PR is never merged. Comment `/promote`:

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

## Promotion rules

- `/promote` is accepted only from repository members, collaborators, or the owner.
- `actualization` replaces `main` with the exact reviewed PR head.
- `release` replaces only the old release-state commit with the reviewed release tree.
- A stale base, failed check, merge commit, unexpected release-state file, or mismatched package version blocks promotion.
- The GitHub App bypasses the `main` non-fast-forward rule. Human stable approval remains a separate Environment gate.

## Completion

An actualization is complete when its PR is closed by promotion, `main` points at the reviewed SHA, `history/validated` passes, and the temporary branch is gone.

A release is complete when the stable Environment job publishes the tag and assets, the release body contains the upstream and manual sections, and the next Draft release PR reflects the new stable tag.
