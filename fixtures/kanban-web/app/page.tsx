import { COLUMNS, DESCRIPTION_MAX, getDb, listBoard, TITLE_MAX } from "../lib/db.js";
import { addCardAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BoardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const added = first(params.added);
  const error = first(params.error);
  const board = listBoard(getDb());

  return (
    <main>
      <h1>Board</h1>

      {added ? (
        <p className="flash" data-testid="flash" role="status">
          Card added
        </p>
      ) : null}
      {error ? (
        <p className="error" data-testid="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="board" data-testid="board">
        {COLUMNS.map((column) => {
          const cards = board[column.id];
          const headingId = `column-${column.id}`;
          return (
            <section
              key={column.id}
              className="column"
              aria-labelledby={headingId}
              data-testid="column"
              data-column={column.id}
            >
              <h2 id={headingId}>
                {column.label} <span className="count">({cards.length})</span>
              </h2>

              {column.id === "todo" ? (
                <form action={addCardAction} className="card-form" data-testid="card-form" aria-label="Add card">
                  <label>
                    Title
                    <input name="title" required maxLength={TITLE_MAX} data-testid="card-title" />
                  </label>
                  <label>
                    Description
                    <textarea name="description" maxLength={DESCRIPTION_MAX} rows={2} data-testid="card-description" />
                  </label>
                  <button type="submit" data-testid="card-submit">
                    Add card
                  </button>
                </form>
              ) : null}

              <ul className="card-list" aria-label={`${column.label} cards`} data-testid="card-list">
                {cards.map((card) => (
                  <li key={card.id} className="card" aria-label={card.title} data-testid="card" data-card-id={card.id}>
                    <strong className="card-title">{card.title}</strong>
                    {card.description ? <p className="card-description">{card.description}</p> : null}
                  </li>
                ))}
              </ul>
              {cards.length === 0 ? <p className="empty">No cards.</p> : null}
            </section>
          );
        })}
      </div>
    </main>
  );
}
