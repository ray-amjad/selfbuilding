# Move cards, limit work in progress, delete cards

The board at `/` shows three columns and can add a card to "To do", but a card can never leave the column it
was added to, and it can never be removed. Add three things: moving a card between columns, a limit of 3 cards
on "In progress", and deleting a card with a confirm step.

Column ids, as stored in `cards.column`: `todo` ("To do"), `in_progress` ("In progress"), `done` ("Done").

## 1. Move a card

### Behaviour

- Each card shows the buttons for the moves it can make, inside its own list item (`data-testid="card"`):

  | Card in | Button (accessible name) | Moves it to |
  |---|---|---|
  | To do | "Move to In progress" | `in_progress` |
  | In progress | "Move to Done" | `done` |
  | In progress | "Move back" | `todo` |
  | Done | "Move back" | `in_progress` |

  A "To do" card has no "Move back"; a "Done" card has no "Move to ...". Every move button carries
  `data-testid="card-move"` and `data-to=<target column id>`.
- A moved card goes to the bottom of the target column: its `position` becomes one more than the largest
  `position` already in that column (1 if the column was empty).
- A move changes that one row's `column` and `position` and nothing else: its `id`, `title`, `description` and
  `created_at` stay, and no other row changes.
- After a move the page shows the flash "Card moved" (`data-testid="flash"`) and the card in its new column.
  Each column heading's count matches the number of cards in it.
- The move is stored, not just shown: after a reload or a server restart the card is still in its new column.
- Moving an id that does not exist, or posting a target column that is not one of the three ids, changes nothing
  and does not crash the page.

### Acceptance

- **A1** Seed, click "Move to In progress" on "Fix the login timeout": the card is listed under "In progress",
  not under "To do"; `select "column", position from cards where title = 'Fix the login timeout'` is
  `in_progress|1`; the other two seed rows are unchanged (`todo`, positions 1 and 3).
- **A2** Then click "Move to Done" on it: the row is `done|1`. Then "Move back": the row is `in_progress|1`.
- **A3** Reload the page and restart the server: the card is still under "In progress".
- **A4** Move two cards into an empty "Done" one after the other: the first has `position` 1, the second 2, and
  the page lists them in that order.

## 2. Work-in-progress limit

### Behaviour

- "In progress" holds at most 3 cards. The heading reads "In progress (n/3)" instead of "In progress (n)".
- When it already holds 3, any move into it (from "To do" or "Move back" from "Done") is refused:
  - the page shows the message "In progress is full (3 of 3). Finish or move a card first." with
    `role="alert"` and `data-testid="move-error"`;
  - no "Card moved" flash is shown;
  - the database is unchanged: the refused card keeps its `column` and `position`, and no other row changes.
- The limit is enforced on the server, inside the same transaction that would write the move. Disabling or hiding
  the button is allowed as a hint, but a form posted directly must still be refused.
- Moves that do not enter "In progress" (to "Done", back to "To do") are never refused by the limit.

### Acceptance

- **B1** Seed and add a fourth card "Update the changelog". Move three "To do" cards to "In progress" one by one:
  all three succeed and `select count(*) from cards where "column" = 'in_progress'` is 3.
- **B2** Click "Move to In progress" on the fourth card: the message "In progress is full (3 of 3). Finish or move
  a card first." is visible, the card is still under "To do", and `select "column", position from cards where
  title = 'Update the changelog'` is the same as before the click. The full `select * from cards order by id` is
  identical before and after.
- **B3** Click "Move to Done" on one "In progress" card (succeeds, count is 2), then "Move to In progress" on the
  fourth card: it succeeds and the count is 3 again.
- **B4** With "In progress" full, "Move back" on a "Done" card is refused the same way and its row is unchanged.

## 3. Delete a card

### Behaviour

- Each card has a button "Delete" (`data-testid="card-delete"`).
- Clicking it does not delete anything yet. The card instead shows a confirm step inside its list item: the text
  "Delete this card?" and two buttons, "Confirm delete" (`data-testid="card-delete-confirm"`) and "Cancel"
  (`data-testid="card-delete-cancel"`). Only one card is in this state at a time.
- Use an in-page confirm step, not `window.confirm()`: it must work with JavaScript disabled, and a verifier
  reads it as part of the page.
- "Confirm delete" removes that one row from `cards` and shows the flash "Card deleted"; the card is gone from
  the board and the column count drops by one. Other rows, including their `position` values, are unchanged
  (gaps in `position` are fine).
- "Cancel" removes the confirm step and changes nothing in the database.
- Deleting an id that does not exist changes nothing and does not crash the page.

### Acceptance

- **C1** Seed, click "Delete" on "Plan the team offsite": "Delete this card?", "Confirm delete" and "Cancel" are
  visible in that card, and `select count(*) from cards` is still 3.
- **C2** Click "Cancel": the confirm step is gone, the card is still listed, and the count is still 3.
- **C3** Click "Delete" then "Confirm delete": "Card deleted" shows, the card is not on the board, and
  `select count(*) from cards where title = 'Plan the team offsite'` is 0 while the other two rows are unchanged.
- **C4** Reload: the card is still gone.

## Constraints

- Use server actions with forms, like "Add card" does; every button must work with JavaScript disabled.
- No new tables and no migration: `column` and `position` already exist.
- Keep every existing `data-testid` and accessible name; "Add card" must keep working exactly as before.
- Add tests for the database side to `test/db.test.mjs` (move, the limit refusing without writing, delete).
  `pnpm test` must pass.

## Flows to verify

- **move a card** (new): A1 to A4.
- **work-in-progress limit** (new): B1 to B4. The refusal is only proven by the unchanged rows, not the message.
- **delete a card** (new): C1 to C4.
- **add a card** (regression): add a card through the form; the flash "Card added" shows, the card is at the
  bottom of "To do", and its row has `"column" = 'todo'` and the next `position`.
