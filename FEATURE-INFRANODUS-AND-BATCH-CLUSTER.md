# Feature: InfraNodus Content Editor Integration + Batch Article Clustering

> **v2 — Corrected against actual codebase (April 2026)**
> Fixes: `.enabled` property (not `.isEnabled()`), infraData threaded through `promptSettings` → `buildPrompt()`, Endpoint A creates drafts, Endpoint B resets draft status, priority is TEXT `'normal'`/`'high'`, frontend injection points verified.

## Overview

Two features for HDF AutoPub:

1. **InfraNodus in Content Editor** — When viewing/editing a draft or published article, show the InfraNodus entity analysis (what was fetched, what AI used) in the editor panel.
2. **Batch Article Clustering** — On the Live Feed or Drafts pages, allow selecting multiple articles and grouping them into a manual cluster so the AI rewriter gets richer multi-source context.

## Branch

```
git checkout -b feature/infranodus-ui-and-batch-clusters
```

---

## Feature 1: InfraNodus Content Editor Integration

### The Problem

`infranodus.js` already has `analyzeText()` and `enhanceArticle()` methods, but the results are never shown in the dashboard. The user can't see what entities InfraNodus found or what the AI used from the analysis. Currently InfraNodus is a black box — it works in the background but the editorial team has no visibility.

### Database Changes

Add a new column to the `drafts` table in `src/utils/db.js` migrations:

```sql
ALTER TABLE drafts ADD COLUMN infranodus_data TEXT DEFAULT NULL;
```

### Backend Changes

#### A. Modify `src/workers/pipeline.js` — Rewrite loop (`_rewriteCluster` method, after line ~296)

In `_rewriteCluster()`, AFTER building `primaryArticle` and `clusterForRewrite` objects (around line 296), BEFORE calling `this.rewriter.rewrite()` (line 300), add the InfraNodus analysis step:

**Key fact:** `infranodus.enabled` is a boolean PROPERTY (line 15 of infranodus.js), NOT a method. There is no `.isEnabled()` method.

```js
// --- INSERT AFTER line 294 (after primaryArticle object is built) ---

// InfraNodus entity analysis (if enabled)
var infraData = null;
if (this.infranodus && this.infranodus.enabled) {
  try {
    var combinedText = clusterDrafts
      .map(function(d) { return d.extracted_content || ''; })
      .join('\n\n')
      .slice(0, 5000);
    if (combinedText.length > 100) {
      infraData = await this.infranodus.enhanceArticle(combinedText);
      // Store on primary draft for the frontend panel
      if (infraData) {
        this.db.prepare('UPDATE drafts SET infranodus_data = ? WHERE id = ?')
          .run(JSON.stringify(infraData), primaryDraft.id);
      }
    }
  } catch (infraErr) {
    this.logger.warn(MODULE, 'InfraNodus analysis failed, continuing without it: ' + infraErr.message);
  }
}

// Pass infraData to rewriter via options (3rd argument)
var rewritten = await this.rewriter.rewrite(primaryArticle, clusterForRewrite, { infraData: infraData });
```

**REPLACES** the existing line 300:
```js
// OLD: var rewritten = await this.rewriter.rewrite(primaryArticle, clusterForRewrite);
// NEW: var rewritten = await this.rewriter.rewrite(primaryArticle, clusterForRewrite, { infraData: infraData });
```

**Also:** The Pipeline constructor (line 18) does NOT currently receive `infranodus`. You need to:
1. Add `infranodus` as a parameter: `constructor(config, db, rewriter, publisher, logger, extractor, infranodus)`
2. Store it: `this.infranodus = infranodus || null;`
3. In `src/index.js` where Pipeline is instantiated, pass the infranodus module as the last argument.

#### B. Modify `src/modules/rewriter.js` — Thread infraData into buildPrompt()

The `rewrite()` method (line 850) receives `options` as its 3rd argument. It builds `promptSettings` at lines 888–896 and passes them to `buildPrompt()` at line 897. **infraData must be added to promptSettings** so it reaches `buildPrompt()`.

**In `rewrite()`, after line 896 (after `publicationUrl` is set in `promptSettings`):**

