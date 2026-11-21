// SPDX-License-Identifier: Apache-2.0
// Lexical discovery (BM25).
//
// The MVP ranks topics and agents by word overlap with a free-text query.
// It is a stand-in for the semantic matcher of the full design: the HTTP
// interface is the same, so embeddings can replace this module later.

const STOPWORDS = new Set([
  // English
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'when', 'with',
  // Spanish
  'al', 'con', 'cualquier', 'cuando', 'de', 'del', 'el', 'en', 'es', 'la', 'las', 'lo', 'los', 'me', 'mi', 'para', 'por',
  'que', 'se', 'sobre', 'su', 'un', 'una', 'y', 'o',
]);

const K1 = 1.2;
const B = 0.75;

function stem(token) {
  // Crude plural/vowel stripping so "requests" ~ "request" and "revisiones" ~ "revision".
  return token.length > 3 ? token.replace(/(es|s|e)$/, '') : token;
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(stem);
}

/**
 * Ranks documents against a query.
 * @param {string} query
 * @param {Array<{ text: string, ref: any }>} docs
 * @returns {Array<{ ref: any, score: number }>} best first, only documents with a positive score
 */
export function rank(query, docs) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || docs.length === 0) return [];

  const indexed = docs.map((doc) => {
    const tokens = tokenize(doc.text);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { ref: doc.ref, tf, length: tokens.length };
  });
  const avgLength = indexed.reduce((sum, doc) => sum + doc.length, 0) / indexed.length || 1;

  const idf = new Map();
  for (const term of terms) {
    const df = indexed.reduce((count, doc) => count + (doc.tf.has(term) ? 1 : 0), 0);
    idf.set(term, Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5)));
  }

  const results = [];
  for (const doc of indexed) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      score += (idf.get(term) * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength));
    }
    if (score > 0) results.push({ ref: doc.ref, score: Math.round(score * 1000) / 1000 });
  }
  return results.sort((a, b) => b.score - a.score);
}
