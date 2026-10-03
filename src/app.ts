import express, { NextFunction, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { pool } from './db';
import {
  ColumnLimit,
  ContainerState,
  Dims,
  Incompatibility,
  Position,
} from './types';
import { isValidPosition, validateLayout, Violation } from './validation';

// ---------------------------------------------------------------------------
// Errors & helpers
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const asyncHandler =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function badBody(message: string): HttpError {
  return new HttpError(400, 'BAD_REQUEST', message);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badBody(`'${name}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw badBody(`'${name}' must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badBody(`'${name}' must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw badBody(`'${name}' must be a positive integer`);
  }
  return value as number;
}

function requireWeight(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HttpError(400, 'INVALID_WEIGHT', `'${name}' must be a positive finite number`, { value });
  }
  return value;
}

function requireRevision(value: unknown, name = 'expectedRevision'): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw badBody(`'${name}' must be a non-negative integer`);
  }
  return value as number;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface VoyageRow {
  id: string;
  dims_x: number;
  dims_y: number;
  dims_z: number;
  revision: string; // BIGINT comes back as string
}

const voyageDims = (row: VoyageRow): Dims => ({ x: row.dims_x, y: row.dims_y, z: row.dims_z });

interface ContainerDbRow {
  container_no: string;
  weight: number;
  dg_class: string;
  x: number | null;
  y: number | null;
  z: number | null;
}

const toContainerState = (row: ContainerDbRow): ContainerState => ({
  containerNo: row.container_no,
  weight: row.weight,
  dgClass: row.dg_class,
  position: row.x === null ? null : { x: row.x, y: row.y as number, z: row.z as number },
});

async function loadContainers(client: PoolClient, voyageId: string): Promise<ContainerState[]> {
  const { rows } = await client.query<ContainerDbRow>(
    'SELECT container_no, weight, dg_class, x, y, z FROM containers WHERE voyage_id = $1 ORDER BY container_no',
    [voyageId],
  );
  return rows.map(toContainerState);
}

async function loadColumnLimits(client: PoolClient, voyageId: string): Promise<ColumnLimit[]> {
  const { rows } = await client.query<{ x: number; y: number; max_weight: number }>(
    'SELECT x, y, max_weight FROM columns WHERE voyage_id = $1',
    [voyageId],
  );
  return rows.map((r) => ({ x: r.x, y: r.y, maxWeight: r.max_weight }));
}

async function loadIncompatibilities(client: PoolClient, voyageId: string): Promise<Incompatibility[]> {
  const { rows } = await client.query<{ class_a: string; class_b: string; min_distance: number }>(
    'SELECT class_a, class_b, min_distance FROM incompatibilities WHERE voyage_id = $1',
    [voyageId],
  );
  return rows.map((r) => ({ classA: r.class_a, classB: r.class_b, minDistance: r.min_distance }));
}

/** Lock the voyage row so layout adjustments and list issuance are serialized. */
async function lockVoyage(client: PoolClient, id: string): Promise<VoyageRow> {
  const { rows } = await client.query<VoyageRow>(
    'SELECT id, dims_x, dims_y, dims_z, revision FROM voyages WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (rows.length === 0) throw new HttpError(404, 'VOYAGE_NOT_FOUND', `voyage '${id}' does not exist`);
  return rows[0];
}

async function getVoyage(client: PoolClient, id: string): Promise<VoyageRow> {
  const { rows } = await client.query<VoyageRow>(
    'SELECT id, dims_x, dims_y, dims_z, revision FROM voyages WHERE id = $1',
    [id],
  );
  if (rows.length === 0) throw new HttpError(404, 'VOYAGE_NOT_FOUND', `voyage '${id}' does not exist`);
  return rows[0];
}

function checkRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new HttpError(
      409,
      'STALE_REVISION',
      `expected revision ${expected} but the voyage is at revision ${actual}; reload and retry`,
      { currentRevision: actual },
    );
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // -- create a voyage ------------------------------------------------------
  app.post(
    '/voyages',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body, 'body');
      const dims = requireObject(body.dims, 'dims');
      const dx = requirePositiveInt(dims.x, 'dims.x');
      const dy = requirePositiveInt(dims.y, 'dims.y');
      const dz = requirePositiveInt(dims.z, 'dims.z');
      const id =
        body.id === undefined
          ? `voy_${Math.random().toString(16).slice(2, 14)}`
          : requireNonEmptyString(body.id, 'id');

      try {
        await pool.query('INSERT INTO voyages (id, dims_x, dims_y, dims_z) VALUES ($1, $2, $3, $4)', [
          id, dx, dy, dz,
        ]);
      } catch (err) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
          throw new HttpError(409, 'VOYAGE_EXISTS', `voyage '${id}' already exists`);
        }
        throw err;
      }
      res.status(201).json({ id, dims: { x: dx, y: dy, z: dz }, revision: 0 });
    }),
  );

  // -- current voyage state ---------------------------------------------------
  app.get(
    '/voyages/:id',
    asyncHandler(async (req, res) => {
      const client = await pool.connect();
      try {
        const voyage = await getVoyage(client, req.params.id);
        const [containers, columns, incompatibilities] = await Promise.all([
          loadContainers(client, voyage.id),
          loadColumnLimits(client, voyage.id),
          loadIncompatibilities(client, voyage.id),
        ]);
        const { rows: lists } = await client.query<{ id: string; revision: string; issued_at: string }>(
          'SELECT id, revision, issued_at FROM load_lists WHERE voyage_id = $1 ORDER BY id',
          [voyage.id],
        );
        const revision = Number(voyage.revision);
        const latest = lists.length > 0 ? lists[lists.length - 1] : null;
        res.json({
          id: voyage.id,
          dims: voyageDims(voyage),
          revision,
          columns,
          containers,
          incompatibilities,
          loadLists: lists.map((l) => ({ id: Number(l.id), revision: Number(l.revision), issuedAt: l.issued_at })),
          currentLoadList:
            latest && Number(latest.revision) === revision
              ? { id: Number(latest.id), revision: Number(latest.revision), issuedAt: latest.issued_at }
              : null,
        });
      } finally {
        client.release();
      }
    }),
  );

  // -- register / replace column weight limits --------------------------------
  app.put(
    '/voyages/:id/columns',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body, 'body');
      const items = requireArray(body.columns, 'columns');

      const client = await pool.connect();
      try {
        const voyage = await getVoyage(client, req.params.id);
        const dims = voyageDims(voyage);
        const parsed: ColumnLimit[] = items.map((raw, i) => {
          const item = requireObject(raw, `columns[${i}]`);
          const pos = { x: item.x, y: item.y, z: 0 };
          if (!Number.isInteger(item.x) || !Number.isInteger(item.y) || !isValidPosition(pos, dims)) {
            throw new HttpError(400, 'INVALID_POSITION', `columns[${i}] has invalid coordinates`, {
              value: { x: item.x, y: item.y },
              grid: dims,
            });
          }
          const maxWeight = item.maxWeight;
          if (typeof maxWeight !== 'number' || !Number.isFinite(maxWeight) || maxWeight < 0) {
            throw new HttpError(400, 'INVALID_WEIGHT', `columns[${i}].maxWeight must be a non-negative finite number`, {
              value: maxWeight,
            });
          }
          return { x: item.x as number, y: item.y as number, maxWeight };
        });

        await client.query('BEGIN');
        for (const c of parsed) {
          await client.query(
            `INSERT INTO columns (voyage_id, x, y, max_weight) VALUES ($1, $2, $3, $4)
             ON CONFLICT (voyage_id, x, y) DO UPDATE SET max_weight = EXCLUDED.max_weight`,
            [voyage.id, c.x, c.y, c.maxWeight],
          );
        }
        await client.query('COMMIT');
        res.json({ voyageId: voyage.id, columns: parsed });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -- register containers ------------------------------------------------------
  app.put(
    '/voyages/:id/containers',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body, 'body');
      const items = requireArray(body.containers, 'containers');

      const parsed = items.map((raw, i) => {
        const item = requireObject(raw, `containers[${i}]`);
        return {
          containerNo: requireNonEmptyString(item.containerNo, `containers[${i}].containerNo`),
          weight: requireWeight(item.weight, `containers[${i}].weight`),
          dgClass: requireNonEmptyString(item.dgClass, `containers[${i}].dgClass`),
        };
      });
      const seen = new Set<string>();
      for (const c of parsed) {
        if (seen.has(c.containerNo)) {
          throw badBody(`duplicate containerNo '${c.containerNo}' in request`);
        }
        seen.add(c.containerNo);
      }

      const client = await pool.connect();
      try {
        const voyage = await getVoyage(client, req.params.id);
        await client.query('BEGIN');
        for (const c of parsed) {
          // Upsert keeps any existing slot assignment.
          await client.query(
            `INSERT INTO containers (voyage_id, container_no, weight, dg_class)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (voyage_id, container_no)
             DO UPDATE SET weight = EXCLUDED.weight, dg_class = EXCLUDED.dg_class`,
            [voyage.id, c.containerNo, c.weight, c.dgClass],
          );
        }
        await client.query('COMMIT');
        res.json({ voyageId: voyage.id, registered: parsed });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -- register incompatible class pairs ----------------------------------------
  app.put(
    '/voyages/:id/incompatibilities',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body, 'body');
      const items = requireArray(body.pairs, 'pairs');

      const parsed: Incompatibility[] = items.map((raw, i) => {
        const item = requireObject(raw, `pairs[${i}]`);
        const classA = requireNonEmptyString(item.classA, `pairs[${i}].classA`);
        const classB = requireNonEmptyString(item.classB, `pairs[${i}].classB`);
        const minDistance = requirePositiveInt(item.minDistance, `pairs[${i}].minDistance`);
        return { classA, classB, minDistance };
      });

      const client = await pool.connect();
      try {
        const voyage = await getVoyage(client, req.params.id);
        await client.query('BEGIN');
        for (const p of parsed) {
          const [a, b] = p.classA <= p.classB ? [p.classA, p.classB] : [p.classB, p.classA];
          await client.query(
            `INSERT INTO incompatibilities (voyage_id, class_a, class_b, min_distance)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (voyage_id, class_a, class_b)
             DO UPDATE SET min_distance = EXCLUDED.min_distance`,
            [voyage.id, a, b, p.minDistance],
          );
        }
        await client.query('COMMIT');
        res.json({ voyageId: voyage.id, pairs: parsed });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -- batch-adjust slot assignments (optimistic concurrency via revision) -----
  app.post(
    '/voyages/:id/assignments',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body, 'body');
      const expectedRevision = requireRevision(body.expectedRevision);
      const moves = requireArray(body.moves, 'moves');
      if (moves.length === 0) throw badBody("'moves' must contain at least one move");

      interface Move {
        containerNo: string;
        position: Position | null;
      }
      const parsedMoves: Move[] = [];
      const seen = new Set<string>();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const voyage = await lockVoyage(client, req.params.id);
        const dims = voyageDims(voyage);
        checkRevision(expectedRevision, Number(voyage.revision));

        for (let i = 0; i < moves.length; i++) {
          const item = requireObject(moves[i], `moves[${i}]`);
          const containerNo = requireNonEmptyString(item.containerNo, `moves[${i}].containerNo`);
          if (seen.has(containerNo)) {
            throw new HttpError(
              400,
              'DUPLICATE_CONTAINER_IN_BATCH',
              `container '${containerNo}' appears more than once in the batch; one container may hold at most one slot`,
              { containerNo },
            );
          }
          seen.add(containerNo);
          if (item.position === null || item.position === undefined) {
            parsedMoves.push({ containerNo, position: null });
          } else if (isValidPosition(item.position, dims)) {
            parsedMoves.push({ containerNo, position: item.position });
          } else {
            throw new HttpError(400, 'INVALID_POSITION', `moves[${i}] has invalid coordinates`, {
              containerNo,
              value: item.position,
              grid: { x: [0, dims.x - 1], y: [0, dims.y - 1], z: [0, dims.z - 1] },
            });
          }
        }

        const containers = await loadContainers(client, voyage.id);
        const byNo = new Map(containers.map((c) => [c.containerNo, c]));
        const unknown = parsedMoves.filter((m) => !byNo.has(m.containerNo)).map((m) => m.containerNo);
        if (unknown.length > 0) {
          throw new HttpError(400, 'UNKNOWN_CONTAINER', 'the batch references unregistered containers', {
            unknownContainers: unknown,
          });
        }

        // Apply the whole batch to the in-memory layout, then validate only
        // the resulting final layout (this is what makes in-batch swaps legal).
        for (const move of parsedMoves) {
          byNo.get(move.containerNo)!.position = move.position;
        }

        const [limits, incompatibilities] = await Promise.all([
          loadColumnLimits(client, voyage.id),
          loadIncompatibilities(client, voyage.id),
        ]);
        const violations: Violation[] = validateLayout(containers, limits, incompatibilities);
        if (violations.length > 0) {
          throw new HttpError(422, 'LAYOUT_VIOLATION', `batch rejected: ${violations.length} violation(s)`, {
            violations,
          });
        }

        for (const move of parsedMoves) {
          await client.query(
            'UPDATE containers SET x = $3, y = $4, z = $5 WHERE voyage_id = $1 AND container_no = $2',
            [voyage.id, move.containerNo, move.position?.x ?? null, move.position?.y ?? null, move.position?.z ?? null],
          );
        }
        const { rows } = await client.query<{ revision: string }>(
          'UPDATE voyages SET revision = revision + 1 WHERE id = $1 RETURNING revision',
          [voyage.id],
        );
        await client.query('COMMIT');

        res.json({
          voyageId: voyage.id,
          revision: Number(rows[0].revision),
          applied: parsedMoves,
          layout: containers.map((c) => ({ containerNo: c.containerNo, position: c.position })),
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -- issue a load list (freezes the current layout) ---------------------------
  app.post(
    '/voyages/:id/load-list',
    asyncHandler(async (req, res) => {
      const body = requireObject(req.body ?? {}, 'body');
      const expectedRevision =
        body.expectedRevision === undefined ? undefined : requireRevision(body.expectedRevision);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Same row lock as assignments: a concurrent adjustment either commits
        // before us (we then see the new revision) or waits until we commit.
        const voyage = await lockVoyage(client, req.params.id);
        const revision = Number(voyage.revision);
        if (expectedRevision !== undefined) checkRevision(expectedRevision, revision);

        const containers = await loadContainers(client, voyage.id);
        const unassigned = containers.filter((c) => c.position === null).map((c) => c.containerNo);
        if (unassigned.length > 0) {
          throw new HttpError(422, 'UNASSIGNED_CONTAINERS', 'all containers must be assigned to a slot before issuing a load list', {
            unassignedContainers: unassigned,
          });
        }

        const [limits, incompatibilities] = await Promise.all([
          loadColumnLimits(client, voyage.id),
          loadIncompatibilities(client, voyage.id),
        ]);
        const content = {
          voyageId: voyage.id,
          revision,
          dims: voyageDims(voyage),
          columns: limits,
          incompatibilities,
          containers: containers.map((c) => ({
            containerNo: c.containerNo,
            weight: c.weight,
            dgClass: c.dgClass,
            position: c.position,
          })),
        };
        const { rows } = await client.query<{ id: string; issued_at: string }>(
          'INSERT INTO load_lists (voyage_id, revision, content) VALUES ($1, $2, $3) RETURNING id, issued_at',
          [voyage.id, revision, JSON.stringify(content)],
        );
        await client.query('COMMIT');

        res.status(201).json({
          id: Number(rows[0].id),
          voyageId: voyage.id,
          revision,
          issuedAt: rows[0].issued_at,
          content,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }),
  );

  // -- list issued load lists ----------------------------------------------------
  app.get(
    '/voyages/:id/load-lists',
    asyncHandler(async (req, res) => {
      const client = await pool.connect();
      try {
        const voyage = await getVoyage(client, req.params.id);
        const { rows } = await client.query<{ id: string; revision: string; issued_at: string }>(
          'SELECT id, revision, issued_at FROM load_lists WHERE voyage_id = $1 ORDER BY id',
          [voyage.id],
        );
        res.json({
          voyageId: voyage.id,
          currentRevision: Number(voyage.revision),
          loadLists: rows.map((r) => ({ id: Number(r.id), revision: Number(r.revision), issuedAt: r.issued_at })),
        });
      } finally {
        client.release();
      }
    }),
  );

  // -- fetch one frozen load list --------------------------------------------------
  app.get(
    '/voyages/:id/load-lists/:listId',
    asyncHandler(async (req, res) => {
      const listId = Number(req.params.listId);
      if (!Number.isInteger(listId)) throw badBody('load list id must be an integer');
      const { rows } = await pool.query<{ id: string; voyage_id: string; revision: string; issued_at: string; content: unknown }>(
        'SELECT id, voyage_id, revision, issued_at, content FROM load_lists WHERE id = $1 AND voyage_id = $2',
        [listId, req.params.id],
      );
      if (rows.length === 0) {
        throw new HttpError(404, 'LOAD_LIST_NOT_FOUND', `load list ${listId} does not exist for voyage '${req.params.id}'`);
      }
      const row = rows[0];
      res.json({
        id: Number(row.id),
        voyageId: row.voyage_id,
        revision: Number(row.revision),
        issuedAt: row.issued_at,
        content: row.content,
      });
    }),
  );

  // -- error handling ---------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'request body is not valid JSON' } });
      return;
    }
    console.error('[error]', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  return app;
}
