import { describe, it, expect } from 'vitest';
import { parseDuration, formatDuration, DEFAULT_TIME_CONFIG } from '../../src/lib/duration.js';

const cfg = DEFAULT_TIME_CONFIG; // 8h/day, 5d/week, pretty

describe('parseDuration', () => {
  it('parses single units', () => {
    expect(parseDuration('30m', cfg)).toBe(1800);
    expect(parseDuration('2h', cfg)).toBe(7200);
    expect(parseDuration('1d', cfg)).toBe(8 * 3600);
    expect(parseDuration('2w', cfg)).toBe(2 * 5 * 8 * 3600);
  });
  it('parses compound + glued strings', () => {
    expect(parseDuration('1w 2d 3h 30m', cfg)).toBe(5 * 8 * 3600 + 2 * 8 * 3600 + 3 * 3600 + 1800);
    expect(parseDuration('2h30m', cfg)).toBe(9000);
    expect(parseDuration(' 1d ', cfg)).toBe(28800);
  });
  it('rejects garbage and partial parses', () => {
    expect(parseDuration('', cfg)).toBeNull();
    expect(parseDuration('abc', cfg)).toBeNull();
    expect(parseDuration('1h foo', cfg)).toBeNull();
    expect(parseDuration('h', cfg)).toBeNull();
    expect(parseDuration('2', cfg)).toBeNull();
  });
  it('honours workday assumptions', () => {
    const sixHour = { ...cfg, hoursPerDay: 6 };
    expect(parseDuration('1d', sixHour)).toBe(6 * 3600);
    const fourDay = { ...cfg, daysPerWeek: 4 };
    expect(parseDuration('1w', fourDay)).toBe(4 * 8 * 3600);
  });
});

describe('formatDuration', () => {
  it('round-trips pretty', () => {
    expect(formatDuration(7200, cfg)).toBe('2h');
    expect(formatDuration(57600, cfg)).toBe('2d');
    expect(formatDuration(5 * 8 * 3600 + 2 * 8 * 3600 + 3 * 3600 + 1800, cfg)).toBe('1w 2d 3h 30m');
    expect(formatDuration(0, cfg)).toBe('0m');
  });
  it('null → undefined', () => {
    expect(formatDuration(null, cfg)).toBeUndefined();
    expect(formatDuration(undefined, cfg)).toBeUndefined();
  });
  it('hours format', () => {
    const hours = { ...cfg, format: 'hours' as const };
    expect(formatDuration(90000, hours)).toBe('25h');
    expect(formatDuration(91800, hours)).toBe('25.5h');
  });
});
