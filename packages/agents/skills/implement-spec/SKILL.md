---
name: implement-spec
description: Build a change from a spec on its own branch, committing as it goes, and keep implementation notes of every decision, deviation, tradeoff and open question. Also fixes a given list of review findings on an existing branch. Never opens a pull request.
---

# Implement a spec

**Goal:** the change the spec asks for, committed on the working branch in small coherent commits,
plus an implementation-notes file a reviewer and the spec's author can read, and a result that says
truthfully what was built and what was not.

## The spec is the source of truth for scope

- `spec` in your input is either the spec text or `{ "path": "..." }`, a file in the repository.
  **Read the whole spec before you write code.**
- Build what it asks for: no more, no less. Keep the diff focused. A refactor or a fix the spec did
  not ask for is a follow-up, not part of this change (put it in `followUps`).
- Find where the change goes yourself, and decide as you go. Do not write a plan file or a phase
  split. Read the code, then build.

## Branch and commits

- Work on a new branch, never the default one. The run normally checks one out for you; the
  Workspace section names it. Stay on it. If you find yourself on the default or base branch,
  create `selfbuilding/<short-name>` from it first.
- **Commit as you go**, in small coherent commits with clear messages, so a run that dies part-way
  leaves a branch the next builder can resume. Never rewrite or force-push history.
- **Do not push and do not open a pull request.** The host pushes the branch after you finish and
  opens the pull request itself.
- Never commit secrets, `.env` files, credentials or build output.

## Ordinary care

Before you submit, run the type checker, the linter and the tests for the area you changed, using
the repository's own commands (its README, `package.json` scripts, `Makefile`, `AGENTS.md`). If the
input names a `testCommand`, run exactly that command: it is the one the run will check. Report it in
`tests` with whether it passed. Do not delete a test, or mark one skipped or focused, to make a run
pass; the run checks for that.

## Implementation notes: one file, from the first builder to the last fixer

A spec never covers everything, and you meet the gaps first. Decide on the spot, write the decision
down, and keep building. Never stall, and never guess without a trace.

Append to **`/selfbuilding/out/files/implementation-notes.md`**. It lives outside the repository, so it
never lands in the diff, and the run collects it. If it does not exist, create it **before you write
code**:

```markdown
# Implementation notes: <the change, in a few words>

## Design decisions
Choices made where the spec was ambiguous, and the reading picked.

## Deviations
Places the build departed from the spec on purpose, and why.

## Tradeoffs
Alternatives considered, and why the chosen one won.

## Open questions
Anything the author should confirm or revise. Phrase each one as a question.
```

If it already exists (a previous builder or fixer wrote it), keep everything in it and add to it.

- One to three lines per entry: the file or symbol (`src/limits.ts:41`), the call, the reason.
- Write each entry at the moment of the decision, not at the end from memory.
- The bar for an entry: would the spec's author push back or be surprised? Do not narrate the code,
  and do not repeat what the diff already says. A handful of entries, not thirty.
- **A question that blocks what you build next:** use `ask_human` if it is available. Otherwise, log
  it under *Open questions* with the defensible default you chose, and keep going.

## Fixing review findings

When the input carries `feedback`, you are a fixer on an existing branch, not a builder:

- Fix exactly those findings. Do not finish a half-built feature or start new work.
- **Findings with one root cause get one design, not N patches.** A locally correct patch can break
  a property the code holds somewhere else.
- **The defect is proven, but the suggested remedy is a guess.** You may reject a remedy you find
  worse, but you must still fix the defect and say what you did instead (in the notes, under
  *Deviations*).
- Commit after each group of findings.
- A finding you cannot resolve goes in `followUps`, with why.

## The result

Call `submit_result` once, at the end:

- `status`: `done` when the spec (or every finding) is handled; `blocked` when something outside
  the code stops you (a missing service, a question only a human can answer); `failed` when you
  tried and could not make it work. Report honestly: a `done` is checked.
- `summary`: what you built, in a few sentences, and anything you could not finish.
- `changes`: one entry per file you changed, with why.
- `tests`: the command you ran and whether it passed (omit it if you ran none).
- `followUps`: work you noticed and did not do.
- `openQuestions`: the *Open questions* from the notes file, one per entry.
- `prTitle`: a short imperative title, at most 120 characters.
- `prBody`: Markdown with these sections, in order: `## What changed and why`,
  `## Implementation notes` (paste the whole notes file), `## Verified` (write
  `Not verified: pending`), and `## Source` (where the spec came from).
