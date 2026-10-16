/**
 * Minimal async SQL surface. expo-sqlite's SQLiteDatabase satisfies it on device;
 * tests use an in-memory sql.js adapter, so repositories and migrations are
 * exercised against real SQLite in Jest.
 */
export type SqlParam = string | number | null;

export interface SqlRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqlParam[]): Promise<SqlRunResult>;
  getAllAsync<T>(sql: string, params: SqlParam[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: SqlParam[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}
