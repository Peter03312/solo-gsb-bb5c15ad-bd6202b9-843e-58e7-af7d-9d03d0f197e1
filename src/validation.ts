import {
  classPairKey,
  columnKey,
  ColumnLimit,
  ContainerState,
  Dims,
  Incompatibility,
  Position,
  positionKey,
} from './types';

export type ViolationRule =
  | 'POSITION_OCCUPIED'
  | 'COLUMN_GAP'
  | 'COLUMN_OVERWEIGHT'
  | 'INCOMPATIBLE_DISTANCE';

export interface Violation {
  rule: ViolationRule;
  message: string;
  containers: string[];
  positions: Position[];
  [extra: string]: unknown;
}

export const manhattan = (a: Position, b: Position): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

export function isValidPosition(p: unknown, dims: Dims): p is Position {
  if (typeof p !== 'object' || p === null) return false;
  const { x, y, z } = p as Record<string, unknown>;
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    (x as number) >= 0 &&
    (x as number) < dims.x &&
    (y as number) >= 0 &&
    (y as number) < dims.y &&
    (z as number) >= 0 &&
    (z as number) < dims.z
  );
}

/**
 * Validates a complete layout (the state AFTER a batch of moves is applied).
 * Coordinate range checks happen at the API boundary; this function only
 * checks layout rules. Every rule violation is collected; the caller rejects
 * the whole batch if the returned list is non-empty.
 *
 * Rules:
 *  - one slot holds at most one container (a container holds at most one slot
 *    by construction, and duplicates inside a batch are rejected earlier);
 *  - each column (x, y) is occupied continuously from the bottom tier up;
 *  - each column's total weight stays within its registered limit
 *    (columns without a registered limit are unrestricted);
 *  - every incompatible class pair keeps at least its minimum Manhattan
 *    distance; pairs without a rule are compatible.
 */
export function validateLayout(
  containers: ContainerState[],
  limits: ColumnLimit[],
  incompatibilities: Incompatibility[],
): Violation[] {
  const violations: Violation[] = [];
  type Placed = ContainerState & { position: Position };
  const placed = containers.filter((c): c is Placed => c.position !== null);

  // --- one slot, at most one container -------------------------------------
  const bySlot = new Map<string, Placed[]>();
  for (const c of placed) {
    const key = positionKey(c.position);
    const list = bySlot.get(key);
    if (list) list.push(c);
    else bySlot.set(key, [c]);
  }
  for (const occupants of bySlot.values()) {
    if (occupants.length > 1) {
      const pos = occupants[0].position;
      violations.push({
        rule: 'POSITION_OCCUPIED',
        message: `slot (${pos.x},${pos.y},${pos.z}) would hold ${occupants.length} containers`,
        containers: occupants.map((c) => c.containerNo).sort(),
        positions: [pos],
      });
    }
  }

  // --- per-column continuity and weight ------------------------------------
  const limitByColumn = new Map<string, number>();
  for (const l of limits) limitByColumn.set(columnKey(l.x, l.y), l.maxWeight);

  const byColumn = new Map<string, Placed[]>();
  for (const c of placed) {
    const key = columnKey(c.position.x, c.position.y);
    const list = byColumn.get(key);
    if (list) list.push(c);
    else byColumn.set(key, [c]);
  }

  for (const [key, members] of byColumn) {
    const sorted = [...members].sort((a, b) => a.position.z - b.position.z);
    // Occupied tiers must be exactly 0..k-1: no gap, and the bottom tier used.
    // Distinct tiers are compared so a slot collision (reported separately)
    // does not also surface as a gap.
    const tiers = [...new Set(sorted.map((c) => c.position.z))];
    const gapAt = tiers.findIndex((z, i) => z !== i);
    if (gapAt !== -1) {
      const [x, y] = key.split(',').map(Number);
      violations.push({
        rule: 'COLUMN_GAP',
        message:
          `column (${x},${y}) is not occupied continuously from the bottom: ` +
          `tiers used are [${tiers.join(', ')}]`,
        containers: sorted.map((c) => c.containerNo).sort(),
        positions: sorted.map((c) => c.position),
        column: { x, y },
      });
    }

    const limit = limitByColumn.get(key);
    if (limit !== undefined) {
      const total = sorted.reduce((sum, c) => sum + c.weight, 0);
      if (total > limit) {
        const [x, y] = key.split(',').map(Number);
        violations.push({
          rule: 'COLUMN_OVERWEIGHT',
          message: `column (${x},${y}) total weight ${total} exceeds limit ${limit}`,
          containers: sorted.map((c) => c.containerNo).sort(),
          positions: sorted.map((c) => c.position),
          column: { x, y },
          totalWeight: total,
          maxWeight: limit,
        });
      }
    }
  }

  // --- segregation between incompatible classes -----------------------------
  const minDistanceByPair = new Map<string, { classA: string; classB: string; minDistance: number }>();
  for (const rule of incompatibilities) {
    minDistanceByPair.set(classPairKey(rule.classA, rule.classB), rule);
  }

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const rule = minDistanceByPair.get(classPairKey(a.dgClass, b.dgClass));
      if (!rule) continue; // no rule registered -> compatible
      const actual = manhattan(a.position, b.position);
      if (actual < rule.minDistance) {
        violations.push({
          rule: 'INCOMPATIBLE_DISTANCE',
          message:
            `containers '${a.containerNo}' (class ${a.dgClass}) and '${b.containerNo}' (class ${b.dgClass}) ` +
            `are ${actual} apart, less than the required ${rule.minDistance}`,
          containers: [a.containerNo, b.containerNo],
          positions: [a.position, b.position],
          classA: a.dgClass,
          classB: b.dgClass,
          requiredDistance: rule.minDistance,
          actualDistance: actual,
        });
      }
    }
  }

  return violations;
}
