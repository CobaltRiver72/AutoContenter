'use strict';

var { convertMarkdownToHtml } = require('../utils/markdown-to-html');
var { sanitizeAxiosError } = require('../utils/safe-http');

// Model definitions — used by both backend and sent to frontend
var AI_MODELS = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tier: 'Fast & Cheap', type: 'standard' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'Balanced', type: 'standard' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'Latest Balanced', type: 'standard' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', tier: 'Best Quality', type: 'standard' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'Latest Best', type: 'standard' },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'Fast & Cheap', type: 'standard' },
    { id: 'gpt-4.1', name: 'GPT-4.1', tier: 'Latest', type: 'standard' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'Latest Fast', type: 'standard' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', tier: 'Cheapest', type: 'standard' },
    { id: 'o3', name: 'O3', tier: 'Reasoning', type: 'reasoning' },
    { id: 'o3-mini', name: 'O3 Mini', tier: 'Reasoning Fast', type: 'reasoning' },
    { id: 'o4-mini', name: 'O4 Mini', tier: 'Latest Reasoning', type: 'reasoning' },
  ],
  // OpenRouter list is fetched dynamically — see fetchOpenRouterFreeModels()
  openrouter: [],
};

function countWords(html) {
  var text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').length : 0;
}

// ─── API Key Format Validator ─────────────────────────────────────────────
//
// Each provider has a distinct, stable key prefix. A key pasted into the
// wrong field will slip past naive "is it set?" checks and only fail when
// the actual API call is made — producing confusing 401s with someone
// else's key in the error message. This validator catches the mistake up
// front, both on save (so users see a clear error) and at call time (so
// the fallback chain skips a provider whose stored key is obviously wrong
// for that provider).
//
//   Anthropic   → sk-ant-...
//   OpenRouter  → sk-or-v1-...
//   OpenAI      → anything starting with sk- that is NOT the above two
//
function validateKeyFormat(provider, key) {
  if (!key || typeof key !== 'string') return { ok: false, reason: 'missing' };
  var k = key.trim();
  if (provider === 'openrouter') {
    if (k.indexOf('sk-or-v1-') !== 0) {
      return { ok: false, reason: 'OpenRouter keys must start with "sk-or-v1-"' };
    }
  } else if (provider === 'anthropic') {
    if (k.indexOf('sk-ant-') !== 0) {
      return { ok: false, reason: 'Anthropic keys must start with "sk-ant-"' };
    }
  } else if (provider === 'openai') {
    if (k.indexOf('sk-or-v1-') === 0) {
      return { ok: false, reason: 'this looks like an OpenRouter key (sk-or-v1-), not an OpenAI key' };
    }
    if (k.indexOf('sk-ant-') === 0) {
      return { ok: false, reason: 'this looks like an Anthropic key (sk-ant-), not an OpenAI key' };
    }
  }
  return { ok: true };
}

