import { getDb, ping } from "../../../lib/db.js";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    if (!ping(getDb())) throw new Error("ping returned no row");
    return Response.json({ ok: true, db: "ok" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, db: "error", error: message }, { status: 503 });
  }
}
