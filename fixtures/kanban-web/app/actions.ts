"use server";

import { redirect } from "next/navigation";
import { addCard, getDb, validateCard, withTransaction } from "../lib/db.js";

export async function addCardAction(formData: FormData): Promise<void> {
  const input = validateCard({ title: formData.get("title"), description: formData.get("description") });
  if (!input.ok) redirect(`/?error=${encodeURIComponent(input.error)}`);
  const db = getDb();
  // redirect() throws, so it must stay outside the transaction or the insert rolls back.
  const id = withTransaction(db, () => addCard(db, input));
  redirect(`/?added=${id}`);
}
