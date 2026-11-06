// Usage: node scripts/db.mjs reset | seed | migrate   (the file is DATABASE_PATH, default ./data/app.db)
import { databasePath, openDb, resetDb, seed } from "../lib/db.js";

const command = process.argv[2];
const path = databasePath();

switch (command) {
  case "reset": {
    resetDb(path).close();
    console.log(`reset ${path}`);
    break;
  }
  case "seed": {
    const db = openDb(path);
    const ids = seed(db);
    db.close();
    console.log(`seeded ${ids.length} cards into ${path}: ids ${ids.join(", ")}`);
    break;
  }
  case "migrate": {
    openDb(path).close();
    console.log(`migrated ${path}`);
    break;
  }
  default: {
    console.error("usage: node scripts/db.mjs reset | seed | migrate");
    process.exit(2);
  }
}
