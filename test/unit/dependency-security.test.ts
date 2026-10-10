import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Exercise the transitive copy used by Tailwind's glob handling.
const require = createRequire(import.meta.url);
const tailwindRequire = createRequire(require.resolve('tailwindcss/package.json'));
const micromatchRequire = createRequire(tailwindRequire.resolve('micromatch'));
const braces = micromatchRequire('braces');

describe('brace pattern nesting limit', () => {
  const patterns = [
    '{'.repeat(1024) + 'a,b' + '}'.repeat(1024),
    '('.repeat(1024) + 'a' + ')'.repeat(1024),
    '{('.repeat(1024) + 'a,b' + ')}'.repeat(1024),
    '{'.repeat(1024) + 'a,b',
  ];

  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    it(`${method} rejects excessive AST depth before recursive traversal`, () => {
      for (const pattern of patterns) {
        expect(() => braces[method](pattern)).toThrow(SyntaxError);
        expect(() => braces[method](pattern)).toThrow('maximum nesting depth');
      }
    });
  }

  it('preserves normal nested patterns, ranges, escapes and literal brackets', () => {
    expect(braces.expand('src/{app,{services,domain}}/*.{ts,tsx}')).toEqual([
      'src/app/*.ts', 'src/app/*.tsx', 'src/services/*.ts',
      'src/services/*.tsx', 'src/domain/*.ts', 'src/domain/*.tsx',
    ]);
    expect(braces.expand('file-{1..3}')).toEqual(['file-1', 'file-2', 'file-3']);
    expect(braces.stringify('\\{literal\\}')).toBe('{literal}');
    expect(braces.stringify('[' + '{'.repeat(1024) + ']')).toBe('[' + '{'.repeat(1024) + ']');
  });
});
