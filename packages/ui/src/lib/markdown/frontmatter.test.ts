import { describe, expect, test } from 'vitest';
import { stripLeadingFrontmatter } from './frontmatter';

describe('stripLeadingFrontmatter', () => {
  test('strips YAML frontmatter delimited by ---', () => {
    const input = '---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n\n# Body\n\nContent.';
    expect(stripLeadingFrontmatter(input)).toBe('\n# Body\n\nContent.');
  });

  test('strips YAML frontmatter closed by ... and tolerates BOM + leading blank lines', () => {
    const input = '\uFEFF\n  \n---\ntitle: Demo\nauthor: Yee\n...\n\n正文开始。';
    expect(stripLeadingFrontmatter(input)).toBe('\n正文开始。');
  });

  test('strips TOML frontmatter delimited by +++', () => {
    const input = '+++\ntitle = "Hello"\ndraft = false\n+++\n\nParagraph.';
    expect(stripLeadingFrontmatter(input)).toBe('\nParagraph.');
  });

  test('preserves normal horizontal rules without metadata entries', () => {
    const input = '---\n\nFirst paragraph.\n\n---\n\nSecond paragraph.';
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });

  test('preserves documents without frontmatter', () => {
    const input = '# Heading\n\n---\n\ntitle: not frontmatter\n---';
    expect(stripLeadingFrontmatter(input)).toBe(input);
  });
});
