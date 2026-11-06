// Migrations run when the server boots, not on the first request, so a broken schema shows up in the boot log.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("./lib/db.js");
  getDb();
}
