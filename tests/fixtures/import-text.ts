// Synthetic UTF-8 Chinese conversation, no personal data; exact JS string length.
export function importText(length: number): string {
  const headers = Array.from({ length: 50 }, (_, i) => i % 2 ? '对方：' : '我：');
  const body = length - headers.join('\n').length;
  const each = Math.floor(body / headers.length), extra = body % headers.length;
  if (each < 1 || each + (extra ? 1 : 0) > 400) throw new Error('INVALID_TEST_LENGTH');
  return headers.map((header, i) => header + '字'.repeat(each + (i < extra ? 1 : 0))).join('\n');
}
