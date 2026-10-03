import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLayout, manhattan } from '../src/validation';
import { ContainerState } from '../src/types';

const box = (
  containerNo: string,
  weight: number,
  dgClass: string,
  position: { x: number; y: number; z: number } | null,
): ContainerState => ({ containerNo, weight, dgClass, position });

test('manhattan distance', () => {
  assert.equal(manhattan({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }), 6);
  assert.equal(manhattan({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 }), 0);
});

test('valid layout passes', () => {
  const containers = [
    box('A', 10, '3', { x: 0, y: 0, z: 0 }),
    box('B', 10, '3', { x: 0, y: 0, z: 1 }),
    box('C', 5, '8', { x: 3, y: 3, z: 0 }),
    box('D', 5, '8', null), // unassigned containers are allowed
  ];
  const violations = validateLayout(
    containers,
    [{ x: 0, y: 0, maxWeight: 25 }],
    [{ classA: '3', classB: '8', minDistance: 4 }],
  );
  assert.deepEqual(violations, []);
});

test('two containers in one slot -> POSITION_OCCUPIED', () => {
  const violations = validateLayout(
    [box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 0, z: 0 })],
    [],
    [],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'POSITION_OCCUPIED');
  assert.deepEqual(violations[0].containers, ['A', 'B']);
  assert.deepEqual(violations[0].positions, [{ x: 0, y: 0, z: 0 }]);
});

test('floating container -> COLUMN_GAP', () => {
  const violations = validateLayout([box('A', 1, '3', { x: 0, y: 0, z: 1 })], [], []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'COLUMN_GAP');
});

test('gap in the middle of a column -> COLUMN_GAP', () => {
  const violations = validateLayout(
    [box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 0, z: 2 })],
    [],
    [],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'COLUMN_GAP');
  assert.deepEqual(violations[0].containers, ['A', 'B']);
});

test('column over its weight limit -> COLUMN_OVERWEIGHT', () => {
  const violations = validateLayout(
    [box('A', 10, '3', { x: 0, y: 0, z: 0 }), box('B', 11, '3', { x: 0, y: 0, z: 1 })],
    [{ x: 0, y: 0, maxWeight: 20 }],
    [],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'COLUMN_OVERWEIGHT');
  assert.equal(violations[0].totalWeight, 21);
  assert.equal(violations[0].maxWeight, 20);
});

test('column without a registered limit is unrestricted', () => {
  const violations = validateLayout([box('A', 9999, '3', { x: 0, y: 0, z: 0 })], [], []);
  assert.deepEqual(violations, []);
});

test('incompatible pair too close -> INCOMPATIBLE_DISTANCE', () => {
  const violations = validateLayout(
    [box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '5.1', { x: 1, y: 0, z: 0 })],
    [],
    [{ classA: '3', classB: '5.1', minDistance: 3 }],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'INCOMPATIBLE_DISTANCE');
  assert.equal(violations[0].actualDistance, 1);
  assert.equal(violations[0].requiredDistance, 3);
});

test('incompatible pair far enough passes; unregistered pair is compatible', () => {
  const violations = validateLayout(
    [
      box('A', 1, '3', { x: 0, y: 0, z: 0 }),
      box('B', 1, '5.1', { x: 3, y: 0, z: 0 }),
      box('C', 1, '8', { x: 0, y: 0, z: 1 }), // no rule for (3,8) or (5.1,8)
    ],
    [],
    [{ classA: '3', classB: '5.1', minDistance: 3 }],
  );
  assert.deepEqual(violations, []);
});

test('class pair rule is order-independent', () => {
  const violations = validateLayout(
    [box('A', 1, '5.1', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 1, z: 0 })],
    [],
    [{ classA: '3', classB: '5.1', minDistance: 2 }],
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'INCOMPATIBLE_DISTANCE');
});

test('unassigned containers skip distance checks', () => {
  const violations = validateLayout(
    [box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '5.1', null)],
    [],
    [{ classA: '3', classB: '5.1', minDistance: 10 }],
  );
  assert.deepEqual(violations, []);
});

test('multiple violations are all reported', () => {
  const violations = validateLayout(
    [
      box('A', 10, '3', { x: 0, y: 0, z: 0 }),
      box('B', 10, '5.1', { x: 0, y: 0, z: 0 }), // collision + too close + overweight
    ],
    [{ x: 0, y: 0, maxWeight: 15 }],
    [{ classA: '3', classB: '5.1', minDistance: 2 }],
  );
  const rules = violations.map((v) => v.rule).sort();
  assert.deepEqual(rules, ['COLUMN_OVERWEIGHT', 'INCOMPATIBLE_DISTANCE', 'POSITION_OCCUPIED']);
});
