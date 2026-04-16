const SIMILARITY_THRESHOLD = 0.8;

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

function similarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Returns best match only if score >= threshold (used for !verify flow)
function findBestMatch(input, candidates, threshold = SIMILARITY_THRESHOLD) {
  const result = findBestMatchRaw(input, candidates);
  if (!result) return null;

  if (result.score >= threshold) {
    console.log(`[fuzzy] "${input}" → "${result.match}" (${(result.score * 100).toFixed(1)}% match)`);
    return result;
  }

  console.log(`[fuzzy] No match above ${(threshold * 100).toFixed(0)}% for "${input}" (best: "${result.match}" at ${(result.score * 100).toFixed(1)}%)`);
  return null;
}

// Always returns the best match with its score — caller decides threshold
function findBestMatchRaw(input, candidates) {
  if (!candidates.length) return null;

  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = similarity(input, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { match: best, score: bestScore };
}

module.exports = { findBestMatch, findBestMatchRaw, similarity };
