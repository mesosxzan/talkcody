import { logger } from '@/lib/logger';
import { getEffectiveWebSearchProxy, toTauriProxyFormat } from '@/lib/proxy-detector';
import { simpleFetch } from '@/lib/tauri-fetch';
import { settingsManager } from '@/stores/settings-store';
import type { SearchOptions, WebSearchResult, WebSearchSource } from './types';

/**
 * DuckDuckGo Instant Answer API
 * Free, no API key required, privacy-focused
 * API endpoint: https://api.duckduckgo.com/
 */
const DUCKDUCKGO_API = 'https://api.duckduckgo.com/';

interface DuckDuckGoResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
    Icon?: {
      URL?: string;
    };
  }>;
  Results?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
  }>;
}

/**
 * DuckDuckGo HTML Search (fallback for more comprehensive results)
 * Parses HTML search results from DuckDuckGo
 */
async function searchDuckDuckGoHTML(query: string, freshness?: string): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];

  // Build search URL with time filter
  const params = new URLSearchParams({
    q: query,
    // DuckDuckGo time filters: d=day, w=week, m=month
    df: freshness === 'day' ? 'd' : freshness === 'week' ? 'w' : freshness === 'month' ? 'm' : '',
  });

  const searchUrl = `https://html.duckduckgo.com/html/?${params.toString()}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await simpleFetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`DuckDuckGo HTML search failed: ${response.status}`);
    }

    const html = await response.text();

    // Parse HTML results
    // DuckDuckGo HTML format: <a class="result__a" href="...">Title</a>
    // <a class="result__url" href="...">URL</a>
    // <a class="result__snippet">...</a>

    const resultRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/i;
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
    const urlRegex = /<a[^>]*class="result__url"[^>]*>([^<]*)<\/a>/i;

    let match: RegExpExecArray | null;
    while ((match = resultRegex.exec(html)) !== null && results.length < 10) {
      const block = match[1];

      const linkMatch = block?.match(linkRegex);
      const snippetMatch = block?.match(snippetRegex);
      const urlMatch = block?.match(urlRegex);

      if (linkMatch) {
        // DuckDuckGo uses redirect URLs, extract actual URL
        let url: string = linkMatch[1] || '';
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch?.[1]) {
          url = decodeURIComponent(uddgMatch[1]);
        }

        const title = linkMatch[2]?.trim() || '';
        const snippet = snippetMatch?.[1]?.replace(/<[^>]*>/g, '').trim() || '';
        const displayUrl = urlMatch?.[1]?.trim() || '';

        // Skip if no valid URL or title
        if (!url || !title || url.startsWith('javascript:')) {
          continue;
        }

        results.push({
          title,
          url,
          content: snippet || `Source: ${displayUrl}`,
        });
      }
    }

    logger.info(`[DuckDuckGo HTML] Parsed ${results.length} results`);
    return results;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('DuckDuckGo HTML search timed out');
    }
    throw error;
  }
}

/**
 * DuckDuckGo Instant Answer API (for quick facts)
 */
async function searchDuckDuckGoInstant(query: string): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  });

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await simpleFetch(`${DUCKDUCKGO_API}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`DuckDuckGo Instant API failed: ${response.status}`);
    }

    const data: DuckDuckGoResponse = await response.json();

    // Add abstract if available
    if (data.Abstract && data.AbstractURL) {
      results.push({
        title: data.Heading || 'Instant Answer',
        url: data.AbstractURL,
        content: data.Abstract,
      });
    }

    // Add related topics
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.split(' - ')[0] || 'Related Topic',
            url: topic.FirstURL,
            content: topic.Text,
          });
        }
      }
    }

    // Add results
    if (data.Results) {
      for (const result of data.Results.slice(0, 3)) {
        if (result.Text && result.FirstURL) {
          results.push({
            title: result.Text,
            url: result.FirstURL,
            content: '',
          });
        }
      }
    }

    logger.info(`[DuckDuckGo Instant] Got ${results.length} results`);
    return results;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('DuckDuckGo Instant API timed out');
    }
    throw error;
  }
}

export class DuckDuckGoSearch implements WebSearchSource {
  private options: SearchOptions;

  constructor(params?: SearchOptions) {
    this.options = params || {};
  }

  async search(query: string): Promise<WebSearchResult[]> {
    const t0 = performance.now();

    try {
      // Try HTML search first for comprehensive results
      const htmlResults = await searchDuckDuckGoHTML(query, this.options.freshness);

      if (htmlResults.length >= 3) {
        const t1 = performance.now();
        logger.info(
          `[DuckDuckGo] HTML search completed in ${(t1 - t0).toFixed(0)}ms with ${htmlResults.length} results`
        );
        return htmlResults;
      }

      // Fallback to Instant Answer API
      logger.info('[DuckDuckGo] HTML search returned few results, trying Instant API');
      const instantResults = await searchDuckDuckGoInstant(query);

      // Merge results, preferring HTML results
      const merged = [...htmlResults];
      for (const result of instantResults) {
        if (!merged.some((r) => r.url === result.url)) {
          merged.push(result);
        }
      }

      const t1 = performance.now();
      logger.info(
        `[DuckDuckGo] Search completed in ${(t1 - t0).toFixed(0)}ms with ${merged.length} results`
      );

      return merged.slice(0, 10);
    } catch (error) {
      const t1 = performance.now();
      logger.error(`[DuckDuckGo] Search failed after ${(t1 - t0).toFixed(0)}ms:`, error);
      throw error;
    }
  }
}

/**
 * Check if DuckDuckGo search is available (always true - no API key required)
 */
export function isDuckDuckGoAvailable(): boolean {
  return true;
}
