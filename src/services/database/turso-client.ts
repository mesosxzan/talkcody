import { getRuntimeApiUrl, isTauriRuntime, tauriInvoke } from '@/lib/runtime-env';
import { simpleFetch } from '@/lib/tauri-fetch';

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowsAffected: number;
  lastInsertId: number;
}

/**
 * Compatibility type for code that expects the old ResultSet interface.
 * Extends QueryResult with array-like row access.
 */
export interface ResultSet extends QueryResult {
  [index: number]: Record<string, unknown>;
}

function toResultSet(result: QueryResult): ResultSet {
  const rs = result as ResultSet;
  for (let i = 0; i < result.rows.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    rs[i] = result.rows[i]!;
  }
  return rs;
}

async function dbPost<T>(path: string, body: unknown): Promise<T> {
  const response = await simpleFetch(getRuntimeApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

/**
 * Database client that works in both Tauri and Web modes.
 * - Tauri: uses invoke('db_query'/'db_execute'/'db_batch')
 * - Web: uses HTTP POST to the Rust server
 */
export class TursoClient {
  private connected = false;

  async initialize(): Promise<void> {
    if (this.connected) return;

    if (isTauriRuntime()) {
      await tauriInvoke('db_connect');
    }
    // Web mode: the server-side database is already initialized at startup.
    // No client-side connect step needed.

    this.connected = true;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ResultSet> {
    const result = await this._rawExecute(sql, params);
    return toResultSet(result);
  }

  async query(sql: string, params: unknown[] = []): Promise<ResultSet> {
    const result = await this._rawQuery(sql, params);
    return toResultSet(result);
  }

  async select<T = Record<string, unknown>[]>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await this._rawQuery(sql, params);
    return result.rows as T;
  }

  async batch(statements: Array<[string, unknown[]]>): Promise<ResultSet[]> {
    this.ensureInitialized();

    if (isTauriRuntime()) {
      const results = await tauriInvoke<QueryResult[]>('db_batch', { statements });
      return results.map(toResultSet);
    }

    const results = await dbPost<QueryResult[]>('/api/db/batch', { statements });
    return results.map(toResultSet);
  }

  private async _rawExecute(sql: string, params: unknown[]): Promise<QueryResult> {
    this.ensureInitialized();
    if (isTauriRuntime()) {
      return tauriInvoke<QueryResult>('db_execute', { sql, params });
    }
    return dbPost<QueryResult>('/api/db/execute', { sql, params });
  }

  private async _rawQuery(sql: string, params: unknown[]): Promise<QueryResult> {
    this.ensureInitialized();
    if (isTauriRuntime()) {
      return tauriInvoke<QueryResult>('db_query', { sql, params });
    }
    return dbPost<QueryResult>('/api/db/query', { sql, params });
  }

  private ensureInitialized(): void {
    if (!this.connected) {
      throw new Error('Database not initialized');
    }
  }
}

let sharedClient: TursoClient | null = null;

export async function loadDatabase(): Promise<TursoClient> {
  if (!sharedClient) {
    sharedClient = new TursoClient();
    await sharedClient.initialize();
  }
  return sharedClient;
}
