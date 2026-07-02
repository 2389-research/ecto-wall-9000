// ABOUTME: Unit tests for the overlay clock's pure formatting — locale-aware time and
// ABOUTME: date lines, with explicit locales injected so assertions are deterministic.
import { describe, expect, it } from 'vitest';
import { formatDate, formatTime } from '../../js/clock.js';

const AFTERNOON = new Date(2026, 6, 2, 15, 7); // July 2 2026, 15:07 local

describe('formatTime', () => {
  it('formats 12-hour locales as hour:minute with a day period', () => {
    // \s covers the narrow no-break space newer ICU puts before AM/PM
    expect(formatTime(AFTERNOON, 'en-US')).toMatch(/^3:07\sPM$/);
  });

  it('formats 24-hour locales without a day period', () => {
    expect(formatTime(AFTERNOON, 'de-DE')).toBe('15:07');
  });

  it('pads minutes but not hours', () => {
    expect(formatTime(new Date(2026, 6, 2, 9, 5), 'en-US')).toMatch(/^9:05\sAM$/);
  });
});

describe('formatDate', () => {
  it('spells out weekday, month, and day', () => {
    expect(formatDate(AFTERNOON, 'en-US')).toMatch(/^[A-Z][a-z]+day, July 2$/);
  });

  it('follows locale ordering', () => {
    expect(formatDate(AFTERNOON, 'de-DE')).toContain('Juli');
  });
});
