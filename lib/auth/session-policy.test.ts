import { describe, expect, it } from 'vitest';
import {
  SESSION_INACTIVITY_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  isSessionInactive,
  isSessionMaxAgeExceeded,
} from './session-policy';

describe('session policy', () => {
  const now = Date.parse('2026-08-05T17:30:00Z');

  it('expires sessions at the 14-day maximum age', () => {
    expect(
      isSessionMaxAgeExceeded(
        new Date(now - SESSION_MAX_AGE_MS + 1).toISOString(),
        now,
      ),
    ).toBe(false);
    expect(
      isSessionMaxAgeExceeded(
        new Date(now - SESSION_MAX_AGE_MS).toISOString(),
        now,
      ),
    ).toBe(true);
  });

  it('fails closed for missing or malformed sign-in timestamps', () => {
    expect(isSessionMaxAgeExceeded(null, now)).toBe(true);
    expect(isSessionMaxAgeExceeded('not-a-date', now)).toBe(true);
  });

  it('expires an inactive browser session after 24 hours', () => {
    expect(isSessionInactive(now - SESSION_INACTIVITY_TIMEOUT_MS + 1, now)).toBe(false);
    expect(isSessionInactive(now - SESSION_INACTIVITY_TIMEOUT_MS, now)).toBe(true);
  });

  it('does not expire a session before activity has been recorded', () => {
    expect(isSessionInactive(null, now)).toBe(false);
  });
});
