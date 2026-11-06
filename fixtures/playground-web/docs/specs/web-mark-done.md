# Mark a note done

The Notes app in `web/` lists notes but has no way to finish one. Add it.

## Behaviour

- Every note in the list that is not done gets a button "Mark done" with `data-testid="note-done-button"`.
- Clicking it sets `done = 1` on that note's row in the `notes` table and nothing else; no other note changes.
- A done note renders with its title struck through, carries `data-testid="note-done"` on the element that holds
  the struck title, and no longer shows the "Mark done" button.
- The state is stored, not just shown: after a reload (or a server restart) the note is still done.
- Marking a note that is already done, or an id that does not exist, changes nothing and does not crash the page.
- Done notes stay in the list in the same order as before (newest first).

## Constraints

- Use a server action, like "Add note" does; the button must work with JavaScript disabled (a form submit).
- No new tables and no migration: the `done` column already exists.
- Keep every existing `data-testid`; "Add note" must keep working exactly as before.
- Add tests for the database side to `web/test/db.test.mjs` (`pnpm test` in `web/`).

## Flows to verify

- **mark a note done** (new): seed, click "Mark done" on one note, see it struck through, reload, still struck
  through; the row has `done = 1` and the other rows still have `done = 0`.
- **add a note** (regression): add a note through the form; the flash "Note added" shows, the note is listed, and
  the row exists with `done = 0`.