```js
    var promptSettings = {
      targetKeyword: opts.targetKeyword || '',
      targetDomain: opts.targetDomain || '',
      language: opts.language || 'en+hi',
      schemaTypes: opts.schemaTypes || 'NewsArticle,FAQPage,BreadcrumbList',
      customPrompt: opts.customPrompt || '',
      publicationName: publicationName,
      publicationUrl: publicationUrl,
      infraData: opts.infraData || null,       // ← ADD THIS LINE
    };
```

**In `buildPrompt()` (line 132), after `trendingContext` is built (around line 191):**

```js
  // --- INSERT AFTER line 191 (after trendingContext block) ---

  var entityContext = '';
  if (s.infraData) {
    var infra = s.infraData;
    entityContext = '\n--- ENTITY ANALYSIS (from InfraNodus) ---\n';
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
    entityContext += '--- END ENTITY ANALYSIS ---\n\n';
  }
```

Then include `entityContext` in the system prompt string. Find where `trendingContext` is interpolated (line 254) and add `entityContext` right after it:

```js
    trendingContext.replace(/\n+$/, ''),
    entityContext,                               // ← ADD THIS LINE
    '',
    '# STEP 1 — STRUCTURE SIGNALS ...',
```

#### C. New API endpoint — GET /api/drafts/:id/infranodus

In `src/routes/api.js`, add:

```js
// Note: checkAuth middleware is already applied at the router level in index.js
// (app.use('/api', checkAuth, apiRouter)) — no per-route auth needed.
router.get('/drafts/:id/infranodus', (req, res) => {
  const draft = db.prepare('SELECT id, infranodus_data, ai_model_used FROM drafts WHERE id = ?')
    .get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  let infraData = null;
  try {
    infraData = draft.infranodus_data ? JSON.parse(draft.infranodus_data) : null;
  } catch (e) {
    infraData = null;
  }

  res.json({
    draftId: draft.id,
    aiModel: draft.ai_model_used,
    infraData,
    hasInfraData: !!infraData
  });
});
```

#### D. New API endpoint — POST /api/drafts/:id/analyze (manual trigger)

Allow the user to manually trigger InfraNodus analysis on any draft:

```js
router.post('/drafts/:id/analyze', async (req, res) => {
  const draft = db.prepare('SELECT id, extracted_content, rewritten_html FROM drafts WHERE id = ?')
    .get(req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const text = draft.extracted_content || draft.rewritten_html || '';
  if (!text) return res.status(400).json({ error: 'No content to analyze' });

  // infranodus is the module instance — check .enabled property (NOT .isEnabled())
  if (!infranodus || !infranodus.enabled) {
    return res.status(400).json({ error: 'InfraNodus is not enabled. Set INFRANODUS_ENABLED=true in settings.' });
  }

  try {
    const infraData = await infranodus.enhanceArticle(text.slice(0, 5000));
    db.prepare('UPDATE drafts SET infranodus_data = ? WHERE id = ?')
      .run(JSON.stringify(infraData), draft.id);
    res.json({ success: true, infraData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Frontend Changes — Dashboard

#### E. Add InfraNodus panel to draft/article editor

In `public/js/dashboard.js`, the draft detail view renders around lines 3489–3539 where the cluster sources panel lives. Add a new collapsible section AFTER the cluster sources panel:

```html
<!-- InfraNodus Analysis Panel — add inside draft editor/modal -->
<div class="infra-panel" id="infra-panel-${draftId}" style="display:none;">
  <div class="infra-header" onclick="toggleInfraPanel(${draftId})">
    <span class="infra-icon">&#128300;</span>
    <span>InfraNodus Entity Analysis</span>
    <span class="infra-badge" id="infra-badge-${draftId}"></span>
  </div>
  <div class="infra-body" id="infra-body-${draftId}">
    <div class="infra-loading">Fetching analysis...</div>
  </div>
