import { describe, expect, it } from "vitest";

import { pickWeighted } from "~/deploy/split";

const rows = [
  { id: "a", trafficWeight: 90 },
  { id: "b", trafficWeight: 10 },
];

describe("pickWeighted", () => {
  it("returns null for an empty list", () => {
    expect(pickWeighted([])).toBeNull();
  });

  it("selects proportional to weight (deterministic via injected rng)", () => {
    // roll = rng()*100. 0.0 -> 0 lands in a's [0,90); 0.89 -> 89 still a; 0.95 -> 95 in b.
    expect(pickWeighted(rows, () => 0.0)?.id).toBe("a");
    expect(pickWeighted(rows, () => 0.89)?.id).toBe("a");
    expect(pickWeighted(rows, () => 0.95)?.id).toBe("b");
  });

  it("falls back to the first row when all weights are 0 (fully drained env)", () => {
    const drained = [
      { id: "x", trafficWeight: 0 },
      { id: "y", trafficWeight: 0 },
    ];
    expect(pickWeighted(drained, () => 0.5)?.id).toBe("x");
  });

  it("treats negative weights as 0", () => {
    const mixed = [
      { id: "neg", trafficWeight: -5 },
      { id: "pos", trafficWeight: 10 },
    ];
    expect(pickWeighted(mixed, () => 0.0)?.id).toBe("pos");
  });
});
