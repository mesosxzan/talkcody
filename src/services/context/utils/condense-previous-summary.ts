import { logger } from '@/lib/logger';
import { MAX_SUMMARY_LENGTH } from './constants';

/**
 * @internal Condenses a previous summary to avoid unbounded growth.
 * Extracts key sections ("Pending Tasks", "Current Work", "Errors and fixes")
 * and limits total length to MAX_SUMMARY_LENGTH.
 */
export function condensePreviousSummary(summary: string): string {
  if (summary.length <= MAX_SUMMARY_LENGTH) {
    return summary;
  }

  // Try to extract key sections
  const importantSections = ['Pending Tasks', 'Current Work', 'Errors and fixes'];
  let condensed = '';

  for (const section of importantSections) {
    const pattern = new RegExp(`\\d+\\.\\s*${section}[:\\s]([\\s\\S]*?)(?=\\n\\d+\\.|$)`, 'i');
    const match = summary.match(pattern);
    if (match?.[1]) {
      const sectionContent = match[1].trim().slice(0, 500);
      condensed += `${section}: ${sectionContent}\n\n`;
    }
  }

  if (condensed.length > 0) {
    logger.info('Condensed previous summary', {
      originalLength: summary.length,
      condensedLength: condensed.length,
    });
    return condensed;
  }

  // Fallback: truncate with ellipsis
  return `${summary.slice(0, MAX_SUMMARY_LENGTH)}...`;
}
