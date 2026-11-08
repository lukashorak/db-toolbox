/**
 * Fixtures for integration tests against the disposable PostgreSQL and MySQL containers started by
 * scripts/integration/start.sh. They drop and recreate the `workbench_it` database on every run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { ConnectionTarget } from '@workbench/core';

export const DATABASE = 'workbench_it';
export const READER = { username: 'wb_reader', password: 'reader-pw' };
/** MySQL: may change data, and holds TRIGGER (sees triggers) on wb_items only. */
export const WRITER = { username: 'wb_writer', password: 'writer-pw' };

export function certs() {
  const dir = process.env.INTEGRATION_CERTS ?? '.integration/certs';
  return {
    ca: readFileSync(join(dir, 'ca.crt'), 'utf8'),
    otherCa: readFileSync(join(dir, 'other-ca.crt'), 'utf8'),
  };
}

/** A target for the container behind `url`, verified against the test CA by default. */
export function targetFrom(
  url: string,
  engine: ConnectionTarget['engine'],
  overrides: Partial<ConnectionTarget> = {},
): ConnectionTarget {
  const u = new URL(url);
  return {
    id: `cn_it_${engine}`,
    name: `Integration ${engine}`,
    engine,
    host: u.hostname,
    port: Number(u.port),
    database: DATABASE,
    schema: engine === 'postgresql' ? 'public' : null,
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    tlsMode: 'verify-full',
    caPem: certs().ca,
    ...overrides,
  };
}

const POSTGRES_FIXTURE = `
CREATE TABLE wb_items (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  price numeric(12,2) CHECK (price >= 0),
  created_at timestamptz NOT NULL DEFAULT '2026-01-02 03:04:05+00',
  payload jsonb,
  raw bytea,
  big bigint,
  tags text[]
);
COMMENT ON TABLE wb_items IS 'Items for tests';
COMMENT ON COLUMN wb_items.name IS 'Display name';
CREATE TABLE wb_orders (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id int NOT NULL REFERENCES wb_items (id),
  qty int NOT NULL DEFAULT 1,
  total numeric GENERATED ALWAYS AS (qty * 2) STORED
);
CREATE INDEX wb_items_lower_name ON wb_items (lower(name), coalesce(price, 0));
CREATE VIEW wb_item_names AS SELECT id, name FROM wb_items;
CREATE MATERIALIZED VIEW wb_item_stats AS SELECT count(*) AS n FROM wb_items;
CREATE FUNCTION wb_item_count() RETURNS bigint LANGUAGE sql STABLE AS 'SELECT count(*) FROM wb_items';
CREATE FUNCTION wb_add(a int, b int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT a + b';
CREATE PROCEDURE wb_proc() LANGUAGE sql AS 'SELECT 1';
CREATE TABLE wb_numbers AS SELECT generate_series(1, 5000) AS n;
INSERT INTO wb_items (name, price, payload, raw, big, tags) VALUES
  ('alpha', 12.50, '{"a": [1, 2]}', '\\x00ff10', 9007199254740993, '{x,"y z"}'),
  ('beta', NULL, NULL, NULL, NULL, NULL);
CREATE SCHEMA restricted;
CREATE TABLE restricted.secret (id int);
REVOKE ALL ON SCHEMA restricted FROM PUBLIC;
GRANT CONNECT ON DATABASE ${DATABASE} TO ${READER.username};
GRANT USAGE ON SCHEMA public TO ${READER.username};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER.username};
`;