// ─── Source Content Cleaner ────────────────────────────────────────────────
//
// Strips noise from scraped/extracted source articles so the AI sees the
// actual story body, not navigation, bylines, social-share strings, or
// "Also Read" link clutter. Defensive — never throws; returns empty string
// for falsy input.
//
function cleanSourceContent(text) {
  if (!text || typeof text !== 'string') return '';
  var out = text;

  try {
    // Strip "Also Read", "Read More", "Read Also" link/heading lines
    out = out.replace(/(?:^|\n)\s*(?:also\s*read|read\s*more|read\s*also|recommended|trending|more\s*from)\s*[:\-–—].*?(?=\n|$)/gi, '\n');
    out = out.replace(/(?:^|\n)\s*\[?\s*(?:also\s*read|read\s*more|read\s*also)\s*\]?[:\-–—]?[^\n]*/gi, '\n');

    // Strip social share / follow strings
    out = out.replace(/(?:share|tweet|whatsapp|facebook|telegram|copy\s*link|click\s*to\s*share)\s*(?:on|this|via)?[^\n]{0,80}/gi, '');
    out = out.replace(/follow\s+us\s+on[^\n]{0,120}/gi, '');
    out = out.replace(/subscribe\s+to[^\n]{0,120}/gi, '');

    // Strip bylines and metadata lines like "By Author Name | Updated: ..."
    out = out.replace(/(?:^|\n)\s*by\s+[A-Z][^\n]{0,80}(?:\||\bupdated\b|\bpublished\b)[^\n]{0,120}/gi, '\n');
    out = out.replace(/(?:^|\n)\s*(?:last\s+)?updated\s*[:\-]\s*[^\n]{0,100}/gi, '\n');
    out = out.replace(/(?:^|\n)\s*published\s*(?:on|at)?\s*[:\-]\s*[^\n]{0,100}/gi, '\n');

    // Strip standalone author credit lines ("By John Doe")
    out = out.replace(/(?:^|\n)\s*by\s+[A-Z][a-zA-Z'.\-\s]{2,40}\s*(?=\n|$)/g, '\n');

    // Strip image captions and photo credits
    out = out.replace(/(?:^|\n)\s*(?:photo|image|file\s*photo|representative\s*image|credit)\s*[:\-–—][^\n]{0,150}/gi, '\n');

    // Strip ad/promo markers
    out = out.replace(/(?:advertisement|sponsored|promoted)\s*(?:content)?/gi, '');

    // Drop very short standalone lines (likely nav fragments) - keep only lines with > 30 chars
    var lines = out.split('\n');
    var kept = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (line.length === 0) {
        kept.push('');
        continue;
      }
      // Keep substantive lines, drop short nav/menu fragments
      if (line.length >= 30 || /[.!?]/.test(line)) {
        kept.push(line);
      }
    }
    out = kept.join('\n');

    // Collapse repeated blank lines
    out = out.replace(/\n{3,}/g, '\n\n');
    // Collapse repeated spaces
    out = out.replace(/[ \t]{2,}/g, ' ');

    return out.trim();
  } catch (e) {
    return text;
  }
}

// ─── SEO Prompt Builder (used by automated pipeline) ──────────────────────

function buildPrompt(article, cluster, settings) {
  var s = settings || {};

  // ─── Determine Output Language ────────────────────────────────────────────────
  // Rule: if ANY source article in the cluster is English → write in English.
  //       Only write Hindi if ALL cluster articles are Hindi (or Hindi-detected).
  // This way a mixed Hindi+English cluster about the same story always outputs English,
  // and the AI uses all sources (including Hindi ones) as research input.
  var targetLang = (s.language === 'hi' || s.language === 'en') ? s.language : null;

  if (!targetLang) {
    // Collect all articles available for language inspection
    var allClusterArticles = [];
    if (cluster && cluster.articles && Array.isArray(cluster.articles) && cluster.articles.length > 0) {
      allClusterArticles = cluster.articles;
    } else if (article) {
      allClusterArticles = [article];
    }

    var hasEnglish = false;
    var hasHindi = false;

    for (var li = 0; li < allClusterArticles.length; li++) {
      var a = allClusterArticles[li];
      if (!a) continue;
      var lang = a.language || null;

      // If language is null, detect from content
      if (!lang) {
        var detectText = (a.title || '') + ' ' +
          ((a.extracted_content || a.content_markdown || '').substring(0, 500));
        lang = /[\u0900-\u097F]{3,}/.test(detectText) ? 'hi' : 'en';
      }

      if (lang === 'en') { hasEnglish = true; }
      if (lang === 'hi') { hasHindi = true; }
    }

    // English wins if even one English source exists
    if (hasEnglish) {
      targetLang = 'en';
    } else if (hasHindi) {
      targetLang = 'hi';
    } else {
      // Absolute fallback: detect from primary article
      var detectSrc = ((article && article.title) || '') + ' ' +
        (((article && (article.extracted_content || article.content_markdown)) || '').substring(0, 1000));
      targetLang = /[\u0900-\u097F]{3,}/.test(detectSrc) ? 'hi' : 'en';
    }
  }
  // ─── End Output Language Detection ───────────────────────────────────────────

  var trendingContext = '';
  if (cluster && cluster.trends_boosted) {
    trendingContext =
      'TRENDING CONTEXT: This story is currently trending on Google Trends in India.\n' +
      'Trend Topic: ' + (cluster.trends_topic || 'N/A') + '\n' +
      'Related Queries: ' + (cluster.trends_queries || 'N/A') + '\n' +
      'Use this trending momentum — weave the trend topic into the headline and opening paragraph.\n\n';
  }

  // InfraNodus entity analysis — injected into the AI prompt so the rewriter
  // knows the topical landscape, SEO gaps, and what readers actually want.
  // This block is populated only when the user clicks "Rewrite with AI" or
  // the pipeline pre-rewrite step runs — never on autopilot extraction.
  var entityContext = '';
  if (s.infraData) {
    var infra = s.infraData;
    entityContext = '--- ENTITY ANALYSIS (from InfraNodus) ---\n';

    // ── Article text analysis (always present) ────────────────────────
    if (infra.mainTopics && infra.mainTopics.length) {
      entityContext += 'Main Topics: ' + infra.mainTopics.join(', ') + '\n';
    }
    if (infra.missingEntities && infra.missingEntities.length) {
      entityContext += 'Entities to cover: ' + infra.missingEntities.join(', ') + '\n';
    }
    if (infra.contentGaps && infra.contentGaps.length) {
      entityContext += 'Content gaps to fill: ' + infra.contentGaps.join('; ') + '\n';
    }
    if (infra.researchQuestions && infra.researchQuestions.length) {
      entityContext += 'Questions readers may have: ' + infra.researchQuestions.slice(0, 3).join('; ') + '\n';
    }
    if (infra.advice) {
      entityContext += 'Content Strategy (article analysis): ' + infra.advice + '\n';
    }
    if (infra.bigrams && infra.bigrams.length) {
      entityContext += 'Key concept pairs: ' + infra.bigrams.slice(0, 8).join(', ') + '\n';
    }
    if (infra.graphSummary) {
      entityContext += 'Entity Relationships: ' + infra.graphSummary + '\n';
    }

    // ── SEO / keyword intelligence (present when target_keyword is set) ─
    if (infra.targetKeyword) {
      entityContext += '\n[SEO intelligence for keyword: "' + infra.targetKeyword + '"]\n';
    }
    if (infra.rankingAdvice) {
      entityContext += 'What currently ranks (competitive landscape): ' + infra.rankingAdvice + '\n';
    }
    if (infra.intentAdvice) {
      entityContext += 'What readers are searching for (intent): ' + infra.intentAdvice + '\n';
    }
    if (infra.gapAdvice) {
      entityContext += 'SEO content gap opportunity (write about this): ' + infra.gapAdvice + '\n';
    }
    if (infra.relatedQueries && infra.relatedQueries.length) {
      entityContext += 'Related searches to address: ' + infra.relatedQueries.slice(0, 8).join(', ') + '\n';
    }
    if (infra.demandTopics && infra.demandTopics.length) {
      entityContext += 'High-demand underserved topics to include: ' + infra.demandTopics.slice(0, 6).join(', ') + '\n';
    }
    if (infra.demandGaps && infra.demandGaps.length) {
      entityContext += 'Demand gaps (topics people want but nobody covers well): ' + infra.demandGaps.join('; ') + '\n';
    }

    entityContext += '--- END ENTITY ANALYSIS ---';
  }

  var sourceArticles = '';
  var allArticles = (cluster && cluster.articles && Array.isArray(cluster.articles)) ? cluster.articles : [article];

  for (var i = 0; i < allArticles.length; i++) {
    var a = allArticles[i];
    // Always prefer extracted_content (Readability-parsed clean text) over raw content_markdown
    var rawContent = a.extracted_content || a.content_markdown || '';
    var content = cleanSourceContent(rawContent);
    if (content && content.length > 3000) {
      content = content.substring(0, 3000) + '\n...[truncated]';
    }

    sourceArticles += '\n--- SOURCE ' + (i + 1) + ' ---\n';
    sourceArticles += 'Title: ' + (a.extracted_title || a.title || 'Untitled') + '\n';
    sourceArticles += 'URL: ' + (a.url || '') + '\n';
    sourceArticles += 'Domain: ' + (a.domain || '') + '\n';
    sourceArticles += 'Content:\n' + (content || '[Content not available]') + '\n';
  }

  // Publication identity — pulled from settings/config so each deployment can brand correctly
  var publicationName = (s.publicationName && String(s.publicationName).trim()) || 'HDF News';
  var publicationUrl  = (s.publicationUrl  && String(s.publicationUrl).trim())  || 'https://hdfnews.com';

  var languageBlock = (targetLang === 'hi')
    ? 'LANGUAGE: Write the ENTIRE article in Hindi (Devanagari script). All headings, paragraphs, FAQ questions and answers must be in Hindi. Keep only proper nouns, brand names, and technical terms in English where Hindi readers expect them. Do NOT mix English sentences into the body.'
    : 'LANGUAGE: Write the ENTIRE article in English only. Do NOT include Hindi translations, Devanagari text, or Hindi sentences anywhere in the body, headings, or FAQ. Proper nouns and Indian-specific terms (₹, IST, city names) are fine.';

  var keywordBlock = (s.targetKeyword && s.targetKeyword.trim())
    ? 'TARGET KEYWORD: The editor has specified this exact target keyword: "' + s.targetKeyword.trim() + '". Use it as the primary keyword. Place it naturally in the H1/title, the first sentence, the meta description, the slug, at least 2 H2 subheadings, and the conclusion. Never keyword-stuff.'
    : 'TARGET KEYWORD: Identify the best long-tail keyword to target (e.g., "OnePlus Nord 6 price in India April 2026"). Prefer date/event-specific keywords with intent signals.';

  var customBlock = (s.customPrompt && s.customPrompt.trim())
    ? '\nADDITIONAL INSTRUCTIONS FROM EDITOR:\n' + s.customPrompt.trim() + '\nFollow these additional instructions while also following all the above rules.\n'
    : '';

  // ─── Master AI Content Writer Prompt v2 ─────────────────────────────────
  // Plain English, semantic triples, knowledge flow. The body comes back as
  // markdown (not HTML) so the model can focus on prose. The pipeline
  // converts it to HTML before storing in rewritten_html.
  return [
    '# IDENTITY',
    'You are the senior staff writer at ' + publicationName + ' (' + publicationUrl + '). You write for a busy Indian reader who has 60 seconds on a phone. Every sentence must earn its place. Every paragraph must read like a careful human journalist wrote it, not an AI.',
    '',
    '# WHO YOU ARE WRITING FOR',
    'A 60-second phone reader. They scan, they tap, they leave. You earn their attention with plain English, concrete facts, and a clear knowledge flow. They do not read filler. They do not read corporate copy. They read sentences that tell them something true, in order.',
    '',
    '# WHAT TO USE FROM THE SOURCES',
    'KEEP from sources:',
    '- Hard facts: who, what, when, where, why, how.',
    '- Names, numbers, dates, prices (₹), times (IST), places.',
    '- Direct quotes (only if attributed to a real, named person in the source).',
    '- Cause-and-effect relationships actually stated in the source.',
    '',
    'IGNORE from sources:',
    '- Bylines, "By X", "Updated by Y", author photo captions.',
    '- "Also Read", "Read More", "Recommended", "Trending Now".',
    '- "Share on WhatsApp", "Tweet this", "Follow us", subscribe prompts.',
    '- "Representative Image", "File Photo", photo credit lines.',
    '- "Advertisement", "Sponsored", "Promoted".',
    '- Boilerplate intros ("In today\'s fast-paced world…", "In a major development…").',
    '',
    trendingContext.replace(/\n+$/, ''),
    entityContext,
    '',
    '# STEP 1 — STRUCTURE SIGNALS (MANDATORY, COMES BEFORE THE JSON)',
    '',
    'Before you write anything else, output a <signals>...</signals> block that answers these 5 yes/no questions about the story. Plain "yes" or "no" only — no commentary.',
    '',
    '<signals>',
    'parallel_facts: yes/no',
    'steps: yes/no',
    'comparison: yes/no',
    'conditional_rules: yes/no',
    'timeline: yes/no',
    '</signals>',
    '',
    'Definitions:',
    '- parallel_facts: the story contains 3+ items of the same kind that share the same attributes (e.g. five phone models with price, RAM, battery; ten cities with rainfall numbers). If yes, you MUST include a markdown table inside body_markdown rendering those rows.',
    '- steps: the story describes a sequence of actions the reader can follow in order (how to apply, how to check status, how to register). If yes, you MUST include a numbered list (1. 2. 3.) inside body_markdown.',
    '- comparison: the story explicitly compares 2+ named things head-to-head on the same attributes (Plan A vs Plan B, iPhone vs Pixel). If yes, you MUST include a markdown comparison table.',
    '- conditional_rules: the story spells out eligibility/criteria/rules where "if X then Y" applies (eligibility for a scheme, who qualifies for a discount). If yes, you MUST include a markdown table mapping conditions to outcomes.',
    '- timeline: the story has 3+ dated events that matter in order (court hearings, policy phases, election milestones). If yes, you MUST include a date-prefixed list inside body_markdown.',
    '',
    'After the <signals> block, output the JSON. Do NOT include the <signals> block inside the JSON.',
    '',
    '# REQUIRED STRUCTURE (IN THIS EXACT ORDER)',
    '',
    '1. HEADLINE — 55–70 characters. Sharp, factual, no clickbait. Front-load the primary keyword. Never copy a source headline verbatim. Active voice.',
    '',
    '2. NEWS SUMMARY — Exactly 4 bullets. Each bullet is ONE fact, max 20 words, written as a complete plain-English sentence. Lead with the most newsworthy bullet. No opinions, no hedging, no transitions. These four bullets must collectively answer who/what/when/where for the entire story.',
    '',
    '3. BODY — 250 to 700 words of plain prose, scaled to how much the story actually contains. Use 1–2 H2 subheadings (## prefix): always at least 1 H2 unless the total body is under 300 words. Add a second H2 only when the story genuinely splits into two separate beats. Under an H2, you may use up to 2 H3 subheadings (### prefix) if the section has distinct sub-points — otherwise skip H3. The ONLY exception to structure: if a Step-1 signal is YES, you MUST include the matching structure inside the body markdown — markdown table for parallel_facts/comparison/conditional_rules, numbered list for steps, date-prefixed list for timeline. Otherwise: no images, no blockquotes, no code. Each paragraph is 2–4 sentences.',
    '',
    '4. FAQ — Exactly 3 to 4 question/answer pairs. Questions mirror real "People Also Ask" queries. Answers are 2–3 sentences, factual, drawn from the body.',
    '',
    '# THE FIVE SEMANTIC RULES (NON-NEGOTIABLE)',
    '',
    'Rule 1 — PLAIN ENGLISH. Use the simplest word that carries the meaning. "Use" not "utilize". "Help" not "facilitate". "Now" not "at the present time". A 12-year-old should be able to read every sentence aloud.',
    '',
    'Rule 2 — SVO SEMANTIC TRIPLES. Every sentence carries one Subject → Verb → Object triple. "The RBI cut the repo rate by 25 basis points." Subject = RBI, Verb = cut, Object = repo rate. No buried subjects, no nested clauses, no passive constructions where active works.',
    '',
    'Rule 3 — KNOWLEDGE FLOW. Each sentence builds on the previous one. The object of sentence 1 becomes the subject of sentence 2 wherever possible. The reader never has to backtrack. The body reads like a chain, not a pile.',
    '',
    'Rule 4 — EVERY WORD EARNS ITS PLACE. If a word can be deleted without losing meaning, delete it. No "very", no "really", no "quite", no "in order to", no "the fact that". Cut adverbs unless they add a fact.',
    '',
    'Rule 5 — HEADINGS PREVIEW + BRIDGE. If you use an H2, it must (a) preview the next 1–2 paragraphs in plain English and (b) bridge from the previous section. Never a one-word label. Never a question.',
    '',
    '# BUZZWORD BAN LIST (NEVER USE)',
    'leverage, utilize, facilitate, robust, seamless, cutting-edge, game-changer, paradigm shift, synergy, holistic, dive deep, unpack, take a look, in this article, in conclusion, it goes without saying, needless to say, it is worth noting, in today\'s fast-paced world, in a major development, sources said, according to reports (without naming the report), unprecedented (unless literally true), revolutionary, groundbreaking, world-class, best-in-class, next-generation, state-of-the-art.',
    '',
    'If you catch yourself reaching for one of these, stop and write the plain-English version instead.',
    '',
    '# TONE',
    '- Indian English news register: clear, neutral, confident.',
    '- Active voice always.',
    '- Short sentences. Average 15 words. Never exceed 25.',
    '- Concrete subjects (people, companies, agencies, places) — never "it" or "they" without an antecedent in the same sentence.',
    '- Indian context where relevant: ₹ prices, IST times, Indian cities, states, ministries.',
    '- No exclamation marks. No question marks except in FAQs. No ALL CAPS.',
    '',
    '# CROSS-LANGUAGE RULES',
    languageBlock,
    '',
    '# KEYWORD RULES',
    keywordBlock,
    '',
    '# 10 ABSOLUTE RULES — NEVER BREAK THESE',
    '1. NEVER fabricate facts, names, numbers, dates, quotes, or events not present in the sources.',
    '2. NEVER copy more than 6 consecutive words from any single source. Synthesize.',
    '3. NEVER include "As an AI", "I cannot", "I am unable", or any meta-commentary.',
    '4. NEVER include bylines, author names, "Updated on…" lines, or photo credits.',
    '5. NEVER include "Also Read", "Read More", social-share text, or navigation fragments.',
    '6. NEVER include HTML tags, markdown code fences, <script>, or inline styles inside body_markdown.',
    '7. NEVER exceed 700 words in the body. Never pad a short story to hit an arbitrary word count — 250 honest words beats 500 padded words every time.',
    '8. NEVER produce an article in a language other than the one specified above.',
    '9. NEVER use clickbait punctuation (!!!, ???) or all-caps words for emphasis.',
    '10. NEVER skip the in_brief block or the faqs section — both are mandatory.',
    customBlock,
    '# SOURCE ARTICLES',
    sourceArticles,
    '',
    '# OUTPUT FORMAT',
    'Respond with VALID JSON ONLY. No markdown code fences around the JSON. No prose before or after. The schema is:',
    '{',
    '  "headline": "55-70 character headline, primary keyword front-loaded",',
    '  "in_brief": [',
    '    "Bullet 1: complete plain-English sentence, max 20 words.",',
    '    "Bullet 2: complete plain-English sentence, max 20 words.",',
    '    "Bullet 3: complete plain-English sentence, max 20 words.",',
    '    "Bullet 4: complete plain-English sentence, max 20 words."',
    '  ],',
    '  "body_markdown": "Opening paragraph in plain prose.\\n\\nSecond paragraph that builds on the first.\\n\\n## What This Means for [Subject]\\n\\nParagraph under the H2.\\n\\nAnother paragraph continuing the point.",',
    '  "faqs": [',
    '    {"q": "Question 1?", "a": "Answer 1, 2-3 sentences."},',
    '    {"q": "Question 2?", "a": "Answer 2."},',
    '    {"q": "Question 3?", "a": "Answer 3."}',
    '  ],',
    '  "data_boxes": [',
    '    {"type": "price", "title": "Box title taken from source", "rows": [["Column A", "Column B"], ["Row label", "Row value"]]}',
    '  ],',
    '  "language": "' + targetLang + '",',
    '  "word_count_body": 487',
    '}',
    '',
    'Required field types:',
    '- headline: string, 55–70 chars',
    '- in_brief: array of EXACTLY 4 strings',
    '- body_markdown: string, 250–700 words of plain prose, 1–2 H2 headings (## prefix, at least 1 unless under 300 words), optional H3 under H2 (### prefix, max 2 per H2 section)',
    '- faqs: array of 3–4 objects, each with "q" and "a" string keys',
    '- data_boxes: array of data boxes extracted from the source articles. Each box: { "type": one of "price"/"stats"/"specs"/"comparison", "title": short descriptive string, "rows": 2D string array where the first sub-array is column headers and the rest are data rows }. Return [] if the source articles contain no concrete structured data. NEVER invent or estimate data — only include figures, prices, or statistics explicitly stated in the source articles.',
    '- language: "' + targetLang + '"',
    '- word_count_body: integer count of words in body_markdown',
  ].join('\n');
}

// ─── v2 Signals Extractor ──────────────────────────────────────────────────
//
// Pulls the Step-1 <signals>...</signals> block out of the raw model response.
// Returns { signals: {parallel_facts, steps, comparison, conditional_rules,
// timeline}, remaining: <text without signals block> }. If no block is found,
// signals is null and remaining is the original text. Defensive — never throws.
//
function extractSignals(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { signals: null, remaining: rawText || '' };
  }
  var match = rawText.match(/<signals>([\s\S]*?)<\/signals>/i);
  if (!match) {
    return { signals: null, remaining: rawText };
  }
  var inner = match[1];
  var signals = {
    parallel_facts: 'no',
    steps: 'no',
    comparison: 'no',
    conditional_rules: 'no',
    timeline: 'no',
  };
  var lines = inner.split(/\r?\n/);
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (!line) continue;
    var kv = line.split(':');
    if (kv.length < 2) continue;
    var key = kv[0].trim().toLowerCase().replace(/[^a-z_]/g, '');
    var val = kv.slice(1).join(':').trim().toLowerCase();
    if (signals.hasOwnProperty(key)) {
      signals[key] = (val === 'yes' || val === 'true' || val === '1') ? 'yes' : 'no';
    }
  }
  var remaining = rawText.replace(match[0], '').trim();
  return { signals: signals, remaining: remaining };
}

