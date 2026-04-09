'use strict';

// ─── Minimal Markdown → HTML Converter ─────────────────────────────────────
//
// Designed for the v2 Master Prompt body_markdown output, which is restricted
// to: paragraphs, H2/H3 headings, **bold**, *italic*, [text](url).
// The prompt forbids tables, code blocks, and images, so this converter
// stays small and predictable. Lists are still handled as a graceful
// fallback in case the model emits them.
//
// Defensive: never throws; returns empty string for falsy input.

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function applyInlineFormatting(text) {
  // Apply inline markdown to ALREADY-escaped text. Order matters:
  // bold before italic so **strong** isn't eaten by single-asterisk regex.
  var out = text;

  // Bold: **text**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* (not part of a **bold** run)
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Links: [text](https://url) — only http/https, no javascript:
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) {
    return '<a href="' + url.replace(/"/g, '&quot;') + '" rel="noopener">' + label + '</a>';
  });

  return out;
}

function convertMarkdownToHtml(md) {
  if (!md || typeof md !== 'string') return '';

  var lines = md.replace(/\r\n/g, '\n').split('\n');
  var blocks = [];
  var paragraphBuffer = [];
  var listBuffer = [];
  var listType = null; // 'ul' or 'ol'

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return;
    var text = paragraphBuffer.join(' ').trim();
    if (text) {
      blocks.push('<p>' + applyInlineFormatting(escapeHtml(text)) + '</p>');
    }
    paragraphBuffer = [];
  }

  function flushList() {
    if (listBuffer.length === 0) return;
    var tag = listType || 'ul';
    var items = listBuffer.map(function (item) {
      return '<li>' + applyInlineFormatting(escapeHtml(item)) + '</li>';
    }).join('');
    blocks.push('<' + tag + '>' + items + '</' + tag + '>');
    listBuffer = [];
    listType = null;
  }

  function flushAll() {
    flushParagraph();
    flushList();
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    // Blank line — paragraph/list separator
    if (trimmed === '') {
      flushAll();
      continue;
    }

    // ATX headings (## H2, ### H3) — H1 not allowed (CMS owns the title)
    var headingMatch = trimmed.match(/^(#{2,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      flushAll();
      var level = headingMatch[1].length;
      var content = headingMatch[2];
      blocks.push('<h' + level + '>' + applyInlineFormatting(escapeHtml(content)) + '</h' + level + '>');
      continue;
    }

    // Unordered list items: -, *, +
    var ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuffer.push(ulMatch[1]);
      continue;
    }

    // Ordered list items: 1. text
    var olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuffer.push(olMatch[1]);
      continue;
    }

    // Regular paragraph line — accumulate
    flushList();
    paragraphBuffer.push(trimmed);
  }

  flushAll();
  return blocks.join('\n');
}

module.exports = { convertMarkdownToHtml };
