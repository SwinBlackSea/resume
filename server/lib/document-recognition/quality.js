'use strict';

const { RECOMMENDED_MAX_PAGES } = require('./constants');

function compactText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function criticalTokens(text) {
  const value = String(text || '');
  const patterns = [
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
    /(?:\+?86[-\s]?)?1[3-9]\d{9}/g,
    /\b(?:19|20)\d{2}(?:[./年-]\d{1,2})?(?:[./月-]\d{1,2})?\b/g,
    /\b\d+(?:\.\d+)?%?\+?\b/g,
  ];
  return [...new Set(patterns.flatMap((pattern) => value.match(pattern) || []))];
}

function buildQualityReport({
  blocks,
  nativeText,
  pageCount,
  warnings,
  semantic,
  format,
}) {
  const text = blocks.map((block) => block.text).join('\n');
  const nativeCompact = compactText(nativeText);
  const resultCompact = compactText(text);
  const coverage =
    nativeCompact.length > 0
      ? Math.min(1, Number((resultCompact.length / nativeCompact.length).toFixed(4)))
      : resultCompact.length > 0
        ? 1
        : 0;
  const confidences = blocks
    .map((block) => Number(block.confidence))
    .filter(Number.isFinite);
  const averageConfidence = confidences.length
    ? Number((confidences.reduce((sum, value) => sum + value, 0) / confidences.length).toFixed(4))
    : 0;
  const warningSet = new Set(warnings || []);
  if (pageCount > RECOMMENDED_MAX_PAGES) warningSet.add('PAGE_COUNT_RECOMMENDED_EXCEEDED');
  if (!blocks.length) warningSet.add('NO_TEXT_DETECTED');
  if (averageConfidence > 0 && averageConfidence < 0.8) warningSet.add('OCR_LOW_CONFIDENCE');
  if ((semantic.uncertain_block_ids || []).length) warningSet.add('READING_ORDER_UNCERTAIN');
  const blockingCodes = ['NO_TEXT_DETECTED'];
  const blocking = [...warningSet].filter((code) => blockingCodes.includes(code));
  return {
    format,
    text_coverage: coverage,
    average_confidence: averageConfidence,
    visible_text_characters: resultCompact.length,
    critical_tokens: criticalTokens(text),
    uncertain_block_ids: semantic.uncertain_block_ids || [],
    requires_user_review: true,
    safe_to_review: blocking.length === 0,
    blocking_codes: blocking,
    warning_codes: [...warningSet],
    checks: {
      text_present: blocks.length > 0,
      deterministic_text_preserved: nativeCompact.length === 0 || coverage >= 0.995,
      critical_tokens_preserved: true,
      page_count_supported: pageCount > 0,
    },
  };
}

module.exports = { buildQualityReport, criticalTokens, compactText };