export async function preparePostgres(url: string): Promise<void> {
  const admin = new pg.Client({ connectionString: url, ssl: false });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${READER.username}') THEN
        CREATE ROLE ${READER.username} LOGIN PASSWORD '${READER.password}';
      END IF; END $$`);
  } finally {
    await admin.end();
  }
  const u = new URL(url);
  u.pathname = `/${DATABASE}`;
  const db = new pg.Client({ connectionString: u.href, ssl: false });
  await db.connect();
  try {
    await db.query(POSTGRES_FIXTURE);
  } finally {
    await db.end();
  }
}

/**
 * A view graph that branches at every level: wb_g<n> joins two views that both read wb_g<n-1>, so
 * wb_g<levels> reaches wb_g0 along 2^levels paths.
 */
export function branchingViews(levels: number): string {
  const sql = ['CREATE VIEW wb_g0 AS SELECT id FROM wb_items;'];
  for (let n = 1; n <= levels; n++) {
    sql.push(
      `CREATE VIEW wb_g${n}a AS SELECT id FROM wb_g${n - 1};`,
      `CREATE VIEW wb_g${n}b AS SELECT id FROM wb_g${n - 1};`,
      `CREATE VIEW wb_g${n} AS SELECT a.id FROM wb_g${n}a a JOIN wb_g${n}b b ON b.id = a.id;`,
    );
  }
  return sql.join('\n      ');
}

export async function prepareMysql(url: string): Promise<void> {
  const u = new URL(url);
  const root = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    multipleStatements: true,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await root.query(`
      DROP DATABASE IF EXISTS ${DATABASE};
      DROP DATABASE IF EXISTS ${DATABASE}_other;
      CREATE DATABASE ${DATABASE}_other;
      -- Same table name as the main database's InnoDB table, but MyISAM (USE checks).
      CREATE TABLE ${DATABASE}_other.wb_items (id int PRIMARY KEY, name varchar(100)) ENGINE=MyISAM;
      CREATE DATABASE ${DATABASE};
      USE ${DATABASE};
      CREATE TABLE wb_items (
        id int AUTO_INCREMENT PRIMARY KEY,
        name varchar(100) NOT NULL UNIQUE COMMENT 'Display name',
        price decimal(12,2) CHECK (price >= 0),
        created_at datetime(3) NOT NULL DEFAULT '2026-01-02 03:04:05.000',
        payload json,
        raw varbinary(16),
        big bigint,
        flag bit(1)
      ) ENGINE=InnoDB COMMENT='Items for tests';
      CREATE TABLE wb_orders (
        id int AUTO_INCREMENT PRIMARY KEY,
        item_id int NOT NULL,
        qty int NOT NULL DEFAULT 1,
        CONSTRAINT wb_orders_item FOREIGN KEY (item_id) REFERENCES wb_items (id),
        INDEX wb_orders_qty (qty)
      ) ENGINE=InnoDB;
      CREATE TABLE wb_legacy (id int PRIMARY KEY, note text) ENGINE=MyISAM;
      CREATE VIEW wb_item_names AS SELECT id, name FROM wb_items;
      CREATE PROCEDURE wb_proc() BEGIN SELECT 1 AS one; SELECT 2 AS two, 'x' AS label; END;
      -- Returns more rows than a preview keeps, then writes: the write must still happen.
      CREATE PROCEDURE wb_report_then_write() BEGIN
        SELECT n FROM wb_numbers ORDER BY n;
        -- A write that takes a moment, still running when the preview is full: stopping the
        -- procedure then would interrupt it (SLEEP would not do: it ends quietly when interrupted).
        INSERT INTO wb_items (name)
          SELECT CONCAT('proc-after-report-', count(*)) FROM wb_numbers a CROSS JOIN wb_numbers b WHERE b.n <= 1000;
      END;
      -- Commits part of its work, then fails: the failure promises no rollback.
      CREATE PROCEDURE wb_commit_then_fail() BEGIN
        INSERT INTO wb_items (name) VALUES ('proc-committed');
        COMMIT;
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'failed after a commit';
      END;
      -- Writes (committed, per statement), then fails on a missing table at run time.
      CREATE PROCEDURE wb_write_then_missing() BEGIN
        INSERT INTO wb_items (name) VALUES ('proc-before-missing');
        SELECT * FROM wb_no_such_table;
      END;
      -- InnoDB tables whose triggers write elsewhere: to MyISAM (cannot roll back) and to InnoDB.
      CREATE TABLE wb_audit_log (id int) ENGINE=InnoDB;
      CREATE TABLE wb_audited (id int PRIMARY KEY) ENGINE=InnoDB;
      CREATE TRIGGER wb_audited_legacy AFTER INSERT ON wb_audited FOR EACH ROW
        INSERT INTO wb_legacy VALUES (NEW.id + 1000, 'audited');
      CREATE TABLE wb_audited_inno (id int PRIMARY KEY) ENGINE=InnoDB;
      CREATE TRIGGER wb_audited_inno_log AFTER INSERT ON wb_audited_inno FOR EACH ROW
        BEGIN INSERT INTO wb_audit_log VALUES (NEW.id); END;
      -- Only a DELETE trigger writes to MyISAM: inserts cannot fire it.
      CREATE TABLE wb_del_trig (id int PRIMARY KEY) ENGINE=InnoDB;
      CREATE TRIGGER wb_del_trig_legacy AFTER DELETE ON wb_del_trig FOR EACH ROW
        INSERT INTO wb_legacy VALUES (OLD.id + 2000, 'deleted');
      -- An updatable view over a MyISAM table (single-transaction checks).
      CREATE VIEW wb_legacy_notes AS SELECT id, note FROM wb_legacy;
      -- Two branches that share one nested view: not a cycle.
      CREATE VIEW wb_v_base AS SELECT id, name FROM wb_items;
      CREATE VIEW wb_v_left AS SELECT id, name FROM wb_v_base;
      CREATE VIEW wb_v_right AS SELECT id FROM wb_v_base;
      CREATE VIEW wb_v_both AS SELECT l.id, l.name FROM wb_v_left l JOIN wb_v_right r ON r.id = l.id;
      ${branchingViews(5)}
      CREATE FUNCTION wb_item_count() RETURNS int READS SQL DATA RETURN (SELECT count(*) FROM wb_items);
      CREATE TABLE wb_numbers (n int PRIMARY KEY);
      SET SESSION cte_max_recursion_depth = 10000;
      INSERT INTO wb_numbers (n) WITH RECURSIVE s (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 5000) SELECT n FROM s;
      INSERT INTO wb_items (name, price, payload, raw, big, flag) VALUES
        ('alpha', 12.50, '{"a": [1, 2]}', 0x00ff10, 9007199254740993, b'1'),
        ('beta', NULL, NULL, NULL, NULL, NULL);
      DROP USER IF EXISTS '${WRITER.username}'@'%';
      CREATE USER '${WRITER.username}'@'%' IDENTIFIED BY '${WRITER.password}';
      GRANT SELECT, INSERT, UPDATE, DELETE ON ${DATABASE}.* TO '${WRITER.username}'@'%';
      GRANT TRIGGER ON ${DATABASE}.wb_items TO '${WRITER.username}'@'%';
      DROP USER IF EXISTS '${READER.username}'@'%';
      CREATE USER '${READER.username}'@'%' IDENTIFIED BY '${READER.password}';
      GRANT SELECT ON ${DATABASE}.* TO '${READER.username}'@'%';
    `);
  } finally {
    await root.end();
  }
}
