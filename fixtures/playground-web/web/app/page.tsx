import { BODY_MAX, getDb, listNotes, TITLE_MAX } from "../lib/db.js";
import { addNoteAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NotesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const added = first(params.added);
  const error = first(params.error);
  const notes = listNotes(getDb());

  return (
    <main>
      <h1>Notes</h1>

      {added ? (
        <p className="flash" data-testid="flash" role="status">
          Note added
        </p>
      ) : null}
      {error ? (
        <p className="error" data-testid="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <form action={addNoteAction} className="note-form" data-testid="note-form">
        <h2>Add note</h2>
        <label>
          Title
          <input name="title" required maxLength={TITLE_MAX} data-testid="note-title" />
        </label>
        <label>
          Body
          <textarea name="body" maxLength={BODY_MAX} rows={3} data-testid="note-body" />
        </label>
        <button type="submit" data-testid="note-submit">
          Add note
        </button>
      </form>

      <ul className="note-list" data-testid="note-list">
        {notes.map((note) => (
          <li key={note.id} className="note" data-testid="note-item" data-note-id={note.id}>
            <strong className="note-title">{note.title}</strong>
            {note.body ? <p className="note-body">{note.body}</p> : null}
          </li>
        ))}
      </ul>
      {notes.length === 0 ? <p className="empty">No notes yet.</p> : null}
    </main>
  );
}
