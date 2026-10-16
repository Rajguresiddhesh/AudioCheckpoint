import * as SQLite from 'expo-sqlite';
import { migrate } from './migrations';
import type { SqlDb } from './sqlDb';

export const DATABASE_NAME = 'audio-checkpoints.db';

/** Open the on-device database (WAL, foreign keys) and bring the schema up to date. */
export async function openAppDatabase(): Promise<SqlDb> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL');
  const adapter: SqlDb = {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: (sql, params) => db.runAsync(sql, params),
    getAllAsync: <T,>(sql: string, params: (string | number | null)[]) => db.getAllAsync<T>(sql, params),
    getFirstAsync: <T,>(sql: string, params: (string | number | null)[]) => db.getFirstAsync<T>(sql, params),
    withTransactionAsync: (task) => db.withTransactionAsync(task),
  };
  await migrate(adapter);
  return adapter;
}
