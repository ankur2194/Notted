import { describe, expect, it } from "vitest";

import { HybridRankingService, normalizeRelativeScores } from "./hybrid-ranking.service";
import { HYBRID_RANKING_FIXTURE } from "./test-fixtures/hybrid-ranking.fixture";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";

describe("hybrid normalization and ranking", () => {
  it("normalizes one item, flat scores, ties and invalid values without NaN", () => {
    expect([...normalizeRelativeScores([{ id: A, value: 7 }]).values()]).toEqual([1]);
    expect([
      ...normalizeRelativeScores([
        { id: A, value: 2 },
        { id: B, value: 2 },
      ]).values(),
    ]).toEqual([1, 1]);
    const scores = normalizeRelativeScores([
      { id: A, value: 3 },
      { id: B, value: 3 },
      { id: C, value: Number.POSITIVE_INFINITY },
    ]);
    expect(scores.get(A)).toBe(1);
    expect(scores.get(B)).toBe(1);
    expect(scores.get(C)).toBe(0);
    expect([...scores.values()].every(Number.isFinite)).toBe(true);
  });

  it("keeps disjoint lexical and semantic candidates eligible with missing score zero", () => {
    const merged = new HybridRankingService().merge(
      [{ id: A, rawScore: 0.9, rank: 0 }],
      [{ id: B, similarity: 0.8 }],
    );
    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: A, lexicalScore: 1, semanticScore: 0, combinedScore: 0.6 }),
        expect.objectContaining({ id: B, lexicalScore: 0, semanticScore: 1, combinedScore: 0.4 }),
      ]),
    );
  });

  it("filters inaccessible candidates before updatedAt and UUID tie-breaks", () => {
    const ranker = new HybridRankingService();
    const merged = ranker.merge(
      [
        { id: C, rawScore: 1, rank: 0 },
        { id: B, rawScore: 1, rank: 1 },
        { id: A, rawScore: 1, rank: 2 },
      ],
      [],
    );
    const ranked = ranker.finalize(
      merged,
      new Map([
        [A, { id: A, updatedAt: new Date("2026-01-01") }],
        [B, { id: B, updatedAt: new Date("2026-01-02") }],
        // C models an inaccessible/deleted/control-tenant candidate.
      ]),
    );
    expect(ranked.map(({ id }) => id)).toEqual([B, A]);
  });

  it("orders curated exact, typo and conceptual fixture scores predictably", () => {
    const ranker = new HybridRankingService();
    const ranked = ranker.finalize(
      ranker.merge(HYBRID_RANKING_FIXTURE.lexical, HYBRID_RANKING_FIXTURE.semantic),
      new Map(
        [...HYBRID_RANKING_FIXTURE.authorizedUpdatedAt].map(([id, updatedAt]) => [
          id,
          { id, updatedAt },
        ]),
      ),
    );
    expect(ranked.map(({ id }) => id)).toEqual(HYBRID_RANKING_FIXTURE.expectedOrder);
  });
});