// ─── v2 Structure Validator ────────────────────────────────────────────────
//
// Given the body markdown and the signals block, returns
// { valid: bool, errors: [string] }. If a signal is YES, the body markdown
// MUST contain the matching structure:
//   parallel_facts    → markdown table (| col | col |)
//   steps             → numbered list  (^1. 2. 3. ...)
//   comparison        → markdown table (treated same as parallel_facts)
//   conditional_rules → markdown table (treated same as parallel_facts)
//   timeline          → date-prefixed list lines (e.g. "- 2024-01-01:" or "1. Jan 2024 —")
//
function validateStructure(bodyMarkdown, signals) {
  var errors = [];
  if (!signals || typeof signals !== 'object') {
    return { valid: true, errors: errors };
  }
  var body = String(bodyMarkdown || '');

  var hasTable = /^\s*\|.*\|\s*$/m.test(body) && /^\s*\|[\s:|-]+\|\s*$/m.test(body);
  var hasNumberedList = /^\s*\d+\.\s+\S/m.test(body);
  var hasTimeline = /^\s*[-*\d+.]+\s*\d{4}/m.test(body) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d/i.test(body);

  if (signals.parallel_facts === 'yes' && !hasTable) {
    errors.push('signals.parallel_facts = yes but body has no markdown table');
  }
  if (signals.steps === 'yes' && !hasNumberedList) {
    errors.push('signals.steps = yes but body has no numbered list');
  }
  if (signals.comparison === 'yes' && !hasTable) {
    errors.push('signals.comparison = yes but body has no comparison table');
  }
  if (signals.conditional_rules === 'yes' && !hasTable) {
    errors.push('signals.conditional_rules = yes but body has no conditions table');
  }
  if (signals.timeline === 'yes' && !hasTimeline) {
    errors.push('signals.timeline = yes but body has no timeline list');
  }

  return { valid: errors.length === 0, errors: errors };
}