</div>
```

#### F. JavaScript to load and render InfraNodus data

```js
async function loadInfraData(draftId) {
  var panel = document.getElementById('infra-panel-' + draftId);
  var body = document.getElementById('infra-body-' + draftId);
  var badge = document.getElementById('infra-badge-' + draftId);

  if (!panel) return;

  try {
    var res = await fetchApi('/api/drafts/' + draftId + '/infranodus');
    var data = await res.json();

    if (!data.hasInfraData) {
      badge.textContent = 'No data';
      badge.className = 'infra-badge infra-badge-empty';
      body.innerHTML =
        '<p class="infra-empty">No InfraNodus analysis available for this draft.</p>' +
        '<button class="btn btn-sm btn-outline" onclick="runInfraAnalysis(' + draftId + ')">' +
        'Run Analysis Now</button>';
      panel.style.display = 'block';
      return;
    }

    var infra = data.infraData;
    badge.textContent = (infra.mainTopics ? infra.mainTopics.length : 0) + ' topics';
    badge.className = 'infra-badge infra-badge-active';

    var html = '';

    // Main Topics
    if (infra.mainTopics && infra.mainTopics.length) {
      html += '<div class="infra-section"><h4>Main Topics (What InfraNodus Found)</h4><div class="infra-tags">';
      infra.mainTopics.forEach(function(t) {
        html += '<span class="infra-tag infra-tag-topic">' + escapeHtml(t) + '</span>';
      });
      html += '</div></div>';
    }

    // Missing Entities
    if (infra.missingEntities && infra.missingEntities.length) {
      html += '<div class="infra-section"><h4>Entities AI Should Cover</h4><div class="infra-tags">';
      infra.missingEntities.forEach(function(e) {
        html += '<span class="infra-tag infra-tag-entity">' + escapeHtml(e) + '</span>';
      });
      html += '</div></div>';
    }

    // Content Gaps
    if (infra.contentGaps && infra.contentGaps.length) {
      html += '<div class="infra-section"><h4>Content Gaps (Bridging Opportunities)</h4><ul class="infra-gaps">';
      infra.contentGaps.forEach(function(g) {
        html += '<li>' + escapeHtml(g) + '</li>';
      });
      html += '</ul></div>';
    }

    // Research Questions
    if (infra.researchQuestions && infra.researchQuestions.length) {
      html += '<div class="infra-section"><h4>Research Questions for Depth</h4><ul class="infra-questions">';
      infra.researchQuestions.forEach(function(q) {
        html += '<li>' + escapeHtml(q) + '</li>';
      });
      html += '</ul></div>';
    }

    // AI Model Used
    html += '<div class="infra-section infra-meta">' +
      '<span>AI Model: <strong>' + escapeHtml(data.aiModel || 'unknown') + '</strong></span>' +
      '<button class="btn btn-sm btn-outline" onclick="runInfraAnalysis(' + draftId + ')">' +
      'Re-run Analysis</button></div>';

    body.innerHTML = html;
    panel.style.display = 'block';
  } catch (err) {
    body.innerHTML = '<p class="infra-error">Failed to load: ' + err.message + '</p>';
    panel.style.display = 'block';
  }
}

function toggleInfraPanel(draftId) {
  var body = document.getElementById('infra-body-' + draftId);
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
}

