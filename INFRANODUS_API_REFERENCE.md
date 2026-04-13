# InfraNodus API Reference — HDF AutoPub Integration

> **Status:** Authoritative. Reviewed 2026-04-13 against official docs at infranodus.com.
> **Audience:** Future maintainers and AI agents working on `src/modules/infranodus.js`.
> **Canonical source:** Official InfraNodus API documentation (user-provided screenshots).
>
> If you are an AI agent reading this in a future session: this document is the
> single source of truth for InfraNodus integration in this repo. Read it BEFORE
> touching `src/modules/infranodus.js`, `src/workers/pipeline.js` (InfraNodus calls),
> or `src/modules/rewriter.js` `buildPrompt()` (entity-context section).

---

## TL;DR — What's currently broken

`src/modules/infranodus.js` has **8 bugs** that need fixing. The integration silently
"works" (no exceptions thrown) but produces degraded results. Rewriter calls succeed
but the entity context is missing data the API would otherwise return.

| # | Bug | Severity |
|---|---|---|
| 1 | Query parameters sent in request body for #1, #2, #3 | CRITICAL |
| 2 | Advice field read from `.advice` but actual shape is `aiAdvice[0].text` | CRITICAL |
| 3 | `dotGraphFromText` sent `doNotSave: true` — not a valid param for it | MEDIUM |
| 4 | `graphAndAdvice` missing `requestMode` (advice quality unspecified) | MEDIUM |
| 5 | `dotGraphFromText` missing `aiTopics: true` (thinner response) | LOW |
| 6 | `enhanceArticle()` makes 2 API calls when 1 would do | OPTIMIZATION |
| 7 | `'gaps'` plural is canonical (resolved — already using it) | RESOLVED |
| 8 | `clusterKeywords`, `allClusters`, `bigrams` from #3 are thrown away | LOW |

---

## Current code state

`src/modules/infranodus.js` calls 3 endpoints:
- `/api/v1/graphAndStatements` via `analyzeText()`
- `/api/v1/graphAndAdvice` via `analyzeWithAdvice()` and (in collapsed form) `enhanceArticle()`
- `/api/v1/dotGraphFromText` via `getCompactGraph()`

**Callers in pipeline:**
- `src/workers/pipeline.js` `_extractionLoop()` (~line 135) — B5 auto-analysis after extraction
- `src/workers/pipeline.js` `_rewriteCluster()` (~line 362) — pre-rewrite call on combined cluster text
- `src/routes/api.js` `POST /drafts/:id/analyze` (~line 2909) — manual per-draft analysis trigger

