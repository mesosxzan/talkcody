/**
 * Text replacement utilities for smart string matching and replacement
 */

export interface ReplacementResult {
  result: string;
  occurrences: number;
}

export interface SmartMatchResult {
  result: string;
  occurrences: number;
  matchType: 'exact' | 'smart' | 'none';
  correctedOldString?: string;
}

export interface FuzzyMatchResult {
  found: boolean;
  suggestion?: string;
}

/**
 * Performs safe literal string replacement
 */
export function safeLiteralReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false
): ReplacementResult {
  const allOccurrences = content.split(oldString).length - 1;

  if (allOccurrences === 0) {
    return { result: content, occurrences: 0 };
  }

  if (replaceAll) {
    const result = content.split(oldString).join(newString);
    return { result, occurrences: allOccurrences };
  }

  const index = content.indexOf(oldString);
  if (index === -1) {
    return { result: content, occurrences: 0 };
  }

  const result =
    content.substring(0, index) + newString + content.substring(index + oldString.length);

  return { result, occurrences: 1 };
}

/**
 * Normalizes string line endings
 */
export function normalizeString(str: string): string {
  return str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Smart string normalization that handles escaped newlines
 */
export function smartNormalizeString(str: string): string {
  // First apply basic normalization
  let normalized = normalizeString(str);

  // If the string contains literal \n characters (not actual newlines),
  // convert them to actual newlines
  if (normalized.includes('\\n') && !normalized.includes('\n\n')) {
    // Only convert if it seems like these are escaped newlines
    // Check if the ratio of \\n to actual newlines suggests escaped format
    const literalNewlines = (normalized.match(/\\n/g) || []).length;
    const actualNewlines = (normalized.match(/\n/g) || []).length;

    if (literalNewlines > actualNewlines / 2) {
      normalized = normalized.replace(/\\n/g, '\n');
    }
  }

  return normalized;
}

/**
 * Performs fuzzy matching with suggestions
 */
export function fuzzyMatch(content: string, searchText: string): FuzzyMatchResult {
  const normalized = normalizeString(content);
  const normalizedSearch = normalizeString(searchText);

  if (normalized.includes(normalizedSearch)) {
    return { found: true };
  }

  const trimmedSearch = normalizedSearch
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  const trimmedContent = normalized
    .split('\n')
    .map((l) => l.trim())
    .join('\n');

  if (trimmedContent.includes(trimmedSearch)) {
    return {
      found: false,
      suggestion:
        'Text found but with different indentation. Try matching the exact indentation in the file.',
    };
  }

  return { found: false };
}

/**
 * Smart matching algorithm with multiple fallback strategies
 */
export function smartMatch(content: string, searchText: string): SmartMatchResult {
  // Try exact match first
  const exactMatch = safeLiteralReplace(content, searchText, '', false);
  if (exactMatch.occurrences > 0) {
    return { result: content, occurrences: exactMatch.occurrences, matchType: 'exact' };
  }

  // Try smart normalization
  const smartNormalizedContent = smartNormalizeString(content);
  const smartNormalizedSearch = smartNormalizeString(searchText);

  const smartMatchResult = safeLiteralReplace(
    smartNormalizedContent,
    smartNormalizedSearch,
    '',
    false
  );
  if (smartMatchResult.occurrences > 0) {
    return {
      result: smartNormalizedContent,
      occurrences: smartMatchResult.occurrences,
      matchType: 'smart',
      correctedOldString: smartNormalizedSearch,
    };
  }

  // Try trimmed whitespace matching
  const contentLines = content.split('\n');
  const searchLines = searchText.split('\n');

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const candidateLines = contentLines.slice(i, i + searchLines.length);
    const trimmedCandidate = candidateLines.map((l) => l.trim()).join('\n');
    const trimmedSearch = searchLines.map((l) => l.trim()).join('\n');

    if (trimmedCandidate === trimmedSearch) {
      // Found match with different whitespace - extract the exact text from file
      const exactTextFromFile = candidateLines.join('\n');
      return {
        result: content,
        occurrences: 1,
        matchType: 'smart',
        correctedOldString: exactTextFromFile,
      };
    }
  }

  return { result: content, occurrences: 0, matchType: 'none' };
}

/**
 * Normalizes curly quotes to straight quotes for matching purposes
 */
export function normalizeQuotes(str: string): string {
  return str
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'") // Single curly quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"'); // Double curly quotes
}

/**
 * Finds the actual string in content, handling quote normalization.
 * First tries exact match, then tries with quote normalization.
 * Returns the actual string from the content if found via normalization.
 */
export function findActualString(
  content: string,
  searchString: string
): { found: boolean; actualString?: string; normalized: boolean } {
  // Try exact match first
  if (content.includes(searchString)) {
    return { found: true, actualString: searchString, normalized: false };
  }

  // Try with quote normalization
  const normalizedContent = normalizeQuotes(content);
  const normalizedSearch = normalizeQuotes(searchString);

  if (normalizedContent.includes(normalizedSearch)) {
    // Find the position in normalized content
    const index = normalizedContent.indexOf(normalizedSearch);
    // Extract the actual text from the original content at the same position
    const actualString = content.substring(index, index + searchString.length);
    return { found: true, actualString: actualString, normalized: true };
  }

  return { found: false, normalized: false };
}

/**
 * Preserves the quote style from the original text when applying new text.
 * If the original text uses curly quotes, the new text will also use curly quotes.
 */
export function preserveQuoteStyle(originalText: string, newText: string): string {
  let result = newText;

  // Check if original uses curly double quotes
  const hasCurlyDoubleOpen = /[\u201C]/.test(originalText);
  const hasCurlyDoubleClose = /[\u201D]/.test(originalText);
  const hasCurlySingleOpen = /[\u2018]/.test(originalText);
  const hasCurlySingleClose = /[\u2019]/.test(originalText);

  if (hasCurlyDoubleOpen || hasCurlyDoubleClose) {
    // Replace straight double quotes with curly quotes in new text
    let doubleQuoteOpen = true;
    result = result.replace(/"/g, () => {
      const char = doubleQuoteOpen ? '\u201C' : '\u201D';
      doubleQuoteOpen = !doubleQuoteOpen;
      return char;
    });
  }

  if (hasCurlySingleOpen || hasCurlySingleClose) {
    // Replace straight single quotes with curly quotes, but not apostrophes in contractions
    result = result.replace(/(?<=\S)'|'(?=\S)/g, '\u2019'); // Apostrophe (between letters)
    result = result.replace(/'/g, (_match, offset, str) => {
      // If between two letters, it's an apostrophe - already handled above
      const prevChar = str[offset - 1];
      const nextChar = str[offset + 1];
      if (prevChar && nextChar && /\w/.test(prevChar) && /\w/.test(nextChar)) {
        return '\u2019'; // Apostrophe
      }
      return '\u2018'; // Opening single quote
    });
  }

  return result;
}

/**
 * Finds similar text in content for error suggestions
 */
export function findSimilarText(content: string, searchText: string, maxResults = 3): string[] {
  const lines = content.split('\n');
  const searchLines = searchText.split('\n');
  const results: string[] = [];

  const firstLine = searchLines[0];
  if (!firstLine || !firstLine.trim()) return results;

  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    const line = lines[i];
    if (line?.includes(firstLine.trim())) {
      const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join('\n');
      results.push(`Near line ${i + 1}:\n${context}`);
    }
  }

  return results;
}
