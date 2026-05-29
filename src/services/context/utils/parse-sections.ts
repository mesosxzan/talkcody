import { logger } from '@/lib/logger';
import type { CompressionSection } from '@/types/agent';

/**
 * @internal Parses structured sections from an AI-generated compressed summary.
 * Supports `<analysis>` blocks and various numbered section formats.
 */
export function parseSections(compressedSummary: string): CompressionSection[] {
  const sections: CompressionSection[] = [];

  try {
    // Try to extract analysis section first
    const analysisMatch = compressedSummary.match(/<analysis>([\s\S]*?)<\/analysis>/);
    if (analysisMatch?.[1]) {
      sections.push({
        title: 'Analysis',
        content: analysisMatch[1].trim(),
      });
    }

    // Extract numbered sections with more robust pattern matching
    // Support various formats: "1. Title:", "1) Title:", "1 - Title:", etc.
    const sectionPatterns = [
      /(\d+)\.\s+([^:\n]+):([\s\S]*?)(?=\n\d+\.|$)/g, // "1. Title: content"
      /(\d+)\)\s+([^:\n]+):([\s\S]*?)(?=\n\d+\)|$)/g, // "1) Title: content"
      /(\d+)\s+-\s+([^:\n]+):([\s\S]*?)(?=\n\d+\s+-|$)/g, // "1 - Title: content"
      /(\d+)\.\s+([^\n]+)\n([\s\S]*?)(?=\n\d+\.|$)/g, // "1. Title\ncontent"
    ];

    let matched = false;
    for (const pattern of sectionPatterns) {
      pattern.lastIndex = 0; // Reset regex state
      const matches = [...compressedSummary.matchAll(pattern)];

      if (matches.length > 0) {
        for (const match of matches) {
          const sectionNumber = match[1];
          const title = match[2];
          const content = match[3];
          if (!sectionNumber || !title) continue;

          sections.push({
            title: `${sectionNumber}. ${title.trim()}`,
            content: (content || '').trim() || 'No content provided',
          });
        }
        matched = true;
        break; // Use first pattern that matches
      }
    }

    // Fallback: if no structured sections found, treat entire summary as one section
    if (!matched && compressedSummary.trim()) {
      logger.warn('Could not parse structured sections, using full summary');
      sections.push({
        title: 'Summary',
        content: compressedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '').trim(),
      });
    }
  } catch (error) {
    logger.error('Error parsing compression sections', error);
    // Return the full summary as a fallback
    sections.push({
      title: 'Summary',
      content: compressedSummary,
    });
  }

  return sections;
}
