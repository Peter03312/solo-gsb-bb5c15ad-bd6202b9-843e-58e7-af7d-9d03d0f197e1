"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const pg_mem_1 = require("pg-mem");
const app_1 = require("../src/app");
const db_1 = require("../src/db");
// Boot the real Express app against an in-memory PostgreSQL (pg-mem) and
// exercise the whole HTTP surface: registration, batch assignment with
// revision checks, all rejection paths, and load-list issuance/freezing.
let baseUrl;
let server;
node_test_1.default.before(async () => {
    const db = (0, pg_mem_1.newDb)();
    const { Pool } = db.adapters.createPg();
    (0, db_1.setPool)(new Pool());
    await (0, db_1.migrate)();
    const app = (0, app_1.createApp)();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
node_test_1.default.after(async () => {
    server.close();
    await db_1.pool.end();
});
async function api(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
}
(0, node_test_1.default)('end-to-end stowage workflow', async (t) => {
    await t.test('create voyage with invalid dims -> 400', async () => {
        const r = await api('POST', '/voyages', { id: 'BAD', dims: { x: 0, y: 2, z: 3 } });
        strict_1.default.equal(r.status, 400);
        strict_1.default.equal(r.body.error.code, 'BAD_REQUEST');
    });
    await t.test('create voyage -> 201', async () => {
        const r = await api('POST', '/voyages', { id: 'V1', dims: { x: 2, y: 2, z: 3 } });
        strict_1.default.equal(r.status, 201);
        strict_1.default.equal(r.body.revision, 0);
        strict_1.default.deepEqual(r.body.dims, { x: 2, y: 2, z: 3 });
    });
    await t.test('duplicate voyage id -> 409', async () => {
        const r = await api('POST', '/voyages', { id: 'V1', dims: { x: 1, y: 1, z: 1 } });
        strict_1.default.equal(r.status, 409);
        strict_1.default.equal(r.body.error.code, 'VOYAGE_EXISTS');
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
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.columns.length, 4);
    });
    await t.test('column limit out of grid -> 400 INVALID_POSITION', async () => {
        const r = await api('PUT', '/voyages/V1/columns', { columns: [{ x: 5, y: 0, maxWeight: 1 }] });
        strict_1.default.equal(r.status, 400);
        strict_1.default.equal(r.body.error.code, 'INVALID_POSITION');
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
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.registered.length, 4);
    });
    await t.test('invalid container weight -> 400 INVALID_WEIGHT', async () => {
        for (const weight of [0, -5, 'heavy', null]) {
            const r = await api('PUT', '/voyages/V1/containers', {
                containers: [{ containerNo: 'CX', weight, dgClass: '3' }],
            });
            strict_1.default.equal(r.status, 400, `weight=${weight}`);
            strict_1.default.equal(r.body.error.code, 'INVALID_WEIGHT');
        }
    });
    await t.test('register incompatibility 3 <-> 5.1 min distance 2', async () => {
        const r = await api('PUT', '/voyages/V1/incompatibilities', {
            pairs: [{ classA: '3', classB: '5.1', minDistance: 2 }],
        });
        strict_1.default.equal(r.status, 200);
    });
    await t.test('invalid minDistance -> 400', async () => {
        const r = await api('PUT', '/voyages/V1/incompatibilities', {
            pairs: [{ classA: '3', classB: '8', minDistance: 0 }],
        });
        strict_1.default.equal(r.status, 400);
    });
    await t.test('stale revision -> 409 STALE_REVISION', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 7,
            moves: [{ containerNo: 'C1', position: { x: 0, y: 0, z: 0 } }],
        });
        strict_1.default.equal(r.status, 409);
        strict_1.default.equal(r.body.error.code, 'STALE_REVISION');
        strict_1.default.equal(r.body.error.details.currentRevision, 0);
    });
    await t.test('unknown container -> 400 UNKNOWN_CONTAINER', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 0,
            moves: [{ containerNo: 'GHOST', position: { x: 0, y: 0, z: 0 } }],
        });
        strict_1.default.equal(r.status, 400);
        strict_1.default.equal(r.body.error.code, 'UNKNOWN_CONTAINER');
        strict_1.default.deepEqual(r.body.error.details.unknownContainers, ['GHOST']);
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
            strict_1.default.equal(r.status, 400, JSON.stringify(position));
            strict_1.default.equal(r.body.error.code, 'INVALID_POSITION');
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
        strict_1.default.equal(r.status, 400);
        strict_1.default.equal(r.body.error.code, 'DUPLICATE_CONTAINER_IN_BATCH');
    });
    await t.test('slot collision -> 422 POSITION_OCCUPIED with slot and containers', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 0,
            moves: [
                { containerNo: 'C1', position: { x: 0, y: 0, z: 0 } },
                { containerNo: 'C2', position: { x: 0, y: 0, z: 0 } },
            ],
        });
        strict_1.default.equal(r.status, 422);
        strict_1.default.equal(r.body.error.code, 'LAYOUT_VIOLATION');
        const v = r.body.error.details.violations.find((x) => x.rule === 'POSITION_OCCUPIED');
        strict_1.default.ok(v, 'expected POSITION_OCCUPIED violation');
        strict_1.default.deepEqual(v.containers, ['C1', 'C2']);
        strict_1.default.deepEqual(v.positions, [{ x: 0, y: 0, z: 0 }]);
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
        strict_1.default.equal(r.status, 422);
        const rules = r.body.error.details.violations.map((v) => v.rule).sort();
        // C1-C2 and C2-C3 are each too close (distance 1 < 2), plus the column is overweight.
        strict_1.default.deepEqual(rules, ['COLUMN_OVERWEIGHT', 'INCOMPATIBLE_DISTANCE', 'INCOMPATIBLE_DISTANCE']);
        const ow = r.body.error.details.violations.find((v) => v.rule === 'COLUMN_OVERWEIGHT');
        strict_1.default.equal(ow.totalWeight, 34);
        strict_1.default.equal(ow.maxWeight, 30);
        strict_1.default.deepEqual(ow.containers, ['C1', 'C2', 'C3']);
    });
    await t.test('floating container -> 422 COLUMN_GAP', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 0,
            moves: [{ containerNo: 'C1', position: { x: 0, y: 0, z: 1 } }],
        });
        strict_1.default.equal(r.status, 422);
        strict_1.default.equal(r.body.error.details.violations[0].rule, 'COLUMN_GAP');
    });
    await t.test('rejected batches change nothing (revision still 0)', async () => {
        const r = await api('GET', '/voyages/V1');
        strict_1.default.equal(r.body.revision, 0);
        strict_1.default.ok(r.body.containers.every((c) => c.position === null));
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
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.revision, 1);
    });
    await t.test('issue load list -> 201, freezes revision 1 layout', async () => {
        const r = await api('POST', '/voyages/V1/load-list', {});
        strict_1.default.equal(r.status, 201);
        strict_1.default.equal(r.body.revision, 1);
        strict_1.default.equal(r.body.content.containers.length, 4);
    });
    await t.test('register C5, then issuing fails while it is unassigned', async () => {
        await api('PUT', '/voyages/V1/containers', {
            containers: [{ containerNo: 'C5', weight: 6, dgClass: '8' }],
        });
        const r = await api('POST', '/voyages/V1/load-list', {});
        strict_1.default.equal(r.status, 422);
        strict_1.default.equal(r.body.error.code, 'UNASSIGNED_CONTAINERS');
        strict_1.default.deepEqual(r.body.error.details.unassignedContainers, ['C5']);
    });
    await t.test('assign C5 -> revision 2', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 1,
            moves: [{ containerNo: 'C5', position: { x: 1, y: 0, z: 0 } }],
        });
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.revision, 2);
    });
    await t.test('in-batch swap of C4 and C5 is allowed', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 2,
            moves: [
                { containerNo: 'C4', position: { x: 1, y: 0, z: 0 } }, // was C5's slot
                { containerNo: 'C5', position: { x: 0, y: 1, z: 0 } }, // was C4's slot
            ],
        });
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.revision, 3);
        const layout = Object.fromEntries(r.body.layout.map((c) => [c.containerNo, c.position]));
        strict_1.default.deepEqual(layout.C4, { x: 1, y: 0, z: 0 });
        strict_1.default.deepEqual(layout.C5, { x: 0, y: 1, z: 0 });
    });
    await t.test('unassign back to the yard with position null', async () => {
        const r = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 3,
            moves: [{ containerNo: 'C5', position: null }],
        });
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.revision, 4);
        const issue = await api('POST', '/voyages/V1/load-list', {});
        strict_1.default.equal(issue.status, 422);
        strict_1.default.equal(issue.body.error.code, 'UNASSIGNED_CONTAINERS');
        // restore
        const fix = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 4,
            moves: [{ containerNo: 'C5', position: { x: 0, y: 1, z: 0 } }],
        });
        strict_1.default.equal(fix.status, 200);
        strict_1.default.equal(fix.body.revision, 5);
    });
    await t.test('issue with stale expectedRevision -> 409', async () => {
        const r = await api('POST', '/voyages/V1/load-list', { expectedRevision: 1 });
        strict_1.default.equal(r.status, 409);
        strict_1.default.equal(r.body.error.code, 'STALE_REVISION');
    });
    await t.test('issue current load list -> 201 at revision 5', async () => {
        const r = await api('POST', '/voyages/V1/load-list', { expectedRevision: 5 });
        strict_1.default.equal(r.status, 201);
        strict_1.default.equal(r.body.revision, 5);
    });
    await t.test('old lists are retained; current list tracks the layout revision', async () => {
        const lists = await api('GET', '/voyages/V1/load-lists');
        strict_1.default.equal(lists.status, 200);
        strict_1.default.deepEqual(lists.body.loadLists.map((l) => l.revision), [1, 5]);
        const state = await api('GET', '/voyages/V1');
        strict_1.default.equal(state.body.revision, 5);
        strict_1.default.equal(state.body.currentLoadList.revision, 5);
        const frozen = await api('GET', `/voyages/V1/load-lists/${lists.body.loadLists[0].id}`);
        strict_1.default.equal(frozen.status, 200);
        strict_1.default.equal(frozen.body.revision, 1);
        const c4 = frozen.body.content.containers.find((c) => c.containerNo === 'C4');
        strict_1.default.deepEqual(c4.position, { x: 0, y: 1, z: 0 }); // pre-swap layout, frozen forever
    });
    await t.test('frozen list does not change after later adjustments', async () => {
        const before = await api('GET', '/voyages/V1/load-lists/2');
        const move = await api('POST', '/voyages/V1/assignments', {
            expectedRevision: 5,
            moves: [{ containerNo: 'C4', position: { x: 1, y: 0, z: 0 } }],
        });
        strict_1.default.equal(move.status, 200);
        const after = await api('GET', '/voyages/V1/load-lists/2');
        strict_1.default.deepEqual(after.body.content, before.body.content);
        // and the voyage now has no current (up-to-date) list
        const state = await api('GET', '/voyages/V1');
        strict_1.default.equal(state.body.revision, 6);
        strict_1.default.equal(state.body.currentLoadList, null);
    });
    await t.test('unknown voyage -> 404', async () => {
        const r = await api('GET', '/voyages/NOPE');
        strict_1.default.equal(r.status, 404);
        strict_1.default.equal(r.body.error.code, 'VOYAGE_NOT_FOUND');
    });
    await t.test('unknown load list -> 404', async () => {
        const r = await api('GET', '/voyages/V1/load-lists/999');
        strict_1.default.equal(r.status, 404);
        strict_1.default.equal(r.body.error.code, 'LOAD_LIST_NOT_FOUND');
    });
});
