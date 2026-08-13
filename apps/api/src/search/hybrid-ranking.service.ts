import { Injectable } from "@nestjs/common";

/**
 * Hybrid ranking is intentionally application-internal. Meilisearch scores and
 * cosine similarities vary by provider/version and must never enter an API or log.
 */
export interface LexicalRankingCandidate {
  readonly id: string;
  readonly rawScore: number | null;
  readonly rank: number;
}

export interface SemanticRankingCandidate {
  readonly id: string;
  readonly similarity: number;
}

export interface AuthoritativeRankingFact {
  readonly id: string;
  readonly updatedAt: Date;
}

export interface HybridRankedCandidate {
  readonly id: string;
  readonly lexicalScore: number;
  readonly semanticScore: number;
  readonly combinedScore: number;
}

/**
 * Lexical relevance has the larger share because exact/typo term intent is
 * normally more precise; semantic relevance broadens recall without dominating.
 */
export const LEXICAL_WEIGHT = 0.6;
export const SEMANTIC_WEIGHT = 0.4;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Relative rank normalization: after descending sort, score = 1-i/(n-1), where
 * i is the first index of the candidate's tied value. One valid item is 1; a
 * flat valid list is all 1. Invalid values are deterministic 0 and do not
 * participate in n. This is robust to provider score scale and distribution.
 */
export function normalizeRelativeScores(
  candidates: readonly { readonly id: string; readonly value: number }[],
): ReadonlyMap<string, number> {
  const valid = candidates
    .filter(({ value }) => finite(value))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const result = new Map<string, number>();
  for (const candidate of candidates) result.set(candidate.id, 0);
  if (valid.length === 0) return result;
  if (valid.every(({ value }) => value === valid[0]?.value)) {
    for (const candidate of valid) result.set(candidate.id, 1);
    return result;
  }
  for (let index = 0; index < valid.length; index += 1) {
    const candidate = valid[index];
    if (candidate === undefined) continue;
    const tieIndex = valid.findIndex(({ value }) => value === candidate.value);
    result.set(candidate.id, Math.max(0, Math.min(1, 1 - tieIndex / (valid.length - 1))));
  }
  return result;
}

@Injectable()
export class HybridRankingService {
  merge(
    lexical: readonly LexicalRankingCandidate[],
    semantic: readonly SemanticRankingCandidate[],
  ): readonly HybridRankedCandidate[] {
    const lexicalScores = normalizeRelativeScores(
      lexical.map((candidate) => ({
        id: candidate.id,
        // Pinned meilisearch@0.60.0 returns `_rankingScore`; provider order is
        // the deterministic fallback when that optional value is absent.
        value: finite(candidate.rawScore ?? Number.NaN)
          ? (candidate.rawScore as number)
          : -candidate.rank,
      })),
    );
    const semanticScores = normalizeRelativeScores(
      semantic.map((candidate) => ({
        id: candidate.id,
        value: finite(candidate.similarity)
          ? Math.max(0, Math.min(1, candidate.similarity))
          : Number.NaN,
      })),
    );
    const ids = new Set([...lexical.map(({ id }) => id), ...semantic.map(({ id }) => id)]);
    return [...ids].map((id) => {
      const lexicalScore = lexicalScores.get(id) ?? 0;
      const semanticScore = semanticScores.get(id) ?? 0;
      return Object.freeze({
        id,
        lexicalScore,
        semanticScore,
        combinedScore: LEXICAL_WEIGHT * lexicalScore + SEMANTIC_WEIGHT * semanticScore,
      });
    });
  }

  /** Authoritative facts are supplied only after PostgreSQL note.read filtering. */
  finalize(
    merged: readonly HybridRankedCandidate[],
    authorized: ReadonlyMap<string, AuthoritativeRankingFact>,
  ): readonly HybridRankedCandidate[] {
    return merged
      .filter(({ id }) => authorized.has(id))
      .sort((left, right) => {
        const score = right.combinedScore - left.combinedScore;
        if (score !== 0) return score;
        const updated =
          (authorized.get(right.id)?.updatedAt.getTime() ?? 0) -
          (authorized.get(left.id)?.updatedAt.getTime() ?? 0);
        return updated !== 0 ? updated : left.id.localeCompare(right.id);
      });
  }
}
