import initSqlJs, { type Database } from 'sql.js';
import type { SqlDb, SqlParam, SqlRunResult } from '../data/sqlDb';

/** In-memory SQLite (sql.js / WASM) implementing SqlDb for Jest. Test-only. */
export class SqlJsDb implements SqlDb {
  private constructor(private db: Database) {}

  static async create(): Promise<SqlJsDb> {
    const SQL = await initSqlJs();
    return new SqlJsDb(new SQL.Database());
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, params: SqlParam[]): Promise<SqlRunResult> {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    const row = this.db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowId = Number(row[0]?.values[0]?.[0] ?? 0);
    return { changes, lastInsertRowId };
  }

  async getAllAsync<T>(sql: string, params: SqlParam[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }

  async getFirstAsync<T>(sql: string, params: SqlParam[]): Promise<T | null> {
    const all = await this.getAllAsync<T>(sql, params);
    return all[0] ?? null;
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.db.exec('BEGIN');
    try {
      await task();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
