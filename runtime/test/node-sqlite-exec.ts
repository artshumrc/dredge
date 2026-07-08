import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import type { Exec } from "../src/db";

export function makeNodeSqliteExec(db: DatabaseSync): Exec {
  return (sql: string, bind: unknown[] = []) => {
    const statement = db.prepare(sql);
    statement.setReturnArrays(true);
    const rows =
      bind.length > 0 ? statement.all(...(bind as SQLInputValue[])) : statement.all();
    return rows as unknown as unknown[][];
  };
}
