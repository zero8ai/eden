---
name: rebase
description: Merge target (default main) into current branch and report non-trivial conflicts.
disable-model-invocation: true
---

# Rebase

Merge a branch into the current one. The target is the user's argument, or `main`
if none given. Merge the **local** branch — never fetch or use `origin/<target>`
unless the user explicitly says so (e.g. `origin/main`).

## Do this

Run the merge. Don't run recon first (`git log`, `git diff --stat`, `merge-base`) —
the merge itself reports everything you need.

    git merge <target> --no-edit

- **Clean** ("Merge made by…", "Fast-forward", or "Already up to date"):
  done. Report one line naming what came in, then do the post-merge DB step
  below if migrations came in. Run nothing else — a clean merge needs no
  other verification.
- **Conflicts:** see below.
- **Merge aborts citing `AGENTS.md`** (worktree only): do the AGENTS.md fix at the
  bottom, then re-run the merge.

## If there are conflicts

The merge lists the conflicted files. Ignore noise (formatting, lockfiles,
non-overlapping additions). Split the rest into two kinds:

**Migration files** — anything under:
- `drizzle/*.sql`
- `drizzle/meta/_journal.json`
- `drizzle/meta/*_snapshot.json`

**Everything else** — ordinary code conflicts.

### Code conflicts (you handle)

Report each real conflict with the resolution you intend, wait for approval,
then apply. Skip this section if there are none.

### Migration conflicts

1. **Research first.** Inspect our pre-merge migration (git history), the target's
   migration(s), and the target-side schema changes. Classify as:
   - **Trivial** — only the index/sequence number collides; our SQL is pure
     `db:generate` output. → accept theirs, re-run `npm run db:generate` on top.
   - **Hand-written extensions** — our migration has hand-written SQL (data
     migrations, custom indexes) to carry forward.
   - **Partially superseded** — as above, but the target now handles some of it;
     exclude those from the carry-forward.
2. **Report the analysis and wait for confirmation** — what ours did, what the
   target introduced, the classification, what's carried forward vs dropped,
   and the end state.
3. **On approval:** accept the target's migration files/journal/snapshot and
   complete the merge; run `npm run db:generate` for a fresh migration on the
   merged base; fold in the carry-forward set, re-introducing nothing the target
   already handles. Renumber so migration indexes are strictly increasing and
   check `drizzle/meta/_journal.json` `when` timestamps stay in order.

## Post-merge DB step (worktree only)

If the merge brought in new migrations and `WORKTREE.md` exists at root, run
`npm run db:migrate` — the worktree's cloned database was taken at setup time
and won't have the target's migrations applied.

## AGENTS.md (worktree only — only if the merge aborted citing it)

In a worktree (`WORKTREE.md` exists at root), `AGENTS.md` is `skip-worktree` with a
generated appendix, which can block the merge. If that happens:

1. `git update-index --no-skip-worktree AGENTS.md`
2. `merge_base=$(git merge-base HEAD <target>); git checkout "$merge_base" -- AGENTS.md`
3. Re-run the merge (resolve conflicts per the sections above).
4. After the merge commit exists, restore the appendix: from the **main
   checkout** root, run `node scripts/worktree-setup.mjs <feature-name>` (add
   `--skip-validate` if original setup used it; derive `<feature-name>` from
   the branch or `WORKTREE.md`'s `# Worktree:` header). This re-appends the
   appendix and re-sets `skip-worktree` itself.
