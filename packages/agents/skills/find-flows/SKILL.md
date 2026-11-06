---
name: find-flows
description: Read a committed diff and list every user flow it adds or changes, plus the nearest flow it could break, as a short typed list a verifier can drive one by one. Each flow names where a user starts, the end state they reach, the rows the app must write and why the diff reaches it. Read-only.
---

# Find the user flows a diff reaches

**Goal:** the short list of flows a person would have to click through to trust this change, each
precise enough that a verifier who never saw the diff can drive it and a checker can judge it. You
do not run the app and you do not judge the code. You read, and you name what to prove.

This is a read-only task. Do not change, commit or stage any file, and leave the working tree clean.

## 1. Find the diff

1. If `/selfbuilding/in/diff.patch` exists, it is the diff. The run wrote it from the target in
   your input.
2. Otherwise, with a `{ "kind": "diff", "base", "head" }` target, run `git diff <base>...<head>`
   (head defaults to `HEAD`). With no target, read the working branch named under Workspace against
   its base branch.

**An empty diff means the target was resolved wrong.** Do not invent flows. Submit
`noRunnableSurface: true`, an empty `flows` list, and say in `summary` which range you read.

The input's `change` is the builder's own summary. Use it to understand intent, but the diff is the
truth: a flow the summary claims and the diff does not reach is not a flow.

## 2. Read the app's own facts

```bash
cat .selfbuilding/verify/README.md 2>/dev/null   # app dir, routes, selectors, how the data is stored
```

Then read the files the diff touches **and the code that calls them**, up to the surface a user
sees: a page, a form, a button, a CLI command, an HTTP endpoint a client calls. A changed function
three layers down still has a user flow; find the screen that reaches it.

## 3. Name the flows

A **flow** is one thing a user does from a starting point to an end state they can see, for
example "add a note" or "mark a note done". Not a function, not a file, not a test.

| Kind | Means | Example |
|---|---|---|
| `new` | the diff adds it; it did not exist before | a new "Mark done" button |
| `changed` | it existed; the diff changes what the user does or sees | the add form gains a required field |
| `regression` | the diff does not change it, but touches code it runs through | "add a note" when the diff edits the notes table |

For each flow give:

- `name`: a short verb phrase in the user's words, at most 80 characters, unique.
- `entry`: where the user starts, a URL path (`/`) or a UI entry (`the "Add note" form on /`).
- `endState`: what the user sees when it worked, concretely (text, an element, a state that
  survives a reload). Name `data-testid` selectors when the app has them.
- `rows`: the rows the app must write or change, as the checker would query them
  (`notes: a row with title "Buy milk", done = 0`). Omit when the flow writes nothing.
- `sideEffects`: effects outside the app (an email, a webhook, a queued job); mark one `optional`
  when the flow is still correct without it.
- `why`: the hunk or file in the diff that puts this flow on the list.

## 4. Order and cap

- Order: every `new` flow first, then `changed`, then **one** `regression`: the nearest existing
  flow the change runs through. Add a second regression only when the diff touches two unrelated
  surfaces.
- Return at most `maxFlows` flows (default 6). When there are more, keep the ones a user hits most
  and list the rest in `skipped` with why.
- Merge flows that differ only in input values; that is one flow with a varied check.

## 5. No runnable surface

Docs only, comments, types only, CI or build config, test-only changes, or a refactor with no
behaviour change: set `noRunnableSurface: true`, return an empty `flows` list, and say in `summary`
why nothing can be driven. List what you looked at in `skipped`.

## 6. Submit

Submit through `submit_result`:

```json
{
  "summary": "Adds a Mark done button to each note; the add flow shares the notes table.",
  "flows": [
    {
      "name": "mark a note done",
      "kind": "new",
      "entry": "the Mark done button on a note on /",
      "endState": "the note renders struck through (data-testid=note-done) and stays so after a reload",
      "rows": ["notes: the clicked note has done = 1"],
      "why": "web/app/page.tsx adds the button and web/lib/db.ts adds markDone"
    },
    {
      "name": "add a note",
      "kind": "regression",
      "entry": "the Add note form on /",
      "endState": "a flash \"Note added\" and the note at the top of the list",
      "rows": ["notes: a new row with the submitted title, done = 0"],
      "why": "web/lib/db.ts changes the notes queries the add action uses"
    }
  ],
  "noRunnableSurface": false,
  "skipped": []
}
```

The run checks that the list is ordered, that names are unique, and that `noRunnableSurface`
agrees with the list. A result that fails is sent back to you with the reason.