// ─── v2 Output Parser ──────────────────────────────────────────────────────
//
// Parses model output in the v2 schema:
//   { headline, in_brief[], body_markdown, faqs[{q,a}], language, word_count_body }
//
// Strips accidental markdown fences, validates required fields and types, and
// hard-caps in_brief at 4 bullets. Throws on hard validation failures so the
// caller can fall through to the next provider. Also extracts the Step-1
// <signals> block when present and exposes it on the returned object.
//
function parseModelOutput(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Empty model output');
  }

  // Pull the signals block out before any JSON cleanup so the brace
  // extractor doesn't trip over `<signals>` characters.
  var sig = extractSignals(text);
  var signals = sig.signals;
  var cleaned = (sig.remaining || '').trim();

  // Strip code fences if the model wrapped its response despite instructions
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Some models prepend a sentence before the JSON — extract the first {...} block
  if (cleaned[0] !== '{') {
    var firstBrace = cleaned.indexOf('{');
    var lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }

  var parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Model returned invalid JSON: ' + e.message);
  }

  // Required fields
  if (typeof parsed.headline !== 'string' || parsed.headline.trim().length === 0) {
    throw new Error('Model output missing required field: headline');
  }
  if (!Array.isArray(parsed.in_brief)) {
    throw new Error('Model output missing required field: in_brief (array)');
  }
  if (typeof parsed.body_markdown !== 'string' || parsed.body_markdown.trim().length === 0) {
    throw new Error('Model output missing required field: body_markdown');
  }
  if (!Array.isArray(parsed.faqs)) {
    throw new Error('Model output missing required field: faqs (array)');
  }

  // Hard cap in_brief at 4 bullets and coerce to strings
  var inBrief = parsed.in_brief.slice(0, 4).map(function (b) {
    return String(b == null ? '' : b).trim();
  }).filter(function (b) { return b.length > 0; });

  if (inBrief.length === 0) {
    throw new Error('Model output in_brief is empty after cleaning');
  }

  // Normalize FAQs to a stable {question, answer} shape used by the rest of
  // the pipeline (publisher.js, schema markup, etc.). The v2 prompt outputs
  // {q,a} but old drafts and consumers expect {question, answer}.
  var faqs = [];
  for (var i = 0; i < parsed.faqs.length; i++) {
    var f = parsed.faqs[i] || {};
    var q = f.q || f.question || '';
    var a = f.a || f.answer || '';
    if (typeof q === 'string' && typeof a === 'string' && q.trim() && a.trim()) {
      faqs.push({ question: q.trim(), answer: a.trim() });
    }
  }

  // Parse data_boxes — optional, only keep well-formed entries
  var dataBoxes = [];
  if (Array.isArray(parsed.data_boxes)) {
    for (var di = 0; di < parsed.data_boxes.length; di++) {
      var box = parsed.data_boxes[di] || {};
      if (typeof box.title === 'string' && box.title.trim() && Array.isArray(box.rows) && box.rows.length > 0) {
        dataBoxes.push({
          type: typeof box.type === 'string' ? box.type.trim() : 'stats',
          title: box.title.trim(),
          rows: box.rows,
        });
      }
    }
  }

  return {
    headline: parsed.headline.trim(),
    inBrief: inBrief,
    bodyMarkdown: parsed.body_markdown.trim(),
    faqs: faqs,
    language: parsed.language || '',
    wordCountBody: parseInt(parsed.word_count_body, 10) || 0,
    signals: signals,
    dataBoxes: dataBoxes,
  };
}

