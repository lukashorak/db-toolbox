/** Integer or plain decimal text, as databases send numeric values: compared digit by digit. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Compares two decimal strings without converting them to floating point, so bigint IDs and
 * high-precision numerics keep their order (9007199254740993 sorts after 9007199254740992).
 */
function compareDecimal(a: string, b: string): number {
  const negative = (s: string) => s.startsWith('-') && /[1-9]/.test(s);
  if (negative(a) !== negative(b)) return negative(a) ? -1 : 1;
  const sign = negative(a) ? -1 : 1;
  const parts = (s: string) => {
    const [whole = '', fraction = ''] = s.replace(/^-/, '').split('.');
    return { whole: whole.replace(/^0+(?=\d)/, ''), fraction: fraction.replace(/0+$/, '') };
  };
  const x = parts(a);
  const y = parts(b);
  if (x.whole.length !== y.whole.length) return sign * (x.whole.length < y.whole.length ? -1 : 1);
  if (x.whole !== y.whole) return sign * (x.whole < y.whole ? -1 : 1);
  if (x.fraction === y.fraction) return 0;
  const width = Math.max(x.fraction.length, y.fraction.length);
  return sign * (x.fraction.padEnd(width, '0') < y.fraction.padEnd(width, '0') ? -1 : 1);
}

/** A cell that sorts as a number: decimal text, or other numeric text such as 1e+20. */
const isNumeric = (v: string) => DECIMAL.test(v) || (v.trim() !== '' && Number.isFinite(Number(v)));

/** Two numeric cells by value: decimal text exactly, other numeric text as floating point. */
function compareNumeric(x: string, y: string): number {
  if (DECIMAL.test(x) && DECIMAL.test(y)) return compareDecimal(x, y);
  return Number(x) - Number(y);
}

/**
 * How to order a column's non-null cells: by value when every one of them is numeric, else all as
 * text. Deciding once per column keeps the order consistent (a column mixing `2`, `10` and `1A`
 * sorts as text throughout).
 */
export function columnComparator(values: readonly string[]): (x: string, y: string) => number {
  return values.every(isNumeric) ? compareNumeric : (x, y) => x.localeCompare(y);
}
