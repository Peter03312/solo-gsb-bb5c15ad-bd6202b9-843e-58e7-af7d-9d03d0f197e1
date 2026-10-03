"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const validation_1 = require("../src/validation");
const box = (containerNo, weight, dgClass, position) => ({ containerNo, weight, dgClass, position });
(0, node_test_1.default)('manhattan distance', () => {
    strict_1.default.equal((0, validation_1.manhattan)({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }), 6);
    strict_1.default.equal((0, validation_1.manhattan)({ x: 2, y: 2, z: 2 }, { x: 2, y: 2, z: 2 }), 0);
});
(0, node_test_1.default)('valid layout passes', () => {
    const containers = [
        box('A', 10, '3', { x: 0, y: 0, z: 0 }),
        box('B', 10, '3', { x: 0, y: 0, z: 1 }),
        box('C', 5, '8', { x: 3, y: 3, z: 0 }),
        box('D', 5, '8', null), // unassigned containers are allowed
    ];
    const violations = (0, validation_1.validateLayout)(containers, [{ x: 0, y: 0, maxWeight: 25 }], [{ classA: '3', classB: '8', minDistance: 4 }]);
    strict_1.default.deepEqual(violations, []);
});
(0, node_test_1.default)('two containers in one slot -> POSITION_OCCUPIED', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 0, z: 0 })], [], []);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'POSITION_OCCUPIED');
    strict_1.default.deepEqual(violations[0].containers, ['A', 'B']);
    strict_1.default.deepEqual(violations[0].positions, [{ x: 0, y: 0, z: 0 }]);
});
(0, node_test_1.default)('floating container -> COLUMN_GAP', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '3', { x: 0, y: 0, z: 1 })], [], []);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'COLUMN_GAP');
});
(0, node_test_1.default)('gap in the middle of a column -> COLUMN_GAP', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 0, z: 2 })], [], []);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'COLUMN_GAP');
    strict_1.default.deepEqual(violations[0].containers, ['A', 'B']);
});
(0, node_test_1.default)('column over its weight limit -> COLUMN_OVERWEIGHT', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 10, '3', { x: 0, y: 0, z: 0 }), box('B', 11, '3', { x: 0, y: 0, z: 1 })], [{ x: 0, y: 0, maxWeight: 20 }], []);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'COLUMN_OVERWEIGHT');
    strict_1.default.equal(violations[0].totalWeight, 21);
    strict_1.default.equal(violations[0].maxWeight, 20);
});
(0, node_test_1.default)('column without a registered limit is unrestricted', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 9999, '3', { x: 0, y: 0, z: 0 })], [], []);
    strict_1.default.deepEqual(violations, []);
});
(0, node_test_1.default)('incompatible pair too close -> INCOMPATIBLE_DISTANCE', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '5.1', { x: 1, y: 0, z: 0 })], [], [{ classA: '3', classB: '5.1', minDistance: 3 }]);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'INCOMPATIBLE_DISTANCE');
    strict_1.default.equal(violations[0].actualDistance, 1);
    strict_1.default.equal(violations[0].requiredDistance, 3);
});
(0, node_test_1.default)('incompatible pair far enough passes; unregistered pair is compatible', () => {
    const violations = (0, validation_1.validateLayout)([
        box('A', 1, '3', { x: 0, y: 0, z: 0 }),
        box('B', 1, '5.1', { x: 3, y: 0, z: 0 }),
        box('C', 1, '8', { x: 0, y: 0, z: 1 }), // no rule for (3,8) or (5.1,8)
    ], [], [{ classA: '3', classB: '5.1', minDistance: 3 }]);
    strict_1.default.deepEqual(violations, []);
});
(0, node_test_1.default)('class pair rule is order-independent', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '5.1', { x: 0, y: 0, z: 0 }), box('B', 1, '3', { x: 0, y: 1, z: 0 })], [], [{ classA: '3', classB: '5.1', minDistance: 2 }]);
    strict_1.default.equal(violations.length, 1);
    strict_1.default.equal(violations[0].rule, 'INCOMPATIBLE_DISTANCE');
});
(0, node_test_1.default)('unassigned containers skip distance checks', () => {
    const violations = (0, validation_1.validateLayout)([box('A', 1, '3', { x: 0, y: 0, z: 0 }), box('B', 1, '5.1', null)], [], [{ classA: '3', classB: '5.1', minDistance: 10 }]);
    strict_1.default.deepEqual(violations, []);
});
(0, node_test_1.default)('multiple violations are all reported', () => {
    const violations = (0, validation_1.validateLayout)([
        box('A', 10, '3', { x: 0, y: 0, z: 0 }),
        box('B', 10, '5.1', { x: 0, y: 0, z: 0 }), // collision + too close + overweight
    ], [{ x: 0, y: 0, maxWeight: 15 }], [{ classA: '3', classB: '5.1', minDistance: 2 }]);
    const rules = violations.map((v) => v.rule).sort();
    strict_1.default.deepEqual(rules, ['COLUMN_OVERWEIGHT', 'INCOMPATIBLE_DISTANCE', 'POSITION_OCCUPIED']);
});
