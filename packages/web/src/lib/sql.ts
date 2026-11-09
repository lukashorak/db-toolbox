/**
 * Quotes an identifier for the engine, always: a plain-looking name can still be a reserved word
 * (`order`, `user`), and quoting keeps PostgreSQL's case exactly as the catalog reports it.
 */
export function quoteIdent(name: string, engine: 'postgresql' | 'mysql'): string {
  if (engine === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

export function selectSql(engine: 'postgresql' | 'mysql', schema: string, name: string, limit = 100): string {
  return `SELECT *\nFROM ${quoteIdent(schema, engine)}.${quoteIdent(name, engine)}\nLIMIT ${limit};`;
}
