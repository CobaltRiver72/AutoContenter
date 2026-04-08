'use strict';

var { parentPort } = require('worker_threads');
var natural = require('natural');
var TfIdf = natural.TfIdf;

/**
 * Worker thread for CPU-intensive TF-IDF cosine similarity.
 * Receives: { type: 'findMatches', id, payload: { newArticle, bufferArticles, threshold, allowSameDomain } }
 * Returns:  { type: 'matches', id, payload: { matches: [{ articleId, score }] } }
 */
parentPort.on('message', function(msg) {
  try {
    if (msg.type === 'findMatches') {
      var result = computeMatches(msg.payload);
      parentPort.postMessage({ type: 'matches', id: msg.id, payload: result });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, payload: { message: err.message } });
  }
});

function computeMatches(payload) {
  var newArticle = payload.newArticle;
  var bufferArticles = payload.bufferArticles;
  var threshold = payload.threshold || 0.20;
  var allowSameDomain = payload.allowSameDomain || false;

  if (!newArticle || !newArticle.fingerprint || !bufferArticles || bufferArticles.length === 0) {
    return { matches: [] };
  }

  var tfidf = new TfIdf();

  // Add all buffer article fingerprints to the corpus
  for (var i = 0; i < bufferArticles.length; i++) {
    tfidf.addDocument(bufferArticles[i].fingerprint || '');
  }

  // Add new article fingerprint as the last document
  tfidf.addDocument(newArticle.fingerprint);

  var newDocIndex = bufferArticles.length;
  var matches = [];

  for (var i = 0; i < bufferArticles.length; i++) {
    if (bufferArticles[i].id === newArticle.id) continue;
    if (bufferArticles[i].url === newArticle.url) continue;

    // Cross-language guard — mirror of the main-thread skip in similarity.js
    var langA = newArticle.language;
    var langB = bufferArticles[i].language;
    if (langA && langB && langA !== langB) continue;

    var isSameDomain = bufferArticles[i].domain === newArticle.domain;
    if (isSameDomain && !allowSameDomain) continue;

    var score = cosineSimilarity(tfidf, newDocIndex, i);
    var effectiveThreshold = isSameDomain ? threshold * 1.5 : threshold;

    if (score > effectiveThreshold) {
      matches.push({
        articleId: bufferArticles[i].id,
        articleUrl: bufferArticles[i].url,
        articleDomain: bufferArticles[i].domain,
        articleTitle: bufferArticles[i].title,
        score: Math.round(score * 10000) / 10000,
      });
    }
  }

  matches.sort(function(a, b) { return b.score - a.score; });
  return { matches: matches };
}

function cosineSimilarity(tfidf, docIndexA, docIndexB) {
  var vecA = {};
  var vecB = {};

  tfidf.listTerms(docIndexA).forEach(function(item) { vecA[item.term] = item.tfidf; });
  tfidf.listTerms(docIndexB).forEach(function(item) { vecB[item.term] = item.tfidf; });

  var termsA = Object.keys(vecA);
  var termsB = Object.keys(vecB);
  var allTermsSet = {};
  var j;
  for (j = 0; j < termsA.length; j++) allTermsSet[termsA[j]] = true;
  for (j = 0; j < termsB.length; j++) allTermsSet[termsB[j]] = true;
  var allTerms = Object.keys(allTermsSet);

  var dotProduct = 0, magA = 0, magB = 0;

  for (j = 0; j < allTerms.length; j++) {
    var a = vecA[allTerms[j]] || 0;
    var b = vecB[allTerms[j]] || 0;
    dotProduct += a * b;
    magA += a * a;
    magB += b * b;
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}
