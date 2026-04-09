'use strict';

// ─── Minimal Markdown → HTML Converter ─────────────────────────────────────
//
// Designed for the v2 Master Prompt body_markdown output. Supports:
// paragraphs, H2/H3 headings, **bold**, *italic*, [text](url), unordered
// lists (-/*/+), ordered lists (1.), and pipe tables. Tables are produced
// by Step-1 signal-driven structure (parallel_facts, comparison,
// conditional_rules) and rendered with the `hdf-table` class so themes
// can style them.
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

function parsePipeRow(line) {
  // Strip leading/trailing pipe and split. Handles both `| a | b |` and `a | b`.
  var s = line.trim();
  if (s.charAt(0) === '|') s = s.substring(1);
  if (s.charAt(s.length - 1) === '|') s = s.substring(0, s.length - 1);
  return s.split('|').map(function (c) { return c.trim(); });
}

function isTableSeparator(line) {
  // |---|---| or | :--- | ---: | etc.
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return false;
  var cells = parsePipeRow(line);
  if (cells.length === 0) return false;
  for (var i = 0; i < cells.length; i++) {
    if (!/^:?-{3,}:?$/.test(cells[i])) return false;
  }
  return true;
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

  function renderTable(headerCells, rows) {
    var html = '<table class="hdf-table"><thead><tr>';
    for (var hi = 0; hi < headerCells.length; hi++) {
      html += '<th>' + applyInlineFormatting(escapeHtml(headerCells[hi])) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var ri = 0; ri < rows.length; ri++) {
      html += '<tr>';
      for (var ci = 0; ci < rows[ri].length; ci++) {
        html += '<td>' + applyInlineFormatting(escapeHtml(rows[ri][ci])) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
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

    // Markdown pipe table: header row + separator + body rows
    if (trimmed.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      var headerCells = parsePipeRow(trimmed);
      i += 2; // skip header and separator
      var rows = [];
      while (i < lines.length) {
        var rowLine = lines[i];
        var rowTrim = rowLine.trim();
        if (rowTrim === '' || rowTrim.indexOf('|') === -1) break;
        rows.push(parsePipeRow(rowTrim));
        i++;
      }
      i--; // outer loop will i++ again
      blocks.push(renderTable(headerCells, rows));
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
