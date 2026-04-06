'use strict';

const { getConfig } = require('./config');

// Authority scores per tier
const TIER_SCORES = {
  1: 95,
  2: 70,
  3: 40,
};

/**
 * Build a lookup map from config source lists.
 * Called lazily so config can be updated via dashboard.
 *
 * @returns {Map<string, number>} domain -> tier
 */
function buildTierMap() {
  const config = getConfig();
  const map = new Map();

  const tier1 = Array.isArray(config.TIER1_SOURCES) ? config.TIER1_SOURCES : [];
  const tier2 = Array.isArray(config.TIER2_SOURCES) ? config.TIER2_SOURCES : [];
  const tier3 = Array.isArray(config.TIER3_SOURCES) ? config.TIER3_SOURCES : [];

  for (const domain of tier1) {
    map.set(domain.toLowerCase(), 1);
  }
  for (const domain of tier2) {
    map.set(domain.toLowerCase(), 2);
  }
  for (const domain of tier3) {
    map.set(domain.toLowerCase(), 3);
  }

  return map;
}

/**
 * Normalize a domain for lookup.
 * Strips "www." prefix and lowercases.
 *
 * @param {string} domain
 * @returns {string}
 */
function normalizeDomain(domain) {
  if (!domain) return '';
  let d = domain.toLowerCase().trim();
  if (d.startsWith('www.')) {
    d = d.slice(4);
  }
  return d;
}

/**
 * Get the authority tier for a domain.
 *
 * @param {string} domain - e.g. "ndtv.com" or "www.ndtv.com"
 * @returns {1|2|3} Tier number (unknown domains default to 3)
 */
function getAuthorityTier(domain) {
  const tierMap = buildTierMap();
  const normalized = normalizeDomain(domain);

  // Direct match
  if (tierMap.has(normalized)) {
    return tierMap.get(normalized);
  }

  // Subdomain match: check if normalized ends with .knownDomain
  for (const [known, tier] of tierMap) {
    if (normalized.endsWith('.' + known)) {
      return tier;
    }
  }

  return 3;
}

/**
 * Get the authority score for a domain.
 *
 * @param {string} domain
 * @returns {number} Score (95, 70, or 40)
 */
function getAuthorityScore(domain) {
  const tier = getAuthorityTier(domain);
  return TIER_SCORES[tier] || TIER_SCORES[3];
}

module.exports = {
  getAuthorityTier,
  getAuthorityScore,
  normalizeDomain,
};
