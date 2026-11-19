import { describe, expect, it } from 'vitest';
import { epochFromMessageId, parseHumanDateTime, parseIsoTimestamp, resolveDateOrder } from '../../src/shared/time';

// Wednesday, 17 January 2024, 12:00 local time.
const reference = new Date(2024, 0, 17, 12, 0, 0).getTime();
const mdy = { referenceMs: reference, dateOrder: 'MDY' as const };
const dmy = { referenceMs: reference, dateOrder: 'DMY' as const };
const local = (...args: [number, number, number, number?, number?, number?]) =>
  new Date(args[0], args[1], args[2], args[3] ?? 0, args[4] ?? 0, args[5] ?? 0).getTime();

describe('ISO and message-id timestamps', () => {
  it('parses ISO datetime attributes', () => {
    expect(parseIsoTimestamp('2024-01-15T10:30:12.345Z')).toBe(Date.UTC(2024, 0, 15, 10, 30, 12, 345));
    expect(parseIsoTimestamp('2024-01-15 10:30:00Z')).toBe(Date.UTC(2024, 0, 15, 10, 30));
    expect(parseIsoTimestamp('Monday')).toBeNull();
    expect(parseIsoTimestamp('')).toBeNull();
  });

  it('derives the arrival time from a Teams message id', () => {
    expect(epochFromMessageId('1705314612345')).toBe(1705314612345);
    expect(epochFromMessageId('12345')).toBeNull();
    expect(epochFromMessageId('9999999999999')).toBeNull(); // far future
    expect(epochFromMessageId('abc')).toBeNull();
    expect(epochFromMessageId(null)).toBeNull();
  });
});

describe('human-readable timestamps (fallback)', () => {
  it('parses full English labels', () => {
    expect(parseHumanDateTime('Monday, January 15, 2024 at 10:30 AM', mdy)).toBe(local(2024, 0, 15, 10, 30));
    expect(parseHumanDateTime('15 January 2024 14:05', mdy)).toBe(local(2024, 0, 15, 14, 5));
    expect(parseHumanDateTime('Jan 15, 2024, 9:05:07 PM', mdy)).toBe(local(2024, 0, 15, 21, 5, 7));
  });

  it('parses numeric dates using the configured order', () => {
    expect(parseHumanDateTime('1/15/2024, 10:30:45 AM', mdy)).toBe(local(2024, 0, 15, 10, 30, 45));
    expect(parseHumanDateTime('15.01.2024 10:30', dmy)).toBe(local(2024, 0, 15, 10, 30));
    expect(parseHumanDateTime('15/01/2024 10:30', mdy)).toBeNull(); // month 15 does not exist
    expect(parseHumanDateTime('2024-01-15 10:30', mdy)).toBe(local(2024, 0, 15, 10, 30));
  });

  it('resolves relative day labels against the reference date', () => {
    expect(parseHumanDateTime('Yesterday 3:15 PM', mdy)).toBe(local(2024, 0, 16, 15, 15));
    expect(parseHumanDateTime('Today 09:00', mdy)).toBe(local(2024, 0, 17, 9, 0));
    expect(parseHumanDateTime('Monday 10:00 AM', mdy)).toBe(local(2024, 0, 15, 10, 0));
  });

  it('combines a bare time with the nearest date divider', () => {
    expect(parseHumanDateTime('10:30 AM', { ...mdy, contextDate: 'January 12' })).toBe(local(2024, 0, 12, 10, 30));
    expect(parseHumanDateTime('10:30', { ...mdy, contextDate: 'Yesterday' })).toBe(local(2024, 0, 16, 10, 30));
  });

  it('infers the previous year for dates that would otherwise lie in the future', () => {
    expect(parseHumanDateTime('December 30 10:00', mdy)).toBe(local(2023, 11, 30, 10, 0));
  });

  it('returns null rather than guessing', () => {
    expect(parseHumanDateTime('Last week', mdy)).toBeNull();
    expect(parseHumanDateTime('January 15', mdy)).toBeNull(); // no time of day
    expect(parseHumanDateTime('10:30', mdy)).toBeNull(); // time without any date context
    expect(parseHumanDateTime('25:99', mdy)).toBeNull();
    expect(parseHumanDateTime(null, mdy)).toBeNull();
  });

  it('detects the numeric date order of a locale', () => {
    expect(resolveDateOrder('auto', 'en-US')).toBe('MDY');
    expect(resolveDateOrder('auto', 'de-DE')).toBe('DMY');
    expect(resolveDateOrder('auto', 'ja-JP')).toBe('YMD');
    expect(resolveDateOrder('DMY', 'en-US')).toBe('DMY');
  });
});