async function runInfraAnalysis(draftId) {
  var body = document.getElementById('infra-body-' + draftId);
  body.innerHTML = '<div class="infra-loading">Running InfraNodus analysis...</div>';

  try {
    var res = await fetchApi('/api/drafts/' + draftId + '/analyze', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      loadInfraData(draftId); // reload the panel
    } else {
      body.innerHTML = '<p class="infra-error">' + escapeHtml(data.error) + '</p>';
    }
  } catch (err) {
    body.innerHTML = '<p class="infra-error">' + err.message + '</p>';
  }
}
```

**Call `loadInfraData(draftId)` from wherever the draft detail panel opens** — find the function that renders the draft detail (look for where `cluster_sources` panel is populated) and add the call there.

#### G. CSS for InfraNodus panel

Add to `public/css/dashboard.css`:

```css
.infra-panel {
  margin-top: 12px;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  background: #1a1a2e;
  overflow: hidden;
}
.infra-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  background: #1e1e32;
  font-weight: 600;
  font-size: 13px;
}
.infra-header:hover { background: #252540; }
.infra-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
}
.infra-badge-active { background: #1a6b3c; color: #7dffb3; }
.infra-badge-empty { background: #333; color: #888; }
.infra-body { padding: 14px; }
.infra-section { margin-bottom: 14px; }
.infra-section h4 {
  font-size: 12px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.infra-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.infra-tag {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
}
.infra-tag-topic { background: #1a3a5c; color: #7db8ff; }
.infra-tag-entity { background: #5c3a1a; color: #ffb87d; }
.infra-gaps li, .infra-questions li {
  font-size: 13px;
  color: #ccc;
  margin-bottom: 4px;
  padding-left: 12px;
  position: relative;
}
.infra-gaps li::before { content: '→'; position: absolute; left: 0; color: #e8943a; }
.infra-questions li::before { content: '?'; position: absolute; left: 0; color: #7db8ff; }
.infra-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid #2a2a3e;
  font-size: 12px;
  color: #888;
}
.infra-loading { color: #888; font-size: 13px; }
.infra-error { color: #ff6b6b; font-size: 13px; }
.infra-empty { color: #666; font-size: 13px; margin-bottom: 8px; }
```

---

## Feature 2: Batch Article Clustering (Manual Cluster from Singles)

### The Problem

Currently on the Live Feed page, single articles (not part of a cluster) can only be fetched one at a time. The AI only has ONE source to work with. The user wants to select multiple articles and group them into a manual cluster so the AI rewriter gets richer context from multiple sources.

### How It Works (User Flow)

1. User is on **Live Feed** page
2. User checks checkboxes on 2–5 related articles
3. User clicks **"Create Cluster"** (appears when 2+ articles selected)
4. A modal asks for an optional cluster topic/name
5. Backend creates a new cluster with `status = 'queued'` and `priority = 'high'`
6. Backend creates a draft row for EACH selected article (mode = `'manual_import'`, status = `'fetching'`)
7. The extraction worker picks up the drafts, extracts content, sets status to `'draft'`
8. Once all drafts are at `'draft'` status, the rewrite loop picks up the cluster (with InfraNodus analysis)
9. Cluster appears on the **Clusters** page and flows through the normal pipeline

### Database Changes

No schema changes needed beyond the `infranodus_data` column from Feature 1. The existing `clusters` table + `drafts.cluster_id` handle this.

**Key fact:** `clusters.priority` is `TEXT DEFAULT 'normal'` (db.js line 80). Valid values are `'normal'` and `'high'`. NOT integers.

### Backend Changes

#### A. New API endpoint — POST /api/clusters/manual (from feed articles)

Creates a cluster AND creates draft rows for each article, so the pipeline can pick it up.

```js
router.post('/clusters/manual', (req, res) => {
  const { articleIds, topic } = req.body;

  // Validate
  if (!articleIds || !Array.isArray(articleIds) || articleIds.length < 2) {
    return res.status(400).json({ error: 'Select at least 2 articles to create a cluster' });
  }
  if (articleIds.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 articles per manual cluster' });
  }

  // Fetch articles from the articles table
  const placeholders = articleIds.map(() => '?').join(',');
  const articles = db.prepare(
    `SELECT id, title, url, domain, cluster_id FROM articles WHERE id IN (${placeholders})`
  ).all(...articleIds);

  if (articles.length < 2) {
    return res.status(400).json({ error: 'Could not find enough valid articles' });
  }

  // Check if any are already in a cluster
  const alreadyClustered = articles.filter(a => a.cluster_id);
  if (alreadyClustered.length > 0) {
    return res.status(400).json({
      error: `${alreadyClustered.length} article(s) already belong to a cluster. Remove them first or pick different articles.`,
      clusteredIds: alreadyClustered.map(a => a.id)
    });
  }

  const clusterTopic = topic || articles[0].title.slice(0, 120);
  const primaryArticleId = articleIds[0]; // first selected = primary

  // Use a transaction to create cluster + drafts atomically
  const createCluster = db.transaction(() => {
    // 1. Create cluster — status='queued' so rewrite loop picks it up
    //    priority='high' (TEXT, not integer) so manual clusters get priority
    const clusterResult = db.prepare(`
      INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id,
                            trends_boosted, priority, status, detected_at)
      VALUES (?, ?, 1.0, ?, 0, 'high', 'queued', datetime('now', 'localtime'))
    `).run(clusterTopic, articles.length, primaryArticleId);

    const clusterId = clusterResult.lastInsertRowid;

    // 2. Assign articles to cluster
    const updateArticle = db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?');
    for (const id of articleIds) {
      updateArticle.run(clusterId, id);
    }

    // 3. Create draft rows for each article — mode='manual_import' so pipeline processes them
    //    status='fetching' so extraction worker picks them up first
    const insertDraft = db.prepare(`
      INSERT INTO drafts (source_article_id, source_url, source_domain, source_title,
                          cluster_id, cluster_role, mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'manual_import', 'fetching', datetime('now'), datetime('now'))
    `);

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const role = (a.id === primaryArticleId) ? 'primary' : 'secondary';
      insertDraft.run(a.id, a.url, a.domain, a.title, clusterId, role);
    }

    return clusterId;
  });

  try {
    const clusterId = createCluster();
    res.json({
      success: true,
      clusterId,
      topic: clusterTopic,
      articleCount: articles.length,
      message: `Manual cluster created with ${articles.length} articles. Extraction will start automatically.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create cluster: ' + err.message });
  }
});
```

#### B. New API endpoint — POST /api/clusters/manual-from-drafts

For selecting drafts that already exist (e.g., single articles that were imported or fetched individually and may already be at `ready` or `draft` status). **Resets status to `'draft'` and mode to `'manual_import'`** so the rewrite loop re-runs with multi-source context.

```js
router.post('/clusters/manual-from-drafts', (req, res) => {
  const { draftIds, topic } = req.body;

  if (!draftIds || !Array.isArray(draftIds) || draftIds.length < 2) {
    return res.status(400).json({ error: 'Select at least 2 drafts' });
  }
  if (draftIds.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 drafts per manual cluster' });
  }

  const placeholders = draftIds.map(() => '?').join(',');
  const drafts = db.prepare(
    `SELECT id, source_url, source_domain, source_title, cluster_id, cluster_role,
            status, mode, extracted_content
     FROM drafts WHERE id IN (${placeholders})`
  ).all(...draftIds);

  if (drafts.length < 2) {
    return res.status(400).json({ error: 'Not enough valid drafts found' });
  }

  // Warn if any are already in a different cluster
  const alreadyClustered = drafts.filter(d => d.cluster_id);
  if (alreadyClustered.length > 0) {
    return res.status(400).json({
      error: `${alreadyClustered.length} draft(s) already belong to a cluster. Remove them first.`,
      clusteredIds: alreadyClustered.map(d => d.id)
    });
  }

  const clusterTopic = topic || 'Manual Cluster — ' + new Date().toISOString().slice(0, 10);

  const createCluster = db.transaction(() => {
    // 1. Create cluster — status='queued', priority='high' (TEXT)
    const result = db.prepare(`
      INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id,
                            trends_boosted, priority, status, detected_at)
      VALUES (?, ?, 1.0, NULL, 0, 'high', 'queued', datetime('now', 'localtime'))
    `).run(clusterTopic, drafts.length);

    const clusterId = result.lastInsertRowid;

    // 2. Assign drafts to cluster + RESET status so pipeline re-processes them
    //    Primary draft: reset to 'draft' status + 'manual_import' mode
    //    Secondary drafts: same — need extracted_content for the rewriter to read
    const updateDraft = db.prepare(`
      UPDATE drafts SET
        cluster_id = ?,
        cluster_role = ?,
        mode = 'manual_import',
        status = CASE
          WHEN extracted_content IS NOT NULL AND length(extracted_content) > 50
            THEN 'draft'
          ELSE 'fetching'
        END,
        rewritten_html = NULL,
        rewritten_title = NULL,
        rewritten_word_count = NULL,
        infranodus_data = NULL,
        error_message = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lease_expires_at = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    // First draft = primary, rest = secondary
    updateDraft.run(clusterId, 'primary', draftIds[0]);
    for (let i = 1; i < draftIds.length; i++) {
      updateDraft.run(clusterId, 'secondary', draftIds[i]);
    }

    return clusterId;
  });

  try {
    const clusterId = createCluster();
    res.json({
      success: true,
      clusterId,
      topic: clusterTopic,
      draftCount: drafts.length,
      primaryDraftId: draftIds[0],
      message: `Manual cluster created from ${drafts.length} drafts. ` +
        `Drafts with content reset to 'draft' status; drafts without content reset to 'fetching'. ` +
        `Pipeline will rewrite with multi-source context.`
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create cluster: ' + err.message });
  }
});
```

**Why the status reset matters:** The rewrite loop query (pipeline.js line 192) is:
```sql
WHERE d.mode IN ('auto', 'manual_import') AND d.status = 'draft' AND c.status = 'queued'
```
If a draft is sitting at `'ready'` or `'published'`, the pipeline will **never** pick up the new cluster. The CASE statement in the UPDATE checks: if the draft already has extracted content (>50 chars), set it to `'draft'` (ready for rewrite); otherwise set to `'fetching'` so extraction runs first.

### Frontend Changes — Dashboard

#### C. Multi-select + "Create Cluster" button on Live Feed page

In `dashboard.js`, add checkbox handling and a floating action bar. **Verify the actual checkbox class/data attribute used in the feed list before implementing** — the feed items may use `data-article-id` or `data-id`. Adapt accordingly.

```js
function updateBatchActions() {
  var checked = document.querySelectorAll('.feed-checkbox:checked');
  var bar = document.getElementById('batch-action-bar');

  if (checked.length >= 2) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'batch-action-bar';
      bar.className = 'batch-action-bar';
      bar.innerHTML =
        '<span id="batch-count">' + checked.length + ' articles selected</span>' +
        '<input type="text" id="batch-cluster-topic" placeholder="Cluster topic (optional)" class="batch-input" />' +
        '<button class="btn btn-primary btn-sm" onclick="createManualCluster()">Create Cluster</button>' +
        '<button class="btn btn-outline btn-sm" onclick="clearBatchSelection()">Clear</button>';
      document.body.appendChild(bar);
    } else {
      document.getElementById('batch-count').textContent = checked.length + ' articles selected';
      bar.style.display = 'flex';
    }
  } else if (bar) {
    bar.style.display = 'none';
  }
}

async function createManualCluster() {
  var checked = document.querySelectorAll('.feed-checkbox:checked');
  var articleIds = Array.from(checked).map(function(cb) {
    return parseInt(cb.dataset.articleId || cb.dataset.id);
  });
  var topic = (document.getElementById('batch-cluster-topic') || {}).value || '';

  if (articleIds.length < 2) {
    showToast('Select at least 2 articles', 'error');
    return;
  }

  try {
    var res = await fetchApi('/api/clusters/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleIds: articleIds, topic: topic || undefined })
    });
    var data = await res.json();

    if (data.success) {
      showToast('Cluster created: ' + data.articleCount + ' articles → Cluster #' + data.clusterId, 'success');
      clearBatchSelection();
      navigateTo('clusters');
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function clearBatchSelection() {
  document.querySelectorAll('.feed-checkbox:checked, .draft-checkbox:checked').forEach(function(cb) {
    cb.checked = false;
  });
  var bar = document.getElementById('batch-action-bar');
  if (bar) bar.style.display = 'none';
}
```

#### D. Same for drafts page — "Merge into Cluster"

```js
async function mergeIntoCluster() {
  var checked = document.querySelectorAll('.draft-checkbox:checked');
  var draftIds = Array.from(checked).map(function(cb) {
    return parseInt(cb.dataset.draftId || cb.dataset.id);
  });
  var topic = (document.getElementById('batch-cluster-topic') || {}).value || '';

  if (draftIds.length < 2) {
    showToast('Select at least 2 drafts', 'error');
    return;
  }

  try {
    var res = await fetchApi('/api/clusters/manual-from-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftIds: draftIds, topic: topic || undefined })
    });
    var data = await res.json();

    if (data.success) {
      showToast('Cluster created from ' + data.draftCount + ' drafts → Cluster #' + data.clusterId, 'success');
      clearBatchSelection();
      navigateTo('clusters');
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}
```

**Note on the floating action bar:** Both `createManualCluster()` and `mergeIntoCluster()` use the same bar. Detect which page is active to decide which function the "Create Cluster" button calls:

```js
// In updateBatchActions(), set the onclick based on current page:
var isOnDraftsPage = /* check current page/view */;
var btnAction = isOnDraftsPage ? 'mergeIntoCluster()' : 'createManualCluster()';
```

#### E. CSS for batch action bar

Add to `public/css/dashboard.css`:

```css
.batch-action-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  background: #1e1e32;
  border: 1px solid #3a3a5c;
  border-radius: 12px;
  padding: 10px 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  z-index: 1000;
  animation: slideUp 0.2s ease;
}
@keyframes slideUp {
  from { transform: translateX(-50%) translateY(20px); opacity: 0; }
  to { transform: translateX(-50%) translateY(0); opacity: 1; }
}
.batch-action-bar span {
  color: #7dffb3;
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
}
.batch-input {
  background: #0d0d1a;
  border: 1px solid #3a3a5c;
  border-radius: 6px;
  padding: 6px 10px;
  color: #eee;
  font-size: 13px;
  width: 200px;
}
```

---

## Fixes Applied (v1 → v2 Changelog)

| # | Issue | v1 (wrong) | v2 (fixed) |
|---|-------|-----------|------------|
| 1 | InfraNodus enabled check | `infranodus.isEnabled()` | `infranodus.enabled` (boolean property, line 15) |
| 2 | Endpoint A creates no drafts | Only creates cluster + updates articles table | Creates cluster + creates draft rows with `mode='manual_import'`, `status='fetching'` |
| 3 | Endpoint B doesn't reset status | Assigns cluster_id but leaves status as-is | Resets status to `'draft'` (if content exists) or `'fetching'` (if not), clears rewritten fields |
| 4 | infraData not in buildPrompt() | `rewrite()` passes infraData in options but `buildPrompt()` never receives it | Added `infraData` to `promptSettings` object, `buildPrompt()` reads from `s.infraData` |
| 5 | priority integer 50/60 | `priority, 50` and `priority, 60` | `'high'` (TEXT matches `clusters.priority TEXT DEFAULT 'normal'` in db.js line 80) |
| 6 | Pipeline constructor missing infranodus | Not mentioned | Added infranodus as constructor parameter, stored as `this.infranodus` |

---

## Files to Modify (Summary)

| File | Changes |
|---|---|
| `src/utils/db.js` | Add `infranodus_data TEXT` column migration |
| `src/index.js` | Pass `infranodus` module to Pipeline constructor |
| `src/workers/pipeline.js` | Add `infranodus` to constructor, call `enhanceArticle()` before rewrite, pass `{ infraData }` to `rewriter.rewrite()` |
| `src/modules/rewriter.js` | Add `infraData` to `promptSettings` in `rewrite()`, add `entityContext` block in `buildPrompt()` |
| `src/routes/api.js` | Add 4 new endpoints: GET/POST infranodus per draft, POST manual cluster from articles, POST manual cluster from drafts |
| `public/js/dashboard.js` | InfraNodus panel in editor, batch action bar, createManualCluster(), mergeIntoCluster(), loadInfraData() |
| `public/css/dashboard.css` | Styles for infra-panel, batch-action-bar |

## Files NOT to Modify

- `src/modules/infranodus.js` — already has the correct API methods, no changes needed
- `src/modules/wp-publisher.js` — publishing flow unchanged
- `src/modules/fuel.js` / `src/modules/metals.js` — not used on srdmgroup.com
- `src/modules/fuel-posts.js` / `src/modules/metals-posts.js` — not used on srdmgroup.com

---

## Testing Checklist

- [ ] Enable InfraNodus in settings (INFRANODUS_ENABLED=true, add API key)
- [ ] Create a manual cluster from 3 feed articles → verify draft rows created with `status='fetching'`
- [ ] Verify extraction worker picks up those drafts and sets `status='draft'`
- [ ] Verify rewrite loop picks up the cluster once all drafts are at `'draft'`
- [ ] Verify InfraNodus panel appears in draft editor with topics/entities
- [ ] Verify "Run Analysis Now" button works on a draft without InfraNodus data
- [ ] Publish the manual cluster — verify AI output references InfraNodus entities in the content
- [ ] Merge 3 already-ready drafts → verify statuses reset to `'draft'` and cluster appears as `'queued'`
- [ ] Verify pipeline re-rewrites the merged cluster with multi-source context
- [ ] Verify batch action bar appears on Feed page when 2+ articles selected
- [ ] Verify batch action bar appears on Drafts page for draft selection
- [ ] Verify articles already in a cluster can't be re-clustered (error message)
- [ ] Verify InfraNodus failure doesn't block the rewrite pipeline (graceful fallback)
- [ ] Verify `clusters.priority` stored as `'high'` (TEXT), not integer
