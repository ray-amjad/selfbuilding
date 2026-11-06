"use server";

import { redirect } from "next/navigation";
import { addNote, getDb, validateNote, withTransaction } from "../lib/db.js";

export async function addNoteAction(formData: FormData): Promise<void> {
  const input = validateNote({ title: formData.get("title"), body: formData.get("body") });
  if (!input.ok) redirect(`/?error=${encodeURIComponent(input.error)}`);
  const db = getDb();
  const id = withTransaction(db, () => addNote(db, input));
  redirect(`/?added=${id}`);
}
