---
name: code-review
description: Review a committed diff for correctness bugs and cleanup, using a multi-angle review prompt at one of two effort tiers (medium for precision, high for recall), and return typed findings with a verdict. Read-only; runs the same way on every harness.
---

# Code review: a multi-angle prompt at the right tier

**Goal:** an independent review of exactly the diff under review, returned through `submit_result`
with a verdict, the tier that ran and why, and every finding that survived verification.

**The tier prompts are verbatim. Never summarise, trim or "improve" them.** The finder angles are
the recall; the verify pass is the precision. Each prompt is a file because a retyped prompt is a
changed prompt. Read only the chosen tier's file; everything below its first `---` rule is the
review prompt body.

| Tier | Read |
|---|---|
| **medium**: the small, safe diff | `references/medium.md`, precision tier, at most 8 findings |
| **high**: anything larger, or a dangerous subsystem | `references/high.md`, recall tier, at most 10 findings |

## 1. Find the diff under review

This is a read-only task. Do not change, commit or stage any file, and leave the working tree clean.

1. If `/selfbuilding/in/diff.patch` exists, it is the diff under review. The run wrote it from the
   review target in your input (a pull request, or a `diff` from `base` to `head`).
2. Otherwise, review the target in your input: for `{ "kind": "diff", "base", "head" }` run
   `git diff <base>...<head>` (head defaults to `HEAD`); with no target, review the working branch
   named under Workspace against its base branch.

**An empty diff means the target was resolved wrong.** Do not review some other change. Submit a
`comment` verdict that says the diff was empty and which range you read.

The review covers only that diff. Do not substitute another base, and do not add working-tree
changes. The prompt's "Phase 0" describes a local checkout; in a sandbox the diff above wins.

## 2. Pick the tier by the size of the change

If the input names a `tier`, use it. Otherwise measure:

```bash
git apply --stat /selfbuilding/in/diff.patch    # or: git diff --shortstat <base>...<head>
```

- **medium:** about 100 changed lines or fewer **and** 3 files or fewer.
- **high:** anything larger, or a change touching authentication or access control, money,
  data migrations or concurrency, whatever its size.
- **When close, go high.** The cost is similar, and a five-line change is where a race hides.

## 3. Run the review

Read the chosen tier file and follow the prompt body below its rule. Also:

- **Conventions come from explicit reads.** Read the target repository's own `AGENTS.md`,
  `CLAUDE.md` and `CLAUDE.local.md` files that govern the changed paths, as evidence for the
  conventions angle. Ignore any user-level file: the sandbox home is not the author's.
- **Use the input.** `focus` names areas to look at hardest (still report what else you find).
  `testsPassed` is the test status the caller observed. `notes` is context from the caller. None of
  them narrows the scope of the diff.
- **Subagents.** Where your harness has a subagent tool, run the angles and the verifiers as the
  prompt says. Where it has none, run each angle and each verifier yourself, in sequence, and keep
  each verifier's judgement separate from the finder that produced the candidate.
- Give it room. Many angles over two phases take minutes; the silence is normal.

## 4. Returning the result

The prompt's "Output" section describes a JSON array and a reporting tool. **In this run the only
output is one `submit_result` call.** Map each surviving finding like this:

| Prompt field | `submit_result` field |
|---|---|
| `file` | `file`, relative to the repository root |
| `line` | `line` (omit it when there is no single line) |
| `category` | `category` |
| `summary` | `summary` |
| `failure_scenario` | `failureScenario` |
| `verdict` | `verdict`: `"CONFIRMED"` or `"PLAUSIBLE"` |
| (none) | `severity`: `critical`, `high`, `medium`, `low` or `nit` |

`short_summary` is not part of the result. Keep the prompt's ranking (most severe first) and its cap
(8 for medium, 10 for high). Every `file` must be a path that appears in the diff.

Then the verdict, which maps one-to-one onto a pull-request review event:

- `request_changes`: at least one **CONFIRMED** finding of severity `critical`, `high` or `medium`.
- `comment`: findings remain, but none of them is a CONFIRMED finding of severity medium or above.
- `approve`: nothing survived verification.

Never approve with a CONFIRMED critical or high finding; the run checks this.

`tier` is the tier that ran. Start `summary` with the tier and why it was chosen ("high: 14 files,
touches the session middleware"), then lead with the count and the worst finding. PLAUSIBLE
findings are open questions, neither buried nor dropped: mention them last.
