import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import test from 'node:test';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app';
import { migrate, pool, setPool } from '../src/db';

// Boot the real Express app against an in-memory PostgreSQL (pg-mem) and
// exercise the whole HTTP surface: registration, batch assignment with
// revision checks, all rejection paths, and load-list issuance/freezing.

let baseUrl: string;
let server: Server;

test.before(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  setPool(new Pool() as never);
  await migrate();

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.after(async () => {
  server.close();
  await pool.end();
});

interface ApiResult {
  status: number;
  body: Record<string, never> & any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test('end-to-end stowage workflow', async (t) => {
  await t.test('create voyage with invalid dims -> 400', async () => {
    const r = await api('POST', '/voyages', { id: 'BAD', dims: { x: 0, y: 2, z: 3 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BAD_REQUEST');
  });

  await t.test('create voyage -> 201', async () => {
    const r = await api('POST', '/voyages', { id: 'V1', dims: { x: 2, y: 2, z: 3 } });
    assert.equal(r.status, 201);
    assert.equal(r.body.revision, 0);
    assert.deepEqual(r.body.dims, { x: 2, y: 2, z: 3 });
  });

  await t.test('duplicate voyage id -> 409', async () => {
    const r = await api('POST', '/voyages', { id: 'V1', dims: { x: 1, y: 1, z: 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'VOYAGE_EXISTS');
  });

  await t.test('register column limits', async () => {
    const r = await api('PUT', '/voyages/V1/columns', {
      columns: [
        { x: 0, y: 0, maxWeight: 30 },
        { x: 0, y: 1, maxWeight: 100 },
        { x: 1, y: 0, maxWeight: 100 },
        { x: 1, y: 1, maxWeight: 100 },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.columns.length, 4);
  });

  await t.test('column limit out of grid -> 400 INVALID_POSITION', async () => {
    const r = await api('PUT', '/voyages/V1/columns', { columns: [{ x: 5, y: 0, maxWeight: 1 }] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_POSITION');
  });

  await t.test('register containers', async () => {
    const r = await api('PUT', '/voyages/V1/containers', {
      containers: [
        { containerNo: 'C1', weight: 12, dgClass: '3' },
        { containerNo: 'C2', weight: 12, dgClass: '5.1' },
        { containerNo: 'C3', weight: 10, dgClass: '3' },
        { containerNo: 'C4', weight: 8, dgClass: '8' },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.registered.length, 4);
  });

  await t.test('invalid container weight -> 400 INVALID_WEIGHT', async () => {
    for (const weight of [0, -5, 'heavy', null]) {
      const r = await api('PUT', '/voyages/V1/containers', {
        containers: [{ containerNo: 'CX', weight, dgClass: '3' }],
      });
      assert.equal(r.status, 400, `weight=${weight}`);
      assert.equal(r.body.error.code, 'INVALID_WEIGHT');
    }
  });

  await t.test('register incompatibility 3 <-> 5.1 min distance 2', async () => {
    const r = await api('PUT', '/voyages/V1/incompatibilities', {
      pairs: [{ classA: '3', classB: '5.1', minDistance: 2 }],
    });
    assert.equal(r.status, 200);
  });

  await t.test('invalid minDistance -> 400', async () => {
    const r = await api('PUT', '/voyages/V1/incompatibilities', {
      pairs: [{ classA: '3', classB: '8', minDistance: 0 }],
    });
    assert.equal(r.status, 400);
  });

  await t.test('stale revision -> 409 STALE_REVISION', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 7,
      moves: [{ containerNo: 'C1', position: { x: 0, y: 0, z: 0 } }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'STALE_REVISION');
    assert.equal(r.body.error.details.currentRevision, 0);
  });

  await t.test('unknown container -> 400 UNKNOWN_CONTAINER', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [{ containerNo: 'GHOST', position: { x: 0, y: 0, z: 0 } }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'UNKNOWN_CONTAINER');
    assert.deepEqual(r.body.error.details.unknownContainers, ['GHOST']);
  });

  await t.test('invalid coordinates -> 400 INVALID_POSITION', async () => {
    for (const position of [
      { x: 2, y: 0, z: 0 }, // x out of range
      { x: 0, y: 0, z: -1 }, // negative z
      { x: 0, y: 0, z: 1.5 }, // non-integer
      { x: 0, y: 0 }, // missing z
    ]) {
      const r = await api('POST', '/voyages/V1/assignments', {
        expectedRevision: 0,
        moves: [{ containerNo: 'C1', position }],
      });
      assert.equal(r.status, 400, JSON.stringify(position));
      assert.equal(r.body.error.code, 'INVALID_POSITION');
    }
  });

  await t.test('same container twice in one batch -> 400', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [
        { containerNo: 'C1', position: { x: 0, y: 0, z: 0 } },
        { containerNo: 'C1', position: { x: 0, y: 0, z: 1 } },
      ],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'DUPLICATE_CONTAINER_IN_BATCH');
  });

  await t.test('slot collision -> 422 POSITION_OCCUPIED with slot and containers', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [
        { containerNo: 'C1', position: { x: 0, y: 0, z: 0 } },
        { containerNo: 'C2', position: { x: 0, y: 0, z: 0 } },
      ],
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'LAYOUT_VIOLATION');
    const v = r.body.error.details.violations.find((x: { rule: string }) => x.rule === 'POSITION_OCCUPIED');
    assert.ok(v, 'expected POSITION_OCCUPIED violation');
    assert.deepEqual(v.containers, ['C1', 'C2']);
    assert.deepEqual(v.positions, [{ x: 0, y: 0, z: 0 }]);
  });

  await t.test('overweight + segregation breach -> 422 listing every violation', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [
        { containerNo: 'C1', position: { x: 0, y: 0, z: 0 } }, // 12t, class 3
        { containerNo: 'C2', position: { x: 0, y: 0, z: 1 } }, // 12t, class 5.1 (too close)
        { containerNo: 'C3', position: { x: 0, y: 0, z: 2 } }, // 10t -> column 34t > 30t
      ],
    });
    assert.equal(r.status, 422);
    const rules = r.body.error.details.violations.map((v: { rule: string }) => v.rule).sort();
    // C1-C2 and C2-C3 are each too close (distance 1 < 2), plus the column is overweight.
    assert.deepEqual(rules, ['COLUMN_OVERWEIGHT', 'INCOMPATIBLE_DISTANCE', 'INCOMPATIBLE_DISTANCE']);
    const ow = r.body.error.details.violations.find((v: { rule: string }) => v.rule === 'COLUMN_OVERWEIGHT');
    assert.equal(ow.totalWeight, 34);
    assert.equal(ow.maxWeight, 30);
    assert.deepEqual(ow.containers, ['C1', 'C2', 'C3']);
  });

  await t.test('floating container -> 422 COLUMN_GAP', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [{ containerNo: 'C1', position: { x: 0, y: 0, z: 1 } }],
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.details.violations[0].rule, 'COLUMN_GAP');
  });

  await t.test('rejected batches change nothing (revision still 0)', async () => {
    const r = await api('GET', '/voyages/V1');
    assert.equal(r.body.revision, 0);
    assert.ok(r.body.containers.every((c: { position: unknown }) => c.position === null));
  });

  await t.test('valid full placement -> 200, revision becomes 1', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 0,
      moves: [
        { containerNo: 'C1', position: { x: 0, y: 0, z: 0 } },
        { containerNo: 'C3', position: { x: 0, y: 0, z: 1 } },
        { containerNo: 'C2', position: { x: 1, y: 1, z: 0 } }, // distance 2 from C1 and C3
        { containerNo: 'C4', position: { x: 0, y: 1, z: 0 } },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 1);
  });

  await t.test('issue load list -> 201, freezes revision 1 layout', async () => {
    const r = await api('POST', '/voyages/V1/load-list', {});
    assert.equal(r.status, 201);
    assert.equal(r.body.revision, 1);
    assert.equal(r.body.content.containers.length, 4);
  });

  await t.test('register C5, then issuing fails while it is unassigned', async () => {
    await api('PUT', '/voyages/V1/containers', {
      containers: [{ containerNo: 'C5', weight: 6, dgClass: '8' }],
    });
    const r = await api('POST', '/voyages/V1/load-list', {});
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'UNASSIGNED_CONTAINERS');
    assert.deepEqual(r.body.error.details.unassignedContainers, ['C5']);
  });

  await t.test('assign C5 -> revision 2', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 1,
      moves: [{ containerNo: 'C5', position: { x: 1, y: 0, z: 0 } }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 2);
  });

  await t.test('in-batch swap of C4 and C5 is allowed', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 2,
      moves: [
        { containerNo: 'C4', position: { x: 1, y: 0, z: 0 } }, // was C5's slot
        { containerNo: 'C5', position: { x: 0, y: 1, z: 0 } }, // was C4's slot
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 3);
    const layout = Object.fromEntries(
      r.body.layout.map((c: { containerNo: string; position: unknown }) => [c.containerNo, c.position]),
    );
    assert.deepEqual(layout.C4, { x: 1, y: 0, z: 0 });
    assert.deepEqual(layout.C5, { x: 0, y: 1, z: 0 });
  });

  await t.test('unassign back to the yard with position null', async () => {
    const r = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 3,
      moves: [{ containerNo: 'C5', position: null }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.revision, 4);
    const issue = await api('POST', '/voyages/V1/load-list', {});
    assert.equal(issue.status, 422);
    assert.equal(issue.body.error.code, 'UNASSIGNED_CONTAINERS');
    // restore
    const fix = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 4,
      moves: [{ containerNo: 'C5', position: { x: 0, y: 1, z: 0 } }],
    });
    assert.equal(fix.status, 200);
    assert.equal(fix.body.revision, 5);
  });

  await t.test('issue with stale expectedRevision -> 409', async () => {
    const r = await api('POST', '/voyages/V1/load-list', { expectedRevision: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'STALE_REVISION');
  });

  await t.test('issue current load list -> 201 at revision 5', async () => {
    const r = await api('POST', '/voyages/V1/load-list', { expectedRevision: 5 });
    assert.equal(r.status, 201);
    assert.equal(r.body.revision, 5);
  });

  await t.test('old lists are retained; current list tracks the layout revision', async () => {
    const lists = await api('GET', '/voyages/V1/load-lists');
    assert.equal(lists.status, 200);
    assert.deepEqual(
      lists.body.loadLists.map((l: { revision: number }) => l.revision),
      [1, 5],
    );

    const state = await api('GET', '/voyages/V1');
    assert.equal(state.body.revision, 5);
    assert.equal(state.body.currentLoadList.revision, 5);

    const frozen = await api('GET', `/voyages/V1/load-lists/${lists.body.loadLists[0].id}`);
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.revision, 1);
    const c4 = frozen.body.content.containers.find((c: { containerNo: string }) => c.containerNo === 'C4');
    assert.deepEqual(c4.position, { x: 0, y: 1, z: 0 }); // pre-swap layout, frozen forever
  });

  await t.test('frozen list does not change after later adjustments', async () => {
    const before = await api('GET', '/voyages/V1/load-lists/2');
    const move = await api('POST', '/voyages/V1/assignments', {
      expectedRevision: 5,
      moves: [{ containerNo: 'C4', position: { x: 1, y: 0, z: 0 } }],
    });
    assert.equal(move.status, 200);
    const after = await api('GET', '/voyages/V1/load-lists/2');
    assert.deepEqual(after.body.content, before.body.content);
    // and the voyage now has no current (up-to-date) list
    const state = await api('GET', '/voyages/V1');
    assert.equal(state.body.revision, 6);
    assert.equal(state.body.currentLoadList, null);
  });

  await t.test('unknown voyage -> 404', async () => {
    const r = await api('GET', '/voyages/NOPE');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'VOYAGE_NOT_FOUND');
  });

  await t.test('unknown load list -> 404', async () => {
    const r = await api('GET', '/voyages/V1/load-lists/999');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'LOAD_LIST_NOT_FOUND');
  });
});
