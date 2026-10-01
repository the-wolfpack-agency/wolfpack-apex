import { ordinalSuffix, ordinal } from '../ordinal-suffix';

describe('ordinalSuffix', () => {
  it('returns "st" for numbers ending in 1, except 11', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(101)).toBe('st');
    expect(ordinalSuffix(-1)).toBe('st');
    expect(ordinalSuffix(-21)).toBe('st');
  });

  it('returns "nd" for numbers ending in 2, except 12', () => {
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(22)).toBe('nd');
    expect(ordinalSuffix(102)).toBe('nd');
    expect(ordinalSuffix(-2)).toBe('nd');
    expect(ordinalSuffix(-22)).toBe('nd');
  });

  it('returns "rd" for numbers ending in 3, except 13', () => {
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(23)).toBe('rd');
    expect(ordinalSuffix(103)).toBe('rd');
    expect(ordinalSuffix(-3)).toBe('rd');
    expect(ordinalSuffix(-23)).toBe('rd');
  });

  it('returns "th" for numbers ending in 4-9, 0, or in the 11-13 range', () => {
    expect(ordinalSuffix(4)).toBe('th');
    expect(ordinalSuffix(5)).toBe('th');
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(0)).toBe('th');
    expect(ordinalSuffix(-11)).toBe('th');
    expect(ordinalSuffix(-12)).toBe('th');
    expect(ordinalSuffix(-13)).toBe('th');
  });

  it('throws an error for invalid inputs', () => {
    expect(() => ordinalSuffix(NaN)).toThrow("Input must be a finite number");
    expect(() => ordinalSuffix(Infinity)).toThrow("Input must be a finite number");
    expect(() => ordinalSuffix(-Infinity)).toThrow("Input must be a finite number");
    expect(() => ordinalSuffix(null as any)).toThrow("Input must be a finite number");
    expect(() => ordinalSuffix('1' as any)).toThrow("Input must be a finite number");
  });
});

describe('ordinal', () => {
  it('returns the number followed by its ordinal suffix', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(23)).toBe('23rd');
    expect(ordinal(111)).toBe('111th');
    expect(ordinal(112)).toBe('112th');
    expect(ordinal(113)).toBe('113th');
    expect(ordinal(0)).toBe('0th');
    expect(ordinal(-1)).toBe('-1st');
    expect(ordinal(-2)).toBe('-2nd');
    expect(ordinal(-3)).toBe('-3rd');
    expect(ordinal(-4)).toBe('-4th');
  });

  it('throws an error for invalid inputs', () => {
    expect(() => ordinal(NaN)).toThrow("Input must be a finite number");
    expect(() => ordinal(Infinity)).toThrow("Input must be a finite number");
    expect(() => ordinal(-Infinity)).toThrow("Input must be a finite number");
    expect(() => ordinal(null as any)).toThrow("Input must be a finite number");
    expect(() => ordinal('1' as any)).toThrow("Input must be a finite number");
  });
});