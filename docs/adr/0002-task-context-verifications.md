# ADR 0002 — `task.context.verifications.*`

- **Status**: Proposed (2026-05-24)
- **Closes**: [UI-UPDATES.md](../../UI-UPDATES.md) gap #6 — last remaining
  field on the advanced-task override surface
- **Scope**: orchestra runtime, optional new repo subsystem, possibly
  `diraigent.verification_template` table

## Context

The advanced-task form
([advanced-new.ts:590](../../apps/web/src/app/features/advanced/advanced-new.ts#L590))
serializes a `verifications` block when any of three sub-fields is set:

```ts
ctx.verifications = {
  ids: f.verificationIds,          // string[] — UUIDs of existing
                                   //   diraigent.verification rows
  fail_fast: f.failFast,           // boolean
  extra_test_cmd: f.extraTestCmd,  // free-form shell command
};
```

`ids` is sourced from `VerificationsApiService.list()` — i.e. existing
[`diraigent.verification`](../../apps/api/migrations/001_schema.sql#L366)
rows for the project. That table is structured as an **audit journal**,
not as a runnable definition:

```sql
CREATE TABLE diraigent.verification (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    task_id uuid,
    kind text NOT NULL,         -- 'test' | 'acceptance' | 'sign_off'
    status text NOT NULL,       -- 'pass' | 'fail' | 'pending' | 'skipped'
    title text NOT NULL,
    detail text,
    evidence jsonb,
    ...
);
```

There is **no command / script / runner column** anywhere in the
schema. The table records *that* a verification happened with *which
outcome*; it does not describe *how to run* one. The Verifications
page in the UI is a read-only journal — you can browse rows, not
"define" a runnable verification.

`task.context.verifications.ids` therefore references rows that have
no executable. Wiring `ids` straight through would require choosing
one of:

- **A.** Treat selected `ids` as *templates* and add executable columns
  (`script`, `command`, `cwd`, `timeout_s`, `expected_exit_code`, …)
  to the existing table — but those rows are also outcome records,
  so the conflation is awkward.
- **B.** Add a new `diraigent.verification_template` table and reframe
  the existing `verification` table as instances/results. The UI's
  Verifications page becomes two surfaces (templates vs results) or
  a templates-with-history view.
- **C.** Stop interpreting `ids` as DB pointers; reinterpret as names
  resolved from a repo manifest at `.diraigent/verifications/*.yaml`
  the same way playbooks moved repo-side in commit `96782d4`. The UI
  multi-select would then need to read the repo, not the DB.

None of A/B/C is wrong, but each is a sizeable subsystem with API,
schema, UI, and seeding implications. The "10/12 fields shipped" tag
in UI-UPDATES.md reflects that this is the only remaining field, and
the original handover ([sessions/2026-05-24-handover.md](../../sessions/2026-05-24-handover.md))
explicitly flagged it as a "feature, not a wiring slice" and
recommended deferral until a user asks for it.

## Decision

**Split the field into two tiers and ship only the cheap half.**

### Tier 1 — Ship now: `extra_test_cmd` + `fail_fast`

`extra_test_cmd` is the only sub-field that is fully self-describing:
the user has typed a shell command; the runtime knows exactly how to
run it. No schema work is needed. `fail_fast` only matters when at
least one runnable verification exists, so it is meaningful for the
`extra_test_cmd` path alone.

Proposed wiring (≈80 LoC + tests, single commit):

1. **Helper `verifications_from_task`** in
   [`engine/scheduler.rs`](../../apps/orchestra/src/engine/scheduler.rs):
   pure parser over `task.context.verifications`. Returns
   `Option<VerificationsPolicy { extra_test_cmd: String, fail_fast: bool }>`.
   Empty / missing / wrong-type degrades to `None`, matching the
   precedent of every other context override.

2. **Execution site**: after a successful implementation step in
   `process_reaped_task`, *before* the AllDone merge cleanup but
   *after* the worktree is known good, run `extra_test_cmd` in the
   worktree CWD via `tokio::process::Command::new("sh").arg("-c")…`.
   Capture stdout+stderr with a hard timeout (e.g. 5 min, configurable
   later via the task budget).

3. **Outcome → DB**: insert a `diraigent.verification` row via a new
   `TaskSource::create_verification` method:
   - `kind = "test"`
   - `status = "pass"` on exit 0, `status = "fail"` otherwise
   - `title = "extra_test_cmd"`
   - `detail` = the command string
   - `evidence` = `{ "stdout": "…tail…", "stderr": "…tail…", "exit_code": N, "duration_ms": M }`
     (truncate each stream to 4 KiB to avoid pathological inserts)
   This reuses the existing audit table exactly as designed; the new
   row is visible immediately on the Verifications page and on the
   task detail "Verifications" panel.

4. **`fail_fast`**: if `status = "fail"` and `fail_fast == true`,
   short-circuit the AllDone branch — do not merge, do not auto-merge,
   leave the worktree on disk (treat as if `preserve_worktree=true`
   for diagnostic value), and emit a `task_update` row with kind
   `"verification_failed"` so the existing rework-feedback path
   ([`prompt.rs:1090`](../../apps/orchestra/src/engine/prompt.rs#L1090))
   surfaces it on the next worker invocation. If `fail_fast == false`,
   the failed verification is recorded but the merge proceeds (matches
   the UI label "Fail fast on first verification fail" — opt-in).

5. **Tests**:
   - 5 parser unit tests (missing / missing-block / empty-cmd /
     fail_fast variants / typo'd keys).
   - 1 integration test in `engine::scheduler::tests` driving a fake
     `TaskSource` that captures the `create_verification` call shape.

This slice makes the **"Extra test_cmd"** form field functional and
honours the UI's `fail_fast` toggle for it. `ids` remains
inert — which is fine because the multi-select can already show
existing project verifications (the user is selecting from journal
entries) and the UI does not promise execution of them.

### Tier 2 — Defer: `ids` (selectable runnable templates)

Land only after a real user asks. When it does land, the design
decision is between options B (new template table) and C (repo-side
YAML manifest).

Strong recommendation: **option C**. Rationale:

- Symmetric with playbooks. Repo-as-source-of-truth is already the
  established pattern post-`96782d4`.
- Verifications-as-code is reviewable in PRs and survives project
  forks / restores without a separate seed step.
- The existing `verification` table cleanly becomes a pure journal
  of outcomes — no schema split needed.
- The advanced-new multi-select can read
  `GET /v1/projects/{id}/repo-verifications` (a repo-driven endpoint
  analogous to the existing repo-playbooks resolution).

Out-of-scope for this ADR; will become ADR 0003 when prioritised.

### UI contract

The advanced-new form continues to accept all three sub-fields
unchanged. The user-visible behaviour after Tier 1:

| Field             | UI today              | After Tier 1                        |
|-------------------|-----------------------|-------------------------------------|
| `ids`             | accepted, silent      | accepted, silent (no behaviour yet) |
| `fail_fast`       | accepted, silent      | gates `extra_test_cmd` outcome      |
| `extra_test_cmd`  | accepted, silent      | runs after impl step, records row   |

The "deferred" footer in UI-UPDATES.md flips from "all of
`verifications.*` deferred" to "only `verifications.ids` deferred",
and gap #6 moves to 11 of 12 fields shipped. The remaining 1/12 is
intentionally Tier 3 (revisit on user demand).

## Consequences

### Positive

- Closes the meaningful half of the last gap-#6 item without
  committing to a verification-template subsystem.
- Reuses the existing `verification` audit table as designed. No new
  migration is needed: `create_verification` already exists in the
  repository layer
  ([`apps/api/src/repository/verifications.rs`](../../apps/api/src/repository/verifications.rs))
  and `POST /{project_id}/verifications` is already routed
  ([`apps/api/src/routes/verifications.rs`](../../apps/api/src/routes/verifications.rs)).
  Orchestra only needs a new `TaskSource::create_verification` method
  that wraps the existing HTTP endpoint.
- Makes the UI's `fail_fast` toggle observable.
- Preserves a clear path to Tier 2 without painting the schema into
  a corner.

### Negative

- A user who selects items in the `ids` multi-select still sees no
  runtime effect. The UI should add a small inline hint (e.g.
  "Selection recorded; runtime execution lands in a future release")
  to avoid silent confusion. Alternatively, hide the multi-select
  behind a feature flag until Tier 2 lands. Decision deferred to the
  implementation slice.
- Shelling out `extra_test_cmd` introduces a new failure mode in the
  AllDone branch. The implementation must defensively log, never
  panic, and degrade to "no verification row created" on any pre-exec
  error (e.g. worktree gone). The same hardening pattern as
  `emit_requested_reports` applies.

### Neutral

- No provider trait changes.
- No `task.context` schema changes.
- No new migration if `create_verification` is already wired; one
  small migration if a "source = 'extra_test_cmd'" discriminator is
  desired on the verification row (optional, follows the report.source
  precedent from migration 050).

## Alternatives considered

- **Ship nothing; keep deferring all three** — rejected. The user
  explicitly asked to "keep going"; deferring `extra_test_cmd` when
  it is 80 LoC of pure wiring leaves easy value on the table.
- **Ship the full template subsystem (option B)** — rejected for this
  pass. Touches schema, repo seeding, UI list/edit/delete, and a new
  endpoint surface. Not a wiring slice; needs a real user pulling on
  it.
- **Reinterpret `ids` as repo YAML names (option C)** — preferred for
  Tier 2 but out of scope here. Recorded as a follow-up so the next
  agent does not re-litigate.

## Implementation cadence (Tier 1)

Per [CLAUDE.md](../../CLAUDE.md): small confident slice → straight to
`main`. Suggested single commit:

```
feat(orchestra): honor task.context.verifications.extra_test_cmd (gap #6 partial)
```

with: parser + executor + DB write + 6 unit tests + 1 integration
test. `cargo fmt`, `cargo clippy --all-targets -- -D warnings`,
`cargo test -p diraigent-orchestra` clean before commit.

After landing, update UI-UPDATES.md gap #6 to "11 of 12 fields
shipped — `verifications.ids` remains (Tier 3 per ADR 0002)".