// ─── v2 → HTML Composition ─────────────────────────────────────────────────
//
// Builds the final rewritten_html from the v2 structured output. Format:
//   <div class="hdf-in-brief">…</div>
//   <div class="hdf-body">{converted body markdown}</div>
//   <div class="hdf-faqs">…</div>
//
// Embedding the structured blocks in HTML lets the existing publisher and
// dashboard preview consume rewritten_html unchanged while still preserving
// the structured fields (in_brief_json, body_markdown) for future use.
//
function buildRewrittenHtml(inBrief, bodyMarkdown, faqs, dataBoxes) {
  var parts = [];

  // In Brief block
  if (inBrief && inBrief.length > 0) {
    parts.push('<div class="hdf-in-brief">');
    parts.push('<h2>News Summary</h2>');
    parts.push('<ul>');
    for (var i = 0; i < inBrief.length; i++) {
      parts.push('<li>' + escapeHtmlText(inBrief[i]) + '</li>');
    }
    parts.push('</ul>');
    parts.push('</div>');
  }

  // Body
  parts.push('<div class="hdf-body">');
  parts.push(convertMarkdownToHtml(bodyMarkdown));
  parts.push('</div>');

  // Data boxes — extracted from source articles by the AI (never invented)
  if (dataBoxes && dataBoxes.length > 0) {
    for (var k = 0; k < dataBoxes.length; k++) {
      var box = dataBoxes[k];
      if (!box || !Array.isArray(box.rows) || box.rows.length === 0) continue;
      parts.push('<div class="hdf-data-box" data-type="' + escapeHtmlText(box.type || 'stats') + '">');
      if (box.title) parts.push('<h4>' + escapeHtmlText(box.title) + '</h4>');
      parts.push('<table>');
      for (var r = 0; r < box.rows.length; r++) {
        var row = box.rows[r];
        if (!Array.isArray(row)) continue;
        var tag = (r === 0) ? 'th' : 'td';
        parts.push('<tr>');
        for (var c = 0; c < row.length; c++) {
          parts.push('<' + tag + '>' + escapeHtmlText(String(row[c] == null ? '' : row[c])) + '</' + tag + '>');
        }
        parts.push('</tr>');
      }
      parts.push('</table>');
      parts.push('</div>');
    }
  }

  // FAQs
  if (faqs && faqs.length > 0) {
    parts.push('<div class="hdf-faqs">');
    parts.push('<h2>Frequently Asked Questions</h2>');
    for (var j = 0; j < faqs.length; j++) {
      parts.push('<div class="hdf-faq-item">');
      parts.push('<h3>' + escapeHtmlText(faqs[j].question) + '</h3>');
      parts.push('<p>' + escapeHtmlText(faqs[j].answer) + '</p>');
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  return parts.join('\n');
}

function escapeHtmlText(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Build a unified result object from v2 parsed output. Used by all 3
// provider methods to keep the shape consistent.
function buildRewriteResult(parsed, tokensUsed) {
  var contentHtml = buildRewrittenHtml(parsed.inBrief, parsed.bodyMarkdown, parsed.faqs, parsed.dataBoxes || []);
  return {
    title: parsed.headline,
    content: contentHtml,
    bodyMarkdown: parsed.bodyMarkdown,
    inBrief: parsed.inBrief,
    excerpt: parsed.inBrief[0] || '',
    metaDescription: (parsed.inBrief[0] || '').slice(0, 155),
    slug: '',
    targetKeyword: '',
    relatedKeywords: [],
    faq: parsed.faqs,
    signals: parsed.signals || null,
    wordCount: parsed.wordCountBody || countWords(contentHtml),
    tokensUsed: tokensUsed,
  };
}

// ─── Rewriter Module ──────────────────────────────────────────────────────

class ArticleRewriter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.db = null;

    this.enabled = false;
    this.ready = false;
    this.status = 'disabled';
    this.error = null;

    this.stats = {
      totalRewrites: 0,
      anthropicCount: 0,
      openaiCount: 0,
      openrouterCount: 0,
      lastRewriteAt: null,
      totalTokens: 0,
    };

    // Per-provider concurrency lock — serializes calls to each provider
    // to avoid self-inflicted 429s on free-tier rate limits.
    this._providerLocks = {
      anthropic: Promise.resolve(),
      openai: Promise.resolve(),
      openrouter: Promise.resolve(),
    };
  }

  async init() {
    try {
      // Get db reference
      var dbMod = require('../utils/db');
      this.db = dbMod.db;

      // Ensure AI columns on drafts table
      this._ensureColumns();

      // Load config from DB + env
      this._loadConfig();

      // Check if at least one provider is configured
      var hasAnthropic = !!this._cfg.anthropicKey;
      var hasOpenAI = !!this._cfg.openaiKey;
      var hasOpenRouter = !!this._cfg.openrouterKey;
      if (!hasAnthropic && !hasOpenAI && !hasOpenRouter) {
        this.status = 'disabled';
        this.enabled = false;
        this.logger.warn('rewriter', 'No AI API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.');
        return;
      }

      this.enabled = true;
      this.ready = true;
      var keyCount = [hasAnthropic, hasOpenAI, hasOpenRouter].filter(Boolean).length;
      this.status = keyCount >= 2 ? 'connected' : 'degraded';

      var activeModel = this._cfg.provider === 'anthropic' ? this._cfg.anthropicModel
        : this._cfg.provider === 'openrouter' ? this._cfg.openrouterModel
        : this._cfg.openaiModel;
      this.logger.info('rewriter', 'Rewriter ready. Provider: ' + this._cfg.provider + ', Model: ' + activeModel);
      this.logger.info('rewriter', 'Anthropic key: ' + (hasAnthropic ? 'SET' : 'NOT SET') +
        ', OpenAI key: ' + (hasOpenAI ? 'SET' : 'NOT SET') +
        ', OpenRouter key: ' + (hasOpenRouter ? 'SET' : 'NOT SET'));
    } catch (err) {
      this.logger.error('rewriter', 'Init failed: ' + sanitizeAxiosError(err).message);
      this.status = 'error';
      this.error = err.message;
    }
  }

  _ensureColumns() {
    var columns = [
      { name: 'ai_provider', type: 'TEXT DEFAULT NULL' },
      { name: 'ai_model_used', type: 'TEXT DEFAULT NULL' },
      { name: 'ai_tokens_used', type: 'INTEGER DEFAULT 0' },
      { name: 'rewritten_at', type: 'TEXT DEFAULT NULL' },
      { name: 'custom_ai_instructions', type: 'TEXT DEFAULT NULL' },
    ];
    for (var i = 0; i < columns.length; i++) {
      try {
        this.db.prepare('ALTER TABLE drafts ADD COLUMN ' + columns[i].name + ' ' + columns[i].type).run();
      } catch (e) { /* already exists */ }
    }
  }

  _getSetting(key) {
    try {
      var row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch (e) {
      return null;
    }
  }

  _setSetting(key, value) {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
  }

  _loadConfig() {
    this._cfg = {
      provider:         this._getSetting('AI_PROVIDER')         || process.env.AI_PROVIDER         || 'openrouter',
      anthropicKey:     this._getSetting('ANTHROPIC_API_KEY')    || process.env.ANTHROPIC_API_KEY    || '',
      anthropicModel:   this._getSetting('ANTHROPIC_MODEL')      || process.env.ANTHROPIC_MODEL      || 'claude-haiku-4-5-20251001',
      openaiKey:        this._getSetting('OPENAI_API_KEY')       || process.env.OPENAI_API_KEY       || '',
      openaiModel:      this._getSetting('OPENAI_MODEL')         || process.env.OPENAI_MODEL         || 'gpt-4o-mini',
      openrouterKey:    this._getSetting('OPENROUTER_API_KEY')   || process.env.OPENROUTER_API_KEY   || '',
      openrouterModel:  this._getSetting('OPENROUTER_MODEL')     || process.env.OPENROUTER_MODEL     || 'meta-llama/llama-3.3-70b-instruct:free',
      enableFallback:   (this._getSetting('ENABLE_FALLBACK')     || process.env.ENABLE_FALLBACK     || 'true') === 'true',
      maxTokens:        parseInt(this._getSetting('MAX_TOKENS')  || process.env.MAX_TOKENS           || '4096', 10),
      temperature:      parseFloat(this._getSetting('TEMPERATURE') || process.env.TEMPERATURE        || '0.7'),
    };

    // Validate model IDs against known models — fix stale DB values
    this._cfg.anthropicModel = this._validateModelId('anthropic', this._cfg.anthropicModel, 'claude-haiku-4-5-20251001');
    this._cfg.openaiModel = this._validateModelId('openai', this._cfg.openaiModel, 'gpt-4o-mini');
    // OpenRouter models are fetched dynamically from their API,
    // so we cannot validate against AI_MODELS.openrouter (which is empty by design).
    // Trust whatever the user picked — OpenRouter API will return a clear error
    // if the model ID is invalid.
    if (!this._cfg.openrouterModel || typeof this._cfg.openrouterModel !== 'string') {
      this._cfg.openrouterModel = 'meta-llama/llama-3.3-70b-instruct:free';
    }
  }

  _validateModelId(provider, currentId, defaultId) {
    if (!currentId) return defaultId;

    var knownModels = AI_MODELS[provider] || [];
    var isValid = knownModels.some(function(m) { return m.id === currentId; });

    if (!isValid) {
      this.logger.warn('rewriter',
        'Invalid ' + provider + ' model ID "' + currentId + '" in settings. ' +
        'Resetting to default: "' + defaultId + '". ' +
        'Valid: ' + knownModels.map(function(m) { return m.id; }).join(', ')
      );
      var dbKeyMap = { anthropic: 'ANTHROPIC_MODEL', openai: 'OPENAI_MODEL', openrouter: 'OPENROUTER_MODEL' };
      try {
        this._setSetting(dbKeyMap[provider], defaultId);
      } catch (e) { /* silent */ }
      return defaultId;
    }

    return currentId;
  }

  // ─── Settings API (called by routes) ────────────────────────────────────

  updateSettings(settings) {
    var mapping = {
      provider: 'AI_PROVIDER',
      anthropicKey: 'ANTHROPIC_API_KEY',
      anthropicModel: 'ANTHROPIC_MODEL',
      openaiKey: 'OPENAI_API_KEY',
      openaiModel: 'OPENAI_MODEL',
      openrouterKey: 'OPENROUTER_API_KEY',
      openrouterModel: 'OPENROUTER_MODEL',
      enableFallback: 'ENABLE_FALLBACK',
      maxTokens: 'MAX_TOKENS',
      temperature: 'TEMPERATURE',
    };

    // Validate key formats before saving — rejects an OpenRouter key pasted
    // into the OpenAI field (and vice versa) with a clear error. Applies
    // only to keys actually being set in this call; empty strings are
    // treated as "no change" by the loop below.
    var keyProviderMap = {
      anthropicKey: 'anthropic',
      openaiKey: 'openai',
      openrouterKey: 'openrouter',
    };
    var kpKeys = Object.keys(keyProviderMap);
    for (var kpi = 0; kpi < kpKeys.length; kpi++) {
      var kpField = kpKeys[kpi];
      var kpVal = settings[kpField];
      if (kpVal !== undefined && kpVal !== null && String(kpVal).trim() !== '') {
        var kpCheck = validateKeyFormat(keyProviderMap[kpField], String(kpVal));
        if (!kpCheck.ok) {
          throw new Error('Invalid ' + keyProviderMap[kpField] + ' API key — ' + kpCheck.reason + '. Paste it into the correct provider field.');
        }
      }
    }

    var keys = Object.keys(mapping);
    for (var i = 0; i < keys.length; i++) {
      var jsKey = keys[i];
      var dbKey = mapping[jsKey];
      if (settings[jsKey] !== undefined && settings[jsKey] !== '') {
        this._setSetting(dbKey, String(settings[jsKey]));
      }
    }

    this._loadConfig();

    // Re-check enabled status
    var hasAnthropic = !!this._cfg.anthropicKey;
    var hasOpenAI = !!this._cfg.openaiKey;
    var hasOpenRouter = !!this._cfg.openrouterKey;
    this.enabled = hasAnthropic || hasOpenAI || hasOpenRouter;
    this.ready = this.enabled;
    var keyCount = [hasAnthropic, hasOpenAI, hasOpenRouter].filter(Boolean).length;
    this.status = this.enabled ? (keyCount >= 2 ? 'connected' : 'degraded') : 'disabled';

    this.logger.info('rewriter', 'Settings updated. Provider: ' + this._cfg.provider);
  }

  getSettings() {
    this._loadConfig();
    return {
      provider: this._cfg.provider,
      anthropicKey: this._cfg.anthropicKey ? '***' + this._cfg.anthropicKey.slice(-4) : '',
      anthropicModel: this._cfg.anthropicModel,
      openaiKey: this._cfg.openaiKey ? '***' + this._cfg.openaiKey.slice(-4) : '',
      openaiModel: this._cfg.openaiModel,
      openrouterKey: this._cfg.openrouterKey ? '***' + this._cfg.openrouterKey.slice(-4) : '',
      openrouterModel: this._cfg.openrouterModel,
      enableFallback: this._cfg.enableFallback,
      maxTokens: this._cfg.maxTokens,
      temperature: this._cfg.temperature,
    };
  }

  // ─── Main rewrite method (used by scheduler + draft-helpers) ────────────
  //
  // Signature: rewrite(article, cluster, options)
  //   article  — { title, content_markdown, url, domain, extracted_content, ... }
  //   cluster  — { articles[], trends_boosted, topic, ... } (can be minimal for drafts)
  //   options  — { provider, model } per-call overrides
  //
  // Returns: { title, content, excerpt, metaDescription, slug, targetKeyword,
  //            relatedKeywords, faq, wordCount, aiModel, aiProvider, tokensUsed }

  _getProviderKeyModel(provider, opts) {
    if (provider === 'anthropic') return { key: this._cfg.anthropicKey, model: opts.model || this._cfg.anthropicModel };
    if (provider === 'openrouter') return { key: this._cfg.openrouterKey, model: opts.model || this._cfg.openrouterModel };
    return { key: this._cfg.openaiKey, model: opts.model || this._cfg.openaiModel };
  }

  async rewrite(article, cluster, options) {
    this._loadConfig();
    var opts = options || {};

    var provider = opts.provider || this._cfg.provider;
    var enableFallback = this._cfg.enableFallback;

    var pkm = this._getProviderKeyModel(provider, opts);
    var primaryKey = pkm.key;
    var primaryModel = pkm.model;

    if (!primaryKey) {
      var errMsg = provider.toUpperCase() + ' API key is not configured. Go to Settings and enter your API key.';
      this.logger.error('rewriter', errMsg);
      throw new Error(errMsg);
    }

    // Format-check the primary key before we even try the call — saves
    // a round-trip to the provider and surfaces a clearer error than 401.
    var primaryCheck = validateKeyFormat(provider, primaryKey);
    if (!primaryCheck.ok) {
      var badKeyMsg = provider.toUpperCase() + ' API key format is wrong — ' + primaryCheck.reason + '. Fix it in Settings.';
      this.logger.error('rewriter', badKeyMsg);
      throw new Error(badKeyMsg);
    }

    // Resolve publication identity (used by master prompt)
    var publicationName = opts.publicationName
      || this._getSetting('PUBLICATION_NAME')
      || process.env.PUBLICATION_NAME
      || 'HDF News';
    var publicationUrl  = opts.publicationUrl
      || this._getSetting('PUBLICATION_URL')
      || this._getSetting('WP_URL')
      || process.env.WP_URL
      || 'https://hdfnews.com';

    // Build the SEO prompt from article + cluster + user settings
    var promptSettings = {
      targetKeyword: opts.targetKeyword || '',
      targetDomain: opts.targetDomain || '',
      language: opts.language || 'en+hi',
      schemaTypes: opts.schemaTypes || 'NewsArticle,FAQPage,BreadcrumbList',
      customPrompt: opts.customPrompt || '',
      publicationName: publicationName,
      publicationUrl: publicationUrl,
      infraData: opts.infraData || null,
    };
    var prompt = buildPrompt(article, cluster || { articles: [article] }, promptSettings);
    var self = this;

    var jobSignal = opts.signal || null;

    // Wraps a provider call with structure validation. If signals say a
    // structure is required but the body markdown is missing it, retries
    // the same provider once with a stronger nudge appended to the prompt.
    async function callWithValidation(provName, key, model) {
      var r = await self._callProviderStructured(provName, key, model, prompt, jobSignal);
      if (r && r.signals) {
        self.logger.info('rewriter', 'Signals: ' + JSON.stringify(r.signals));
      }
      var v = validateStructure(r.bodyMarkdown, r.signals);
      if (v.valid) return r;
      self.logger.warn('rewriter', 'Structure validation failed: ' + v.errors.join('; ') + ' — retrying once');
      var nudge = prompt +
        '\n\n# RETRY — STRUCTURE MISMATCH\n' +
        'Your previous response set these signals to YES but the body markdown did not include the required structure(s):\n' +
        v.errors.map(function (e) { return '- ' + e; }).join('\n') +
        '\nFix this. Either change the relevant signal to "no" if the story does not actually warrant it, OR include the required structure (markdown table / numbered list / date-prefixed list) inside body_markdown. Respond with valid JSON in the same schema, with a fresh <signals> block.';
      var retry = await self._callProviderStructured(provName, key, model, nudge, jobSignal);
      if (retry && retry.signals) {
        self.logger.info('rewriter', 'Signals (retry): ' + JSON.stringify(retry.signals));
      }
      return retry;
    }

    // Try primary
    try {
      this.logger.info('rewriter', 'Calling ' + provider + ' with model ' + primaryModel + '...');
      var result = await callWithValidation(provider, primaryKey, primaryModel);
      result.aiProvider = provider;
      result.aiModel = primaryModel;

      this.stats.totalRewrites++;
      if (provider === 'anthropic') this.stats.anthropicCount++;
      else if (provider === 'openai') this.stats.openaiCount++;
      else if (provider === 'openrouter') this.stats.openrouterCount++;
      this.stats.lastRewriteAt = new Date().toISOString();
      this.stats.totalTokens += result.tokensUsed || 0;

      this.logger.info('rewriter', 'SUCCESS: ' + provider + ' / ' + primaryModel + ' — ' + result.tokensUsed + ' tokens');
      return result;
    } catch (primaryErr) {
      this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + sanitizeAxiosError(primaryErr).message);

      if (!enableFallback) throw primaryErr;

      // Fallback chain: only cascade to MORE reliable providers than
      // the one that just failed. Reliability order: anthropic > openai > openrouter.
      var fallbackChain = {
        openrouter: ['anthropic', 'openai'], // openrouter failed → try paid providers
        openai: ['anthropic'],                // openai failed → only anthropic is more reliable
        anthropic: ['openai'],                // anthropic failed → openai is next-most-reliable
      };
      var fallbackProviders = fallbackChain[provider] || [];
      var lastError = primaryErr;

      for (var fi = 0; fi < fallbackProviders.length; fi++) {
        var fbProvider = fallbackProviders[fi];
        var fb = self._getProviderKeyModel(fbProvider, {});
        if (!fb.key) continue;

        // Skip this fallback if the saved key is clearly for another
        // provider (e.g. an sk-or-v1- key pasted into the OpenAI field).
        // Prevents a confusing upstream 401 with the wrong key in it.
        var fbCheck = validateKeyFormat(fbProvider, fb.key);
        if (!fbCheck.ok) {
          self.logger.warn('rewriter', 'Skipping ' + fbProvider + ' fallback: ' + fbCheck.reason + ' — fix the key in Settings.');
          continue;
        }

        self.logger.info('rewriter', 'Trying fallback: ' + fbProvider + ' / ' + fb.model + '...');
        try {
          var fbResult = await callWithValidation(fbProvider, fb.key, fb.model);
          fbResult.aiProvider = fbProvider;
          fbResult.aiModel = fb.model;
          fbResult.usedFallback = true;

          self.stats.totalRewrites++;
          if (fbProvider === 'anthropic') self.stats.anthropicCount++;
          else if (fbProvider === 'openai') self.stats.openaiCount++;
          else if (fbProvider === 'openrouter') self.stats.openrouterCount++;
          self.stats.lastRewriteAt = new Date().toISOString();
          self.stats.totalTokens += fbResult.tokensUsed || 0;

          self.logger.info('rewriter', 'FALLBACK SUCCESS: ' + fbProvider + ' / ' + fb.model);
          return fbResult;
        } catch (fbErr) {
          self.logger.error('rewriter', 'FALLBACK FAILED (' + fbProvider + '): ' + sanitizeAxiosError(fbErr).message);
          lastError = fbErr;
        }
      }

      throw new Error('All providers failed. Last error: ' + lastError.message);
    }
  }

  // ─── patchContent — targeted AI edit (AI Edit tab) ──────────────────────
  //
  // Apply a targeted instruction (e.g. "add more detail about the price") to
  // an existing HTML content string. Returns the edited HTML directly, NOT a
  // full rewrite result object.
  //
  // opts: { provider, model, infraData }
  //
  async patchContent(html, instruction, opts) {
    this._loadConfig();
    opts = opts || {};

    var provider = opts.provider || this._cfg.provider;
    var pkm = this._getProviderKeyModel(provider, opts);
    var apiKey = pkm.key;
    var model = pkm.model;

    if (!apiKey) {
      throw new Error(provider.toUpperCase() + ' API key is not configured. Go to Settings.');
    }

    // Build rich context block from InfraNodus data
    var infraCtx = '';
    var infra = opts.infraData || {};

    if (infra.targetKeyword) {
      infraCtx += 'PRIMARY TARGET KEYWORD: ' + infra.targetKeyword + '\n';
    }
    if (infra.mainTopics && infra.mainTopics.length) {
      // Filter out InfraNodus bigram format strings for readability
      var cleanTopics = infra.mainTopics.filter(function (t) { return t.indexOf('<->') === -1; });
      if (cleanTopics.length) infraCtx += 'Key entities/topics in this story: ' + cleanTopics.slice(0, 12).join(', ') + '\n';
    }
    if (infra.missingEntities && infra.missingEntities.length) {
      var cleanMissing = infra.missingEntities.filter(function (t) { return t.indexOf('<->') === -1; });
      if (cleanMissing.length) infraCtx += 'Important entities NOT yet in article: ' + cleanMissing.slice(0, 10).join(', ') + '\n';
    }
    if (infra.contentGaps && infra.contentGaps.length) {
      infraCtx += 'Content gaps to address: ' + infra.contentGaps.slice(0, 4).join('; ') + '\n';
    }
    if (infra.rankingAdvice) {
      infraCtx += 'What currently ranks (competitive landscape): ' + infra.rankingAdvice.slice(0, 200) + '\n';
    }
    if (infra.intentAdvice) {
      infraCtx += 'Reader search intent: ' + infra.intentAdvice.slice(0, 200) + '\n';
    }
    if (infra.gapAdvice) {
      infraCtx += 'SEO content gap opportunity: ' + infra.gapAdvice.slice(0, 200) + '\n';
    }
    if (infra.researchQuestions && infra.researchQuestions.length) {
      infraCtx += 'Questions readers want answered: ' + infra.researchQuestions.slice(0, 4).join('; ') + '\n';
    }
    if (infra.relatedQueries && infra.relatedQueries.length) {
      infraCtx += 'Related searches to naturally address: ' + infra.relatedQueries.slice(0, 6).join(', ') + '\n';
    }

    var systemPrompt = 'You are an expert news editor and SEO specialist.\n' +
      'You will receive an HTML article and a specific editing instruction.\n' +
      'Rules:\n' +
      '- Apply ONLY the requested change. Do not restructure unaffected sections.\n' +
      '- Preserve all existing HTML structure, headings, links, and schema markup.\n' +
      '- Write in the same tone and style as the existing article.\n' +
      '- Use the InfraNodus SEO context below to make smarter editorial decisions.\n' +
      '- Return ONLY the complete edited HTML — no commentary, no markdown fences, no JSON.' +
      (infraCtx ? '\n\n=== InfraNodus SEO Intelligence ===\n' + infraCtx + '===' : '');

    var userPrompt = 'EDITING INSTRUCTION: ' + instruction + '\n\n' +
      'ARTICLE HTML:\n' + html.slice(0, 32000);

    return this._callProviderRaw(provider, apiKey, model, systemPrompt, userPrompt, opts.signal || null);
  }

  // ─── Raw provider call (returns plain text, for patchContent) ───────────

  async _callProviderRaw(provider, apiKey, model, systemPrompt, userPrompt, signal) {
    if (provider === 'anthropic') {
      var Anthropic = require('@anthropic-ai/sdk');
      var client = new Anthropic({ apiKey: apiKey.trim() });
      var reqOpts = signal ? { signal: signal } : {};
      var resp = await client.messages.create({
        model: model,
        max_tokens: 8192,
        temperature: 0.4,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }, reqOpts);
      return (resp.content && resp.content[0] ? resp.content[0].text : '').trim();
    }

    if (provider === 'openrouter' || provider === 'openai') {
      var OpenAI = require('openai');
      var clientOpts = { apiKey: apiKey.trim() };
      if (provider === 'openrouter') {
        clientOpts.baseURL = 'https://openrouter.ai/api/v1';
        clientOpts.defaultHeaders = { 'HTTP-Referer': 'https://hdf-autopub.com', 'X-Title': 'HDF AutoPub' };
      }
      var oai = new OpenAI(clientOpts);
      var reqOpts2 = signal ? { signal: signal } : {};
      var resp2 = await oai.chat.completions.create({
        model: model,
        max_tokens: 8192,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }, reqOpts2);
      return (resp2.choices && resp2.choices[0] ? resp2.choices[0].message.content : '').trim();
    }

    throw new Error('Unknown provider: ' + provider);
  }

  // ─── Provider calls (structured JSON output for pipeline) ───────────────

  async _callProviderStructured(provider, apiKey, model, prompt, signal) {
    if (provider === 'anthropic') return this._callAnthropicStructured(apiKey, model, prompt, signal);
    if (provider === 'openrouter') return this._callOpenRouterStructured(apiKey, model, prompt, signal);
    return this._callOpenAIStructured(apiKey, model, prompt, signal);
  }

  _acquireProviderLock(provider) {
    var self = this;
    var prev = self._providerLocks[provider] || Promise.resolve();
    var release;
    var next = new Promise(function (resolve) { release = resolve; });
    self._providerLocks[provider] = prev.then(function () { return next; });
    return prev.then(function () { return release; });
  }

  async _callAnthropicStructured(apiKey, model, prompt, signal) {
    var release = await this._acquireProviderLock('anthropic');
    try {
      var Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk'); }
      catch (e) { throw new Error('Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk'); }

      var maxTokens = this._cfg.maxTokens || 4096;
      var temperature = this._cfg.temperature;
      if (temperature === undefined || temperature === null) temperature = 0.7;

      var client = new Anthropic({ apiKey: apiKey.trim() });

      var requestOpts = signal ? { signal: signal } : {};
      var response = await client.messages.create({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        messages: [{ role: 'user', content: prompt }],
      }, requestOpts);

      var rawText = response.content && response.content[0] ? response.content[0].text : '';
      if (!rawText || rawText.length < 50) {
        throw new Error('Anthropic returned empty or too-short response');
      }

      var parsed = parseModelOutput(rawText);
      var tokensUsed = (response.usage ? (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0) : 0);
      return buildRewriteResult(parsed, tokensUsed);
    } finally {
      release();
    }
  }

  async _callOpenAIStructured(apiKey, model, prompt, signal) {
    var release = await this._acquireProviderLock('openai');
    try {
      var OpenAI;
      try { OpenAI = require('openai'); }
      catch (e) { throw new Error('OpenAI SDK not installed. Run: npm install openai'); }

      var maxTokens = this._cfg.maxTokens || 4096;
      var temperature = this._cfg.temperature;
      if (temperature === undefined || temperature === null) temperature = 0.7;

      var isOModel = model.startsWith('o3') || model.startsWith('o4');
      var client = new OpenAI({ apiKey: apiKey.trim() });
      var requestOpts = signal ? { signal: signal } : {};

      var response;
      if (isOModel) {
        response = await client.chat.completions.create({
          model: model,
          max_completion_tokens: maxTokens,
          messages: [
            { role: 'developer', content: 'You are a professional news journalist. Always respond in valid JSON.' },
            { role: 'user', content: prompt },
          ],
        }, requestOpts);
      } else {
        response = await client.chat.completions.create({
          model: model,
          max_tokens: maxTokens,
          temperature: temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a professional news journalist. Always respond in valid JSON.' },
            { role: 'user', content: prompt },
          ],
        }, requestOpts);
      }

      var rawText = response.choices && response.choices[0] ? response.choices[0].message.content : '';
      if (!rawText || rawText.length < 50) {
        throw new Error('OpenAI returned empty or too-short response');
      }

      var parsed = parseModelOutput(rawText);
      var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);
      return buildRewriteResult(parsed, tokensUsed);
    } finally {
      release();
    }
  }

  // ─── OpenRouter calls (uses OpenAI SDK with custom baseURL) ──────────

  _openRouterClient(apiKey) {
    var OpenAI = require('openai');
    return new OpenAI({
      apiKey: apiKey.trim(),
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://hdf-autopub.com',
        'X-Title': 'HDF AutoPub',
      },
    });
  }

  async _callOpenRouterStructured(apiKey, model, prompt, signal) {
    var release = await this._acquireProviderLock('openrouter');
    try {
      // OpenRouter reasoning models (DeepSeek-R1, Nemotron, Minimax M2, Qwen QwQ)
      // spend 1,500–4,000 tokens on internal <think> before producing JSON.
      // Ensure at least 8192 tokens so both phases fit.
      var configuredMaxTokens = this._cfg.maxTokens || 4096;
      var maxTokens = Math.max(configuredMaxTokens, 8192);
      var temperature = this._cfg.temperature;
      if (temperature === undefined || temperature === null) temperature = 0.7;

      var client = this._openRouterClient(apiKey);
      var requestOpts = signal ? { signal: signal } : {};

      // Build request with JSON mode (matches _callOpenAIStructured behaviour)
      var requestBody = {
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a professional news journalist. Always respond in valid JSON only — no prose, no markdown fences, no <think> blocks.' },
          { role: 'user', content: prompt },
        ],
      };

      // Retry wrapper for 429 / 5xx with exponential backoff (2s, 4s, 8s)
      // Note: abort signal errors are NOT retried — they propagate immediately.
      var response = null;
      var lastErr = null;
      var maxAttempts = 3;
      for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          response = await client.chat.completions.create(requestBody, requestOpts);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          // Abort errors must not be retried
          if (err && err.name === 'AbortError') throw err;
          var status = (err && (err.status || err.statusCode)) || 0;
          var isRateLimited = status === 429;
          var isServerError = status >= 500 && status < 600;
          var isRetryable = isRateLimited || isServerError;
          if (!isRetryable || attempt === maxAttempts) {
            throw err;
          }
          var waitMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.log('[rewriter] OpenRouter ' + status + ' on attempt ' + attempt + '/' + maxAttempts + ' for ' + model + ' — retrying in ' + (waitMs / 1000) + 's');
          await new Promise(function (resolve) { return setTimeout(resolve, waitMs); });
        }
      }
      if (!response) {
        throw lastErr || new Error('OpenRouter call failed after ' + maxAttempts + ' attempts');
      }

      // Extract text — reasoning models put output in reasoning_content / reasoning
      var msg = (response.choices && response.choices[0] && response.choices[0].message) || {};
      var rawText = msg.content || msg.reasoning_content || msg.reasoning || '';

      // Strip any <think>...</think> blocks left by reasoning models
      if (rawText && rawText.indexOf('<think>') !== -1) {
        rawText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      }

      if (!rawText || rawText.length < 50) {
        throw new Error('OpenRouter returned empty or too-short response (model=' + model + ', content_len=' + (msg.content || '').length + ', reasoning_len=' + ((msg.reasoning_content || msg.reasoning || '')).length + ')');
      }

      var parsed = parseModelOutput(rawText);
      var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);
      return buildRewriteResult(parsed, tokensUsed);
    } finally {
      release();
    }
  }

  // ─── Test connection ────────────────────────────────────────────────────

  async testConnection(provider, apiKey, modelOverride) {
    try {
      if (provider === 'anthropic') {
        var Anthropic = require('@anthropic-ai/sdk');
        var aClient = new Anthropic({ apiKey: apiKey.trim() });
        var aModel = modelOverride || 'claude-haiku-4-5-20251001';
        var aRes = await aClient.messages.create({
          model: aModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: aModel,
          response: aRes.content && aRes.content[0] ? aRes.content[0].text : '',
        };

      } else if (provider === 'openrouter') {
        var orClient = this._openRouterClient(apiKey);
        // Use user's selected model if provided, else fall back to a known-stable free model
        var orModel = modelOverride || this._cfg.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free';
        var orRes = await orClient.chat.completions.create({
          model: orModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: orModel,
          response: orRes.choices && orRes.choices[0] ? orRes.choices[0].message.content : '',
        };

      } else {
        var OpenAI = require('openai');
        var oaiClient = new OpenAI({ apiKey: apiKey.trim() });
        var oaiModel = modelOverride || 'gpt-4o-mini';
        var oaiRes = await oaiClient.chat.completions.create({
          model: oaiModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: oaiModel,
          response: oaiRes.choices && oaiRes.choices[0] ? oaiRes.choices[0].message.content : '',
        };
      }
    } catch (err) {
      // OpenRouter returns useful error structure — surface model name in message
      var msg = err && err.message ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  async validateRewriteCapability(provider, apiKey, modelOverride) {
    try {
      // Minimal rewrite-shaped prompt that proves JSON mode works
      var testPrompt =
        'Respond with a JSON object exactly matching this schema:\n' +
        '{\n' +
        '  "headline": "string, 10-20 chars",\n' +
        '  "in_brief": "string, 20-40 chars",\n' +
        '  "body_markdown": "string, 50-100 chars",\n' +
        '  "faqs": [{"q": "string", "a": "string"}]\n' +
        '}\n\n' +
        'Topic: "Test rewrite capability". Keep all strings short.';

      var tempCfg = {
        maxTokens: 1024,
        temperature: 0.3,
      };
      // Temporarily override cfg for this call
      var savedCfg = this._cfg;
      this._cfg = Object.assign({}, savedCfg || {}, tempCfg);

      var result;
      try {
        if (provider === 'anthropic') {
          result = await this._callAnthropicStructured(apiKey, modelOverride || 'claude-haiku-4-5-20251001', testPrompt);
        } else if (provider === 'openai') {
          result = await this._callOpenAIStructured(apiKey, modelOverride || 'gpt-4o-mini', testPrompt);
        } else if (provider === 'openrouter') {
          result = await this._callOpenRouterStructured(apiKey, modelOverride || 'meta-llama/llama-3.3-70b-instruct:free', testPrompt);
        } else {
          throw new Error('Unknown provider: ' + provider);
        }
      } finally {
        this._cfg = savedCfg;
      }

      return {
        success: true,
        model: modelOverride || '',
        response: 'Rewrite-shaped JSON returned successfully (' + (result.tokensUsed || 0) + ' tokens)',
      };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  // ─── Health / Status ────────────────────────────────────────────────────

  getHealth() {
    return {
      module: 'rewriter',
      enabled: this.enabled,
      ready: this.ready,
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastRewriteAt,
      stats: {
        provider: this._cfg ? this._cfg.provider : 'unknown',
        totalRewrites: this.stats.totalRewrites,
      },
    };
  }

  getStatus() {
    return {
      totalRewrites: this.stats.totalRewrites,
      anthropicCount: this.stats.anthropicCount || 0,
      openaiCount: this.stats.openaiCount || 0,
      openrouterCount: this.stats.openrouterCount || 0,
      lastRewriteAt: this.stats.lastRewriteAt,
      totalTokens: this.stats.totalTokens,
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }
}

// ─── Dynamic OpenRouter Free Model Fetcher ─────────────────────────────
// Fetches the real, currently-available list of free models from OpenRouter's
// public /models endpoint. Cached for 1 hour to avoid hammering their API.

// Detect reasoning models by ID keywords. Reasoning models consume
// extra output tokens for their internal <think> phase and need
// larger max_tokens budgets + special response handling.
function isReasoningModel(id) {
  if (!id) return false;
  var lower = id.toLowerCase();
  var reasoningPatterns = [
    'deepseek-r1',
    'deepseek/r1',
    '/r1:',
    '/r1-',
    'qwq',
    'nemotron',
    'minimax-m2',
    'nousresearch/deephermes',
    'openai/o1',
    'openai/o3',
    'openai/o4',
  ];
  for (var i = 0; i < reasoningPatterns.length; i++) {
    if (lower.indexOf(reasoningPatterns[i]) !== -1) return true;
  }
  return false;
}

// Blocklist: specific OpenRouter model IDs that should NEVER appear
// in the dropdown, regardless of their free-tier status. Add one ID
// per line. Matched case-insensitively with an exact equals check.
// To apply a change: restart the Node process OR hit the Refresh
// OpenRouter Models button in Settings (POST /api/ai/openrouter-models/refresh).
var OPENROUTER_BLOCKLIST = [
  'z-ai/glm-4.5-air:free',
];

var _openrouterModelCache = { models: null, fetchedAt: 0 };
var OPENROUTER_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function fetchOpenRouterFreeModels(forceRefresh) {
  var now = Date.now();
  if (!forceRefresh && _openrouterModelCache.models && (now - _openrouterModelCache.fetchedAt) < OPENROUTER_CACHE_MS) {
    return _openrouterModelCache.models;
  }

  try {
    // Use built-in fetch (Node 18+). Fallback to axios if not available.
    var response;
    if (typeof fetch === 'function') {
      var res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error('OpenRouter /models returned HTTP ' + res.status);
      response = await res.json();
    } else {
      var axios = require('axios');
      var axRes = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 15000 });
      response = axRes.data;
    }

    var data = (response && response.data) ? response.data : [];

    // Filter to free models only.
    // OpenRouter marks free models with `:free` suffix in id AND/OR pricing.prompt === "0"
    var freeModels = data.filter(function (m) {
      if (!m || !m.id) return false;
      var idIsFree = m.id.indexOf(':free') !== -1;
      var priceIsZero = m.pricing && (m.pricing.prompt === '0' || m.pricing.prompt === 0);
      if (!(idIsFree || priceIsZero)) return false;
      // Apply blocklist — case-insensitive exact match
      var lowerId = m.id.toLowerCase();
      for (var bi = 0; bi < OPENROUTER_BLOCKLIST.length; bi++) {
        if (OPENROUTER_BLOCKLIST[bi].toLowerCase() === lowerId) return false;
      }
      return true;
    });

    // Map to our shape, sort by context length descending (bigger = better default sort)
    var mapped = freeModels.map(function (m) {
      var ctx = m.context_length || 0;
      var ctxLabel = ctx >= 1000000 ? Math.round(ctx / 1000000) + 'M ctx'
                  : ctx >= 1000 ? Math.round(ctx / 1000) + 'k ctx'
                  : '';
      var name = m.name || m.id;
      // Strip provider prefix from name for cleaner display
      var displayName = name.replace(/^[^:]+:\s*/, '');
      var modelType = isReasoningModel(m.id) ? 'reasoning' : 'standard';
      var displayLabel = displayName + (ctxLabel ? ' (' + ctxLabel + ')' : '');
      if (modelType === 'reasoning') displayLabel += ' — reasoning';
      return {
        id: m.id,
        name: displayLabel,
        tier: 'Free',
        type: modelType,
        contextLength: ctx,
      };
    });

    // Sort: largest context first
    mapped.sort(function (a, b) { return (b.contextLength || 0) - (a.contextLength || 0); });

    // Cache and return
    _openrouterModelCache.models = mapped;
    _openrouterModelCache.fetchedAt = now;
    return mapped;
  } catch (err) {
    // On failure, return cached list (even if stale) or a SAFE fallback of well-known free models
    if (_openrouterModelCache.models && _openrouterModelCache.models.length > 0) {
      return _openrouterModelCache.models;
    }
    // Last-resort fallback — these are widely-known stable free model IDs.
    // If they're also gone, the user will see "no models available" and can refresh.
    return [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', tier: 'Free', type: 'standard', contextLength: 131072 },
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Experimental', tier: 'Free', type: 'standard', contextLength: 1048576 },
      { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek V3', tier: 'Free', type: 'standard', contextLength: 65536 },
      { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1', tier: 'Free', type: 'reasoning', contextLength: 65536 },
      { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen 2.5 72B Instruct', tier: 'Free', type: 'standard', contextLength: 32768 },
    ];
  }
}

module.exports = { ArticleRewriter, AI_MODELS, fetchOpenRouterFreeModels };
