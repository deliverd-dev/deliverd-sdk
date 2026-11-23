// Connecting to a database, and asking it what it holds.
//
// The runtime has no dependencies of its own. To use a database, install its
// driver beside the runtime: `npm install pg` for PostgreSQL (and Azure
// Database for PostgreSQL), `npm install mssql` for SQL Server and Azure SQL.
// The connection string comes from the environment, never from the tools file.
//
// Give the runtime a database login that can do no more than the tools need:
// SELECT on the tables in the model, and UPDATE on the columns its actions
// change. Reads run in a read-only transaction as well, and every statement
// has a time limit.

import { DIALECTS } from "./sql.mjs";

const TIMEOUT_MS = 30_000;

async function driver(name, dialect) {
  try {
    return await import(name);
  } catch {
    throw new Error(`The ${dialect} driver is not installed. Run: npm install ${name}`);
  }
}

/**
 * A database the runtime can use: `readOnly(fn)` and `transaction(fn)` hand
 * `fn` a query function, `(text, values) => { rows, rowCount }`, and commit or
 * roll back around it.
 */
export async function openDatabase(dialect, url, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!DIALECTS.includes(dialect)) throw new Error(`The dialect is one of ${DIALECTS.join(", ")}.`);
  if (!url) throw new Error("There is no connection string. Set the variable the tools file names under database.env.");
  if (dialect === "postgres") {
    const pg = (await driver("pg", "PostgreSQL")).default;
    // bigint and numeric stay text, so no value loses precision on the way to JSON.
    const pool = new pg.Pool({ connectionString: url, max: 5, statement_timeout: timeoutMs, query_timeout: timeoutMs + 1000, application_name: "deliverd-gateway-runtime" });
    const run = async (readOnly, fn) => {
      const client = await pool.connect();
      try {
        await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
        const out = await fn(async (text, values) => {
          const res = await client.query(text, values);
          return { rows: res.rows, rowCount: res.rowCount ?? 0 };
        });
        await client.query(readOnly ? "ROLLBACK" : "COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    return {
      dialect,
      readOnly: (fn) => run(true, fn),
      transaction: (fn) => run(false, fn),
      query: async (text, values = []) => {
        const res = await pool.query(text, values);
        return { rows: res.rows, rowCount: res.rowCount ?? 0 };
      },
      close: () => pool.end(),
    };
  }
  const mssql = (await driver("mssql", "SQL Server")).default;
  // A connection string such as "Server=sql.internal;Database=claims;User Id=…;Password=…;Encrypt=true".
  const pool = await new mssql.ConnectionPool(url).connect();
  const request = (target, values) => {
    const req = new mssql.Request(target);
    req.timeout = timeoutMs;
    for (const [name, value] of Object.entries(values ?? {})) req.input(name, value);
    return req;
  };
  const exec = (target) => async (text, values) => {
    const res = await request(target, values).query(text);
    return { rows: res.recordset ?? [], rowCount: (res.rowsAffected ?? []).reduce((a, b) => a + b, 0) };
  };
  const run = async (fn) => {
    const tx = new mssql.Transaction(pool);
    await tx.begin();
    try {
      const out = await fn(exec(tx));
      await tx.commit();
      return out;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    }
  };
  return {
    dialect,
    // SQL Server has no read-only transaction; the login's own rights are what keep a read a read.
    readOnly: (fn) => fn(exec(pool)),
    transaction: run,
    query: (text, values = {}) => exec(pool)(text, values),
    close: () => pool.close(),
  };
}

const SKIP_SCHEMAS = {
  postgres: ["pg_catalog", "information_schema", "pg_toast"],
  sqlserver: ["sys", "INFORMATION_SCHEMA", "guest"],
};

/** Values a check constraint allows for one column: `status IN ('a','b')`, `status = ANY (ARRAY['a'::text, ...])`, `[status]='a' OR [status]='b'`. */
export function checkValues(definition, column) {
  const def = String(definition ?? "");
  const cols = [...def.matchAll(/["[]?([A-Za-z_][A-Za-z0-9_]*)["\]]?\s*(?:=|\bin\b|::)/gi)].map((m) => m[1].toLowerCase());
  if (!cols.length || cols.some((c) => c !== column.toLowerCase() && !/^(text|varchar|character|any|array)$/i.test(c))) return null;
  if (/[<>]|\bnot\b|\blike\b|\bis\b|\band\b/i.test(def)) return null;
  const values = [...def.matchAll(/(?<![A-Za-z])N?'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  return values.length >= 2 && values.length <= 30 ? [...new Set(values)] : null;
}

/** What the database holds, as `learnModel` (sql.mjs) reads it. */
export async function introspect(db, { schemas = [] } = {}) {
  return db.dialect === "postgres" ? introspectPostgres(db, schemas) : introspectSqlServer(db, schemas);
}

function assemble(dialect, columns, constraints, indexed, rows) {
  const tables = new Map();
  const t = (schema, name) => {
    const k = `${schema}.${name}`;
    if (!tables.has(k)) tables.set(k, { schema, name, columns: [], primaryKey: [], foreignKeys: [], indexed: [], ...(rows.has(k) ? { rows: rows.get(k) } : {}) });
    return tables.get(k);
  };
  for (const c of columns) t(c.schema, c.table).columns.push({ name: c.name, type: c.type, nullable: !!c.nullable, ...(c.enum ? { enum: c.enum } : {}) });
  for (const k of constraints) {
    if (!tables.has(`${k.schema}.${k.table}`)) continue;
    const table = t(k.schema, k.table);
    if (k.type === "p") table.primaryKey = k.columns;
    else if (k.type === "f" && k.refTable) table.foreignKeys.push({ columns: k.columns, refSchema: k.refSchema, refTable: k.refTable, refColumns: k.refColumns });
    else if (k.type === "c" && k.columns.length === 1) {
      const col = table.columns.find((c) => c.name === k.columns[0]);
      const values = col && checkValues(k.definition, col.name);
      if (col && values && !col.enum) col.enum = values;
    }
  }
  for (const i of indexed) if (tables.has(`${i.schema}.${i.table}`)) t(i.schema, i.table).indexed.push(i.column);
  return { dialect, tables: [...tables.values()] };
}

async function introspectPostgres(db, schemas) {
  const only = schemas.length ? schemas : null;
  const skip = SKIP_SCHEMAS.postgres;
  const inScope = `n.nspname <> ALL($1::text[]) AND ($2::text[] IS NULL OR n.nspname = ANY($2::text[]))`;
  const cols = await db.query(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            CASE WHEN t.typtype = 'e' THEN (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) END AS enum
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped AND ${inScope} AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname, a.attnum`,
    [skip, only]
  );
  const cons = await db.query(
    `SELECT n.nspname AS schema, c.relname AS table, k.contype AS type,
            (SELECT array_agg(a.attname::text ORDER BY x.o) FROM unnest(k.conkey) WITH ORDINALITY x(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.n) AS columns,
            fn.nspname AS "refSchema", fc.relname AS "refTable",
            (SELECT array_agg(a.attname::text ORDER BY x.o) FROM unnest(k.confkey) WITH ORDINALITY x(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.n) AS "refColumns",
            pg_get_constraintdef(k.oid) AS definition
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_class fc ON fc.oid = k.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE k.contype IN ('p', 'f', 'c') AND ${inScope}`,
    [skip, only]
  );
  const idx = await db.query(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      WHERE ${inScope}`,
    [skip, only]
  );
  const est = await db.query(`SELECT n.nspname AS schema, c.relname AS table, c.reltuples::bigint AS rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND ${inScope}`, [skip, only]);
  const rows = new Map(est.rows.filter((r) => Number(r.rows) >= 0).map((r) => [`${r.schema}.${r.table}`, Number(r.rows)]));
  return assemble("postgres", cols.rows, cons.rows, idx.rows, rows);
}

async function introspectSqlServer(db, schemas) {
  const filter = (alias) => `${alias} NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')${schemas.length ? ` AND ${alias} IN (${schemas.map((_, i) => `@s${i}`).join(", ")})` : ""}`;
  const params = Object.fromEntries(schemas.map((s, i) => [`s${i}`, s]));
  const cols = await db.query(
    `SELECT c.TABLE_SCHEMA AS [schema], c.TABLE_NAME AS [table], c.COLUMN_NAME AS name, c.DATA_TYPE AS type, CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END AS nullable
       FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE ${filter("c.TABLE_SCHEMA")} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`,
    params
  );
  const pk = await db.query(
    `SELECT s.name AS [schema], t.name AS [table], c.name AS col, ic.key_ordinal AS o
       FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE i.is_primary_key = 1 AND ${filter("s.name")}`,
    params
  );
  const fk = await db.query(
    `SELECT f.name AS fk, s.name AS [schema], t.name AS [table], pc.name AS col, rs.name AS refSchema, rt.name AS refTable, rc.name AS refCol, fc.constraint_column_id AS o
       FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
       JOIN sys.tables t ON t.object_id = f.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
      WHERE ${filter("s.name")}`,
    params
  );
  const ck = await db.query(
    `SELECT s.name AS [schema], t.name AS [table], c.name AS col, k.definition
       FROM sys.check_constraints k JOIN sys.tables t ON t.object_id = k.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id
      WHERE k.parent_column_id > 0 AND ${filter("s.name")}`,
    params
  );
  const idx = await db.query(
    `SELECT s.name AS [schema], t.name AS [table], c.name AS [column]
       FROM sys.index_columns ic JOIN sys.tables t ON t.object_id = ic.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE ic.key_ordinal = 1 AND ${filter("s.name")}`,
    params
  );
  const est = await db.query(
    `SELECT s.name AS [schema], t.name AS [table], SUM(p.rows) AS [rows] FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE ${filter("s.name")} GROUP BY s.name, t.name`,
    params
  );
  const group = (rows, key) => {
    const out = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return [...out.values()].map((g) => g.sort((a, b) => a.o - b.o));
  };
  const constraints = [
    ...group(pk.rows, (r) => `${r.schema}.${r.table}`).map((g) => ({ schema: g[0].schema, table: g[0].table, type: "p", columns: g.map((r) => r.col) })),
    ...group(fk.rows, (r) => `${r.schema}.${r.fk}`).map((g) => ({ schema: g[0].schema, table: g[0].table, type: "f", columns: g.map((r) => r.col), refSchema: g[0].refSchema, refTable: g[0].refTable, refColumns: g.map((r) => r.refCol) })),
    ...ck.rows.map((r) => ({ schema: r.schema, table: r.table, type: "c", columns: [r.col], definition: r.definition })),
  ];
  const rows = new Map(est.rows.map((r) => [`${r.schema}.${r.table}`, Number(r.rows)]));
  return assemble("sqlserver", cols.rows, constraints, idx.rows, rows);
}
