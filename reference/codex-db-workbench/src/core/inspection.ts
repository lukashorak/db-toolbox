import type { Engine } from './types.js';
// Fixed adapter queries. Caller SQL is never executed with monitoring privileges.
export const inspectionSql: Record<Engine, Record<string, string>> = {
  postgres: {
    databases:
      'SELECT datname AS database FROM pg_database WHERE datallowconn ORDER BY datname LIMIT 1000',
    objects:
      "SELECT table_catalog AS database,table_schema AS schema,table_name AS name,table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name LIMIT 1000",
    columns:
      "SELECT table_schema AS schema,table_name AS table,column_name AS name,data_type AS type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name,ordinal_position LIMIT 1000",
    activity:
      'SELECT pid,datname AS database,usename AS username,application_name,client_addr::text AS client,state,EXTRACT(EPOCH FROM (clock_timestamp()-query_start)) AS duration_seconds,wait_event_type,wait_event,LEFT(query,2000) AS query FROM pg_stat_activity WHERE pid<>pg_backend_pid() ORDER BY query_start NULLS LAST LIMIT 1000',
    blocking:
      'SELECT pid,pg_blocking_pids(pid)::text AS blocking_pids,LEFT(query,2000) AS query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 LIMIT 1000',
    statistics:
      'SELECT datname AS database,numbackends,xact_commit,xact_rollback,blks_read,blks_hit,tup_returned,tup_fetched,deadlocks,stats_reset FROM pg_stat_database WHERE datname IS NOT NULL ORDER BY datname LIMIT 1000',
    slow: 'SELECT queryid::text AS id,calls,total_exec_time AS total_ms,mean_exec_time AS mean_ms,max_exec_time AS max_ms,rows,LEFT(query,2000) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 100',
  },
  mysql: {
    databases:
      'SELECT SCHEMA_NAME AS `database` FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 1000',
    objects:
      "SELECT TABLE_SCHEMA AS `database`,TABLE_SCHEMA AS `schema`,TABLE_NAME AS name,TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('mysql','sys','performance_schema','information_schema') ORDER BY TABLE_SCHEMA,TABLE_NAME LIMIT 1000",
    columns:
      "SELECT TABLE_SCHEMA AS `schema`,TABLE_NAME AS `table`,COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default,ORDINAL_POSITION AS ordinal_position FROM information_schema.COLUMNS WHERE TABLE_SCHEMA NOT IN ('mysql','sys','performance_schema','information_schema') ORDER BY TABLE_SCHEMA,TABLE_NAME,ORDINAL_POSITION LIMIT 1000",
    activity:
      'SELECT ID AS id,USER AS username,HOST AS client,DB AS `database`,COMMAND AS command,TIME AS duration_seconds,STATE AS state,LEFT(INFO,2000) AS query FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() ORDER BY TIME DESC LIMIT 1000',
    blocking:
      'SELECT REQUESTING_ENGINE_TRANSACTION_ID AS waiting_transaction,BLOCKING_ENGINE_TRANSACTION_ID AS blocking_transaction,REQUESTING_THREAD_ID AS waiting_thread,BLOCKING_THREAD_ID AS blocking_thread FROM performance_schema.data_lock_waits LIMIT 1000',
    statistics:
      "SELECT VARIABLE_NAME AS name,VARIABLE_VALUE AS value FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Threads_connected','Threads_running','Connections','Questions','Slow_queries','Uptime','Aborted_connects','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests') LIMIT 1000",
    slow: 'SELECT SCHEMA_NAME AS `database`,DIGEST AS id,COUNT_STAR AS calls,SUM_TIMER_WAIT/1000000000 AS total_ms,AVG_TIMER_WAIT/1000000000 AS mean_ms,MAX_TIMER_WAIT/1000000000 AS max_ms,LEFT(DIGEST_TEXT,2000) AS query FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT 100',
  },
};
