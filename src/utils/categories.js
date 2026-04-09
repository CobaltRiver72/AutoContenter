'use strict';

// MSN India category taxonomy — used for source_category tagging and
// WordPress category mapping at publish time.
// Keys are the internal slug used in source_category.
// label is the human-readable name for the WordPress category.

var NEWS_CATEGORIES = {
  // ── News ──────────────────────────────────────────────────────────
  'india-news':       { label: 'India',         msn: 'India',       lang: 'en' },
  'world-news':       { label: 'World',          msn: 'World',       lang: 'en' },
  'politics':         { label: 'Politics',       msn: 'Politics',    lang: 'en' },
  'business':         { label: 'Business',       msn: 'Money',       lang: 'en' },
  'technology':       { label: 'Technology',     msn: 'Technology',  lang: 'en' },
  'science':          { label: 'Science',        msn: 'Science',     lang: 'en' },
  'crime':            { label: 'Crime',          msn: 'Crime',       lang: 'en' },
  // ── Sports ────────────────────────────────────────────────────────
  'sports':           { label: 'Sports',         msn: 'Sports',      lang: 'en' },
  'cricket':          { label: 'Cricket',        msn: 'Cricket',     lang: 'en' },
  'football':         { label: 'Football',       msn: 'Football',    lang: 'en' },
  // ── Entertainment ─────────────────────────────────────────────────
  'entertainment':    { label: 'Entertainment',  msn: 'Entertainment', lang: 'en' },
  'bollywood':        { label: 'Bollywood',      msn: 'Bollywood',   lang: 'en' },
  'television':       { label: 'Television',     msn: 'Television',  lang: 'en' },
  // ── Lifestyle ─────────────────────────────────────────────────────
  'health':           { label: 'Health',         msn: 'Health & Fitness', lang: 'en' },
  'food':             { label: 'Food',           msn: 'Food & Drink', lang: 'en' },
  'travel':           { label: 'Travel',         msn: 'Travel',      lang: 'en' },
  'fashion':          { label: 'Fashion',        msn: 'Fashion & Beauty', lang: 'en' },
  // ── Autos ─────────────────────────────────────────────────────────
  'autos':            { label: 'Autos',          msn: 'Autos',       lang: 'en' },
  // ── Hindi ─────────────────────────────────────────────────────────
  'hindi-news':          { label: 'Hindi News',          msn: null, lang: 'hi' },
  'hindi-sports':        { label: 'Hindi Sports',        msn: null, lang: 'hi' },
  'hindi-entertainment': { label: 'Hindi Entertainment', msn: null, lang: 'hi' },
  'hindi-business':      { label: 'Hindi Business',      msn: null, lang: 'hi' },
};

module.exports = { NEWS_CATEGORIES };
