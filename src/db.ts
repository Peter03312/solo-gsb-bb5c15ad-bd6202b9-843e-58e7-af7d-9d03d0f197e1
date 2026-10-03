import { Pool } from 'pg';

const DEFAULT_URL = 'postgres://stowage:stowage@localhost:5432/stowage';

export let pool: Pool = createPool();

function createPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_URL,
    max: Number(process.env.PG_POOL_SIZE || 10),
  });
}

/** Replace the connection pool (used by integration tests with an in-memory database). */
export function setPool(replacement: Pool): void {
  pool = replacement;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS voyages (
  id         TEXT PRIMARY KEY,
  dims_x     INTEGER NOT NULL CHECK (dims_x > 0),
  dims_y     INTEGER NOT NULL CHECK (dims_y > 0),
  dims_z     INTEGER NOT NULL CHECK (dims_z > 0),
  revision   BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS columns (
  voyage_id  TEXT NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  max_weight DOUBLE PRECISION NOT NULL CHECK (max_weight >= 0),
  PRIMARY KEY (voyage_id, x, y)
);

CREATE TABLE IF NOT EXISTS containers (
  voyage_id    TEXT NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  container_no TEXT NOT NULL,
  weight       DOUBLE PRECISION NOT NULL CHECK (weight > 0),
  dg_class     TEXT NOT NULL,
  x            INTEGER,
  y            INTEGER,
  z            INTEGER,
  PRIMARY KEY (voyage_id, container_no)
);

CREATE TABLE IF NOT EXISTS incompatibilities (
  voyage_id    TEXT NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  class_a      TEXT NOT NULL,
  class_b      TEXT NOT NULL,
  min_distance INTEGER NOT NULL CHECK (min_distance > 0),
  PRIMARY KEY (voyage_id, class_a, class_b)
);

CREATE TABLE IF NOT EXISTS load_lists (
  id         BIGSERIAL PRIMARY KEY,
  voyage_id  TEXT NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
  revision   BIGINT NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  content    JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_load_lists_voyage ON load_lists (voyage_id, id);
`;

/** Wait until PostgreSQL accepts connections (Compose starts both containers together). */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[db] not ready yet (attempt ${i}/${attempts}): ${message}`);
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
  console.log('[db] schema ready');
}
