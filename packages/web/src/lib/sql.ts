/** Quotes an identifier for the engine when it needs quoting. */
export function quoteIdent(name: string, engine: 'postgresql' | 'mysql'): string {
  if (engine === 'mysql')
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function selectSql(engine: 'postgresql' | 'mysql', schema: string, name: string, limit = 100): string {
  return `SELECT *\nFROM ${quoteIdent(schema, engine)}.${quoteIdent(name, engine)}\nLIMIT ${limit};`;
}
