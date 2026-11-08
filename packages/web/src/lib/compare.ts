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

/**
 * Order of two non-null cells for sorting results: numbers by value (decimal text exactly, other
 * numeric text such as 1e+20 as floating point), everything else as text.
 */
export function compareCells(x: string, y: string): number {
  if (DECIMAL.test(x) && DECIMAL.test(y)) return compareDecimal(x, y);
  const nx = Number(x);
  const ny = Number(y);
  if (x.trim() !== '' && y.trim() !== '' && Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
  return x.localeCompare(y);
}
