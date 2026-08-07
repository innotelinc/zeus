import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(path.join(dataDir, "pbx.db"));
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  const schemaPath = path.join(process.cwd(), "scripts", "schema.sql");
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, "utf8");
    _db.exec(schema);
  }

  const migrationsDir = path.join(process.cwd(), "scripts", "migrations");
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      try {
        _db.exec(sql);
      } catch {
        // migration already applied – ok
      }
    }
  }

  return _db;
}

const db = new Proxy({} as Database.Database, {
  get(_target, prop, receiver) {
    const realDb = getDb();
    const value = Reflect.get(realDb, prop, realDb);
    if (typeof value === "function") {
      return value.bind(realDb);
    }
    return value;
  },
});

export default db;
