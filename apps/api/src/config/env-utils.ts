export function splitCsvEnv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