**Consumed by:** `src/modules/rewriter.js` `buildPrompt()` (~line 197) — injects fields into
the `--- ENTITY ANALYSIS (from InfraNodus) ---` block:
- `mainTopics`, `missingEntities`, `contentGaps`, `researchQuestions` (from #1 / #2 response)
- `advice` (from #2 — currently always `null` because of bug #2)
- `graphSummary` (from #3 — currently working since `result.graphSummary` is read)

---

## The 8 bugs (detailed)

### Bug 1: Query parameters in request body  [CRITICAL]
**Affects:** #1 graphAndStatements, #2 graphAndAdvice, #3 dotGraphFromText

InfraNodus separates query params (URL `?foo=bar`) from body params (JSON body).
Our `_callAPI()` sends EVERYTHING in the body. Query-only params like `doNotSave`,
`addStats`, `optimize`, `compactGraph`, `includeGraphSummary`, `extendedGraphSummary`,
`gapDepth` belong in the URL.

InfraNodus's behavior with body-vs-query is undocumented — most likely the body params
are silently ignored, meaning we've been getting **default behavior** (the wrong defaults
for `includeGraphSummary` which is `false`, no `extendedGraphSummary`, no `gapDepth`,
etc.).

**Fix:** Add a `queryParams` arg to `_callAPI()`. Pass via axios `options.params`
which auto-encodes for the URL.

### Bug 2: Wrong field for advice text  [CRITICAL]
The actual response shape from `graphAndAdvice`, `graphAiAdvice`,
`googleSearchResultsAiAdvice`, `googleSearchIntentAiAdvice`, etc.:
```json
{
  "aiAdvice": [
    { "text": "AI-generated response text...", "finish_reason": "stop" }
  ]
}
```

Our parser reads `result.advice` (singular, no array). Always returns `undefined`.
**Result:** The "Content Strategy" line in `buildPrompt()` has been NULL for every
single rewrite since Phase 2 was deployed.

**Fix:** Read `result.aiAdvice[0].text`.

### Bug 3: `doNotSave` is not a parameter for `dotGraphFromText`
Endpoint #3 documented query params: `optimize`, `includeGraph`, `includeGraphSummary`,
`extendedGraphSummary`. **`doNotSave` is absent.** `dotGraphFromText` is a pure
transformation — there's nothing to save.

**Fix:** Drop `doNotSave` from `getCompactGraph()` body.

### Bug 4: Missing `requestMode` for `graphAndAdvice`
Endpoint #2 needs `requestMode` to control what kind of advice the LLM generates.
Without it, behavior is unspecified. Valid values: `question`, `idea`, `fact`, `continue`,
`challenge`, `response`, `gptchat`, `summary`, `graph summary`, `reprompt`.

For news-rewrite content strategy, **`summary`** is the best default — graph-augmented
summary of what the text covers, which feeds directly into the rewriter prompt.

**Fix:** Default to `requestMode: 'summary'` in `analyzeWithAdvice()`.

### Bug 5: Missing `aiTopics: true` for `dotGraphFromText`
Endpoint #3 accepts `aiTopics` as a body param. When `true`, response includes
AI-extracted cluster labels in `clusterKeywords`/`allClusters`. We leave it unset.

**Fix:** Set `aiTopics: true` in `getCompactGraph()` body.

### Bug 6: Two API calls when one would do
With the right query flags (`addStats=true`, `includeGraphSummary=true`,
`aiTopics=true` body), `graphAndAdvice` returns the FULL graph + stats + aiTopics +
aiAdvice + graphSummary in a single response. The separate `dotGraphFromText` call is
redundant.

**Fix:** Collapse `enhanceArticle()` to one `graphAndAdvice` call. Keep `getCompactGraph()`
as a public helper but don't call it from `enhanceArticle()`.

### Bug 7: `optimize: 'gaps'` vs `'gap'` ambiguity  [RESOLVED]
Endpoint #2 docs show `'gap'` (singular). Endpoints #3, #4, and Appendix 2 all show
`'gaps'` (plural). We use `'gaps'` — confirmed correct from multiple authoritative
sources. Endpoint #2's `'gap'` is a documentation typo.

### Bug 8: Useful response fields from #3 are thrown away
- `clusterKeywords` — natural-language description of topic clusters
- `allClusters` — array of `{ text }` cluster objects
- `bigrams` — top co-occurrence pairs
- `graphKeywords` — DOT-format graph string

**Fix (future):** Surface these as additional fields in `enhanceArticle()` result if
the rewriter ever consumes them.

---

## Full endpoint reference

### Authentication

```
Authorization: Bearer ${INFRANODUS_API_KEY}
Content-Type: application/json
```

Base URL: `https://infranodus.com`

---

### Endpoints we currently use

#### #1 `POST /api/v1/graphAndStatements`
Send text → get graph + statements + stats + AI topics. The workhorse.

**Query params (URL):**

| Param | Type | Default |
|---|---|---|
| `doNotSave` | boolean | `true` |
| `addStats` | boolean | `true` |
| `includeStatements` | boolean | `true` |
| `includeGraphSummary` | boolean | `false` |
| `extendedGraphSummary` | boolean | `true` |
| `includeGraph` | boolean | `true` |
| `gapDepth` | number (0–3) | `0` |
| `compactStatements` | boolean | `false` |
| `compactGraph` | boolean | `false` |

**Body params:**
- `name` (string), `text` (string), `statements` (array), `timestamps` (array)
- `aiTopics` (boolean) — enables AI topic extraction in response
- `modifyAnalyzedText` (string), `replaceEntities` (boolean)
- `contextType` (string, e.g. `"STANDARD"`), `userName` (string)
- `contextSettings` (object): `partOfSpeechToProcess`,
  `doubleSquarebracketsProcessing`, `squareBracketsProcessing`, `mentionsProcessing`

**Response (Graphology graph at root with extras):**
- `aiTopics.mainTopics`, `aiTopics.contentGaps`, `aiTopics.researchQuestions` (when `aiTopics: true`)
- `stats.gaps[].bridgeConcepts`, `stats.topClusters` (when `addStats: true`)
- `graphSummary` (when `includeGraphSummary: true`)

**AutoPub use:** Lighter analysis when AI advice is not needed.

---

#### #2 `POST /api/v1/graphAndAdvice`  **[Phase 2 primary endpoint]**
Send text → get graph + AI-generated advice via LLM.

**Query params (URL):**

| Param | Type | Default |
|---|---|---|
| `doNotSave` | boolean | `true` |
| `addStats` | boolean | `true` |
| `optimize` | `develop\|reinforce\|gaps\|imagine` | — |
| `transcend` | boolean | `false` |
| `includeStatements` | boolean | `false` |
| `includeGraphSummary` | boolean | `false` |
| `extendedGraphSummary` | boolean | `true` |
| `includeGraph` | boolean | `true` |
| `gapDepth` | integer | `0` |
| `extendedAdvice` | boolean | `false` |

**Body params:**
- `name`, `text`
- `requestMode`: `question | idea | fact | continue | challenge | response | gptchat | summary | graph summary | reprompt`
- `modelToUse` (e.g. `gpt-4o`)
- `pinnedNodes` (array), `prompt` (string), `promptChatContext` (array)
- `aiTopics` (boolean), `modifyAnalyzedText`, `replaceEntities`
- `stopwords` (array), `systemPrompt` (string)

**Response:**
```json
{
  "aiAdvice": [
    { "text": "AI-generated response text...", "finish_reason": "stop" }
  ],
  "graph": { "graphologyGraph": {} },
  "statements": [],
  "usage": 338,
  "created_timestamp": 1722261741
}
```

When `addStats=true`, `aiTopics=true` (body), and `includeGraphSummary=true` are set,
`stats`, `aiTopics`, and `graphSummary` should also be present (parser must check
both root and `result.graph`).

**AutoPub use:** Primary endpoint for `enhanceArticle()`. ONE call gets everything
the pipeline needs for entity-context injection.

---

#### #3 `POST /api/v1/dotGraphFromText`
Send text → get compact DOT-format graph + summary, designed for LLM prompt injection.

(Sister endpoint `/api/v1/dotGraph` takes a pre-built Graphology graph instead.)

**Query params (URL):**

| Param | Type | Default |
|---|---|---|
| `optimize` | `auto\|reinforce\|develop\|gaps\|latent` | — |
| `includeGraph` | boolean | `false` |
| `includeGraphSummary` | boolean | `true` |
| `extendedGraphSummary` | boolean | `true` |

**`doNotSave` is NOT a valid param here.**

**Body params:**
- `name`, `text`
- `stopwords` (array)
- `aiTopics` (boolean) — should be `true` to get cluster labels

**Response:**
```json
{
  "graphKeywords":   "apple <-> orange [label=\"delicious, fruit\"]...",
  "clusterIds":      [],
  "clusterKeywords": "\"cluster A keywords\" and \"cluster B keywords\"",
  "allClusters":     [
    { "text": "cluster A description" },
    { "text": "cluster B description" }
  ],
  "graphSummary":    "compact natural-language summary",
  "bigrams":         [ "concept1 <-> concept2", "concept3 <-> concept4" ]
}
```

**AutoPub use:** Standalone graphSummary fetcher. Now redundant if #2 is configured to
return graphSummary. Kept as public helper for ad-hoc use.

---

### Endpoints we don't use (yet)

#### #4 `POST /api/v1/graphAiAdvice`
Send a PRE-EXISTING Graphology graph → get AI advice. Useful when you already extracted
a graph (e.g. from #1) and want multiple advice flavors without reprocessing text.

**Query params:** `optimize` (`gaps|reinforce|develop|imagine`), `transcend` (boolean)

**Body:** `prompt`, `userPrompt`, `promptContext`, `promptChatContext`, `requestMode`,
`language`, `modelToUse`, `pinnedNodes`, `topicsToProcess`, `graph` (Graphology graph
with `nodes`, `edges`, `attributes.{top_nodes, top_clusters, gaps, statementHashtags}`),
`statements`. **No `text` field.**

**Response:** Same as #2 — `{ aiAdvice: [{ text, finish_reason }] }`.

**Potential use:** Multi-perspective enrichment. Call #1 once to get graph, then call
#4 multiple times with different `optimize` modes:
1. `optimize=gaps` → "what's missing"
2. `optimize=reinforce` → "what to emphasize"
3. `optimize=develop` → "what to explore further"

Cheaper than re-running text analysis each time.

---

#### #5 `POST /api/v1/listGraphs`
List user's saved graphs. Filter by `query`, `type`, `fromDate`, `toDate`, `language`,
`favorite`. Comma-separated values for OR logic.

**AutoPub:** Not relevant — we use `doNotSave: true` so we don't have stored graphs.

---

#### #6 `POST /api/v1/search`
Search across user's saved statements and build a graph from matches.

**Body:** `query`, `contextNames`, `userName`, `maxNodes`, `showContexts`.

**AutoPub:** Not relevant — same reason as #5.

---

#### #7 `POST /api/v1/compareGraphs`  **[HIGH VALUE — should integrate]**
Submit 2+ contexts → get merged/overlapped/differenced graph.

**Query params:**

| Param | Type | Default |
|---|---|---|
| `doNotSave` | boolean | `true` |
| `addStats` | boolean | `true` |
| `includeStatements` | boolean | `false` |
| `includeGraphSummary` | boolean | `false` |
| `includeGraph` | boolean | `true` |
| `mode` | `merge\|overlap\|difference` | — |

**Body:**
```json
{
  "contexts": [
    { "text": "first text to compare" },
    { "text": "second text to compare" },
    { "name": "existing_graph_name" }
  ]
}
```

Each context can be `{text}`, `{name}`, or `{statements}`.

**AutoPub use case:** For clusters with 2+ source articles, call with `mode: 'difference'`
to find what's unique to each source. Currently, `_rewriteCluster()` joins all sources
with `\n\n` and sends as one text — losing per-source boundaries. This endpoint preserves
source-by-source angles.

---

#### #8 `POST /api/v1/graphsAndAiAdvice`  **[HIGHEST VALUE for multi-source clusters]**
Compare multiple contexts AND get AI advice in one call. Combines #7 + #2.

**Query params:** Same as #2, plus `compareMode` (from #7).

**Body:** Same `contexts` array as #7, plus body params from #2 (`requestMode`, `aiTopics`, etc.).

**Example:**
```js
fetch('https://infranodus.com/api/v1/graphsAndAiAdvice?doNotSave=true&addStats=true&optimize=gaps', {
  method: 'POST',
  body: JSON.stringify({
    contexts: [
      { text: 'first source article' },
      { text: 'second source article' }
    ],
    requestMode: 'question',
    compareMode: 'difference'
  })
})
```

**AutoPub use case:** Drop-in replacement for the pre-rewrite call when cluster has 2+ articles.
Returns AI advice specifically about source differences in ONE call.

---

### SEO endpoints (Google search integration)

**Critical:** `doNotSave` defaults to **`false`** for endpoints #9–#14 (opposite of text endpoints).
Always pass `?doNotSave=true` explicitly to avoid storing graphs against your account.

These are the ONLY endpoints where InfraNodus reaches out to external data (Google) on your behalf.
Cache aggressively (6 hours per query) and use only for high-priority clusters.

---

#### #9 `POST /api/v1/import/googleSearchResultsGraph`
Submit search query → InfraNodus fetches top Google results → builds knowledge graph from them.

**Query params:**
- `doNotSave` (boolean, **default `false`** — opposite of text endpoints!)
- Plus all params from `graphAndStatements` (#1)

**Body:**
- `searchQuery` (string)
- `aiTopics` (boolean)
- `doNotAddGraph` (boolean)
- `importCountry` (string, e.g. `"US"`, `"IN"`)
- `importLanguage` (string, e.g. `"AUTO"`, `"EN"`)

**Response (different shape — wrapped):**
```json
{
  "entriesAndGraphOfContext": {
    "statements": [
      { "content": "...", "categories": ["category 1", "category 2"] }
    ],
    "graph": {
      "nodes": [],
      "edges": [],
      "graph": { "nodes_to_statements_map": {} }
    }
  }
}
```

**AutoPub use:** Pre-rewrite SEO check — "what does Google currently rank for this topic?"

---

#### #10 `POST /api/v1/import/googleSearchResultsAiAdvice`
Same as #9 but returns AI advice on the Google results graph.

**Query params:** `doNotSave` + all from #2.
**Body:** `searchQuery`, `aiTopics`, `requestMode`, `importCountry`, `importLanguage`.
**Response:** Same as #2 — `{ aiAdvice: [{ text, finish_reason }] }`.

**AutoPub use:** "Tell me what topics top-ranking content covers and where the gaps are."
Drop-in for pre-rewrite SEO advice.

---

#### #11 `POST /api/v1/import/googleSearchIntentGraph`
Submit search query → graph of related Google search queries (autocomplete / AdWords / related).

**Body:**
- `searchQuery`
- `aiTopics`, `doNotAddGraph`
- `keywordsSource` — `'related'` (other values may exist for autocomplete/adwords)
- `importCountry`, `importLanguage`

**Response:** List of statements + graph (same shape as #1 root).

**AutoPub use:** Reader-intent enrichment — "what do people search for around this topic?"
Long-tail keywords for FAQ section generation and H2 headings.

---

#### #12 `POST /api/v1/import/googleSearchIntentAiAdvice`
AI advice on search intent graph.

**Body:** `searchQuery`, `aiTopics`, `requestMode`, `keywordsSource`.
**Response:** Same as #2.

**AutoPub use:** "Tell me what readers want to know about this topic that current content doesn't cover."

---

#### #13 `POST /api/v1/import/googleSearchVsIntentGraph`
Compare Google search RESULTS (supply) vs. search INTENT (demand). Identify topics with
high search demand but low ranking content supply.

**Query params:**
- `compareMode`: `'difference' | 'difference_nodes'`
- Plus all params from #1

**Body:**
- `searchQuery`
- `aiTopics`

**Example URL:** `?compareMode=difference&doNotSave=true&addStats=true`

**AutoPub use:** Highest-value SEO insight — "where is search demand exceeding supply?"
Use only for `priority='high'` clusters to conserve API calls.

---

#### #14 `POST /api/v1/import/googleSearchVsIntentAiAdvice`
AI advice on the supply-vs-demand gap.

**Query params:** `compareMode` + params from #2.
**Body:** `searchQuery`, `aiTopics`, `requestMode`, `keywordsSource`.
**Response:** Same as #2.

**AutoPub use:** "Generate questions about underserved search niches in this topic."

---

## Recommended fix plan

### Phase 1 (URGENT) — fix the 8 bugs
Single-file change in `src/modules/infranodus.js`:

1. Add `queryParams` arg to `_callAPI(endpoint, body, queryParams, signal)` —
   pass via axios `options.params` (auto-encodes for URL)
2. `analyzeText()`: move `doNotSave`, `addStats`, `compactGraph`, `includeGraphSummary`,
   `extendedGraphSummary` into queryParams
3. `analyzeWithAdvice()`: same + add `requestMode: 'summary'` to body, move
   `optimize`, `gapDepth`, `includeGraphSummary` into queryParams
4. `getCompactGraph()`: remove `doNotSave`, add `aiTopics: true` to body, move
   `optimize`, `includeGraphSummary`, `extendedGraphSummary` into queryParams
5. `enhanceArticle()`:
   - Collapse to ONE call (graphAndAdvice with all flags)
   - Fix advice parser: read `result.aiAdvice[0].text`
   - Defensive: parse `aiTopics` / `stats` / `graphSummary` from `result` OR `result.graph`
   - Cache the structured result (already done)

**No changes to `pipeline.js` or `rewriter.js` needed** — `enhanceArticle()` return shape stays the same.

### Phase 2 — Multi-source cluster support (#7 / #8)
For clusters with ≥2 sources, replace the pre-rewrite "join + analyze" call with
`graphsAndAiAdvice` (#8). Single call gets both source comparison and AI advice.

`buildPrompt()` needs a new "Source Analysis" sub-block in the entity context, e.g.:
```
Source Overlap: <shared topics across all sources>
Unique Angles per Source:
  - Source 1: <topics only in source 1>
  - Source 2: <topics only in source 2>
```

### Phase 3 — SEO enrichment (#9–#14)
Per the existing integration guide. Cache by query for 6 hours. Only for
`priority='high'` clusters. Endpoints #10 and #14 are most directly useful (return
advice text directly).

`buildPrompt()` additions:
- `SEO Coverage Requirements` section from #10 (what currently ranks)
- `Reader Search Intent` section from #12 (what people search for)
- `Content Opportunity Gaps` section from #14 (supply-vs-demand gap)

### Phase 4 — Multi-perspective advice (#4)
Optional. Only if `buildPrompt()` evolves to consume multiple advice dimensions
(gaps + reinforce + develop). Cheaper than re-running text analysis.

---

## Appendix A — `optimize` modes

From InfraNodus Appendix 2 (canonical):

| Mode | Description |
|---|---|
| `develop` | Top nodes from ALL clusters — broad coverage of the discourse |
| `reinforce` | Top nodes from TOP clusters only — dominant themes |
| `gaps` | Bridges structural gaps. Use `gapDepth` (0–3) for deeper gaps |
| `latent` | Least represented clusters — underdeveloped areas |
| `imagine` | Conceptual gateways — connects to other discourses |
| `optimize` | Adaptive. Auto-selects strategy based on graph bias/coherence |

**Note:** Endpoint #2 docs show `'gap'` (singular) — this is a documentation typo.
All other docs and the canonical Appendix 2 use `'gaps'` (plural). Use `'gaps'`.

---

## Appendix B — `requestMode` options

From InfraNodus Appendix 1:

| Mode | Description |
|---|---|
| `summary` | Graph-augmented summary **(recommended default for AutoPub)** |
| `graph summary` | Per-cluster summaries |
| `question` | Question that bridges gaps (good for FAQ generation) |
| `idea` | Innovative idea bridging gaps |
| `fact` | Factual statement bridging gaps |
| `challenge` | Challenges weak points (good for editorial review) |
| `continue` | Connects concepts using graph context |
| `response` | Direct response to a prompt |
| `paraphrase` | Paraphrase main topics in one paragraph |
| `outline` | Article title + outline based on graph structure |
| `reprompt` | Rewrites prompt using graph context (for GraphRAG) |
| `gptchat` | Chat mode |
| `custom` | Use custom `prompt` body param |
| `transcend` | Selects clusters then generates ideas beyond the graph |

---

## Appendix C — Privacy & rate limits

- `doNotSave: true` (default for text endpoints) — text NOT stored on InfraNodus servers
- With `aiTopics: true`, only top cluster concepts (not full text) sent to OpenAI
- Servers: InfraNodus EU (AWS Ireland)
- Free tier: limited requests without API key (subject to rate limiting)
- Production: 14-day free trial, then paid

**For SEO endpoints (#9–#14):** `doNotSave` defaults to **`false`** — explicitly set
`true` or graphs will accumulate.

---

## Appendix D — Quick reference: which endpoint for what?

| Need | Endpoint | Notes |
|---|---|---|
| Topic + gap extraction from text | #1 graphAndStatements | Lighter, no AI advice |
| Text analysis + AI content strategy | #2 graphAndAdvice | **Use this for `enhanceArticle()`** |
| Compact summary for LLM context | #3 dotGraphFromText | Or use #2 with `includeGraphSummary=true` |
| Multi-perspective advice on existing graph | #4 graphAiAdvice | Cheap follow-up calls |
| List user's stored graphs | #5 listGraphs | Not used (we don't save) |
| Search stored statements | #6 search | Not used (we don't save) |
| Compare 2+ source articles | #7 compareGraphs | For multi-source clusters |
| Compare + advice in one call | #8 graphsAndAiAdvice | **Use for cluster pre-rewrite** |
| What ranks on Google for X? | #9 googleSearchResultsGraph | SEO supply analysis |
| AI advice on what ranks on Google | #10 googleSearchResultsAiAdvice | Drop-in SEO advice |
| What do people search around X? | #11 googleSearchIntentGraph | Demand analysis |
| AI advice on search intent | #12 googleSearchIntentAiAdvice | Reader-intent advice |
| Supply vs demand gaps for X | #13 googleSearchVsIntentGraph | Highest-value SEO graph |
| AI advice on supply-vs-demand gaps | #14 googleSearchVsIntentAiAdvice | Highest-value SEO advice |

---

## Change log

- **2026-04-13** — Initial review covering all 14 endpoints. Identified 8 bugs.
  Phase 1 fix plan drafted but **not yet applied** to `src/modules/infranodus.js`.
  Created at user's request as authoritative reference for future AI agents.
