export function ordinalSuffix(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error("Input must be a finite number");
  }

  const absValue = Math.abs(n);
  const lastTwoDigits = absValue % 100;
  const lastDigit = absValue % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return 'th';
  }

  switch (lastDigit) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function ordinal(n: number): string {
  return `${n}${ordinalSuffix(n)}`;
}