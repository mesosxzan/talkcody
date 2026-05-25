// Unified search result interface
export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchOptions {
  domains?: string[];
  /** Time range for search results - improves freshness of results */
  freshness?: 'hour' | 'day' | 'week' | 'month' | 'year';
}

export interface WebSearchSource {
  search(query: string): Promise<WebSearchResult[]>;
}
