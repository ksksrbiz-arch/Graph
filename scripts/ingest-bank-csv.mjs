#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i], process.argv[i + 1]);
}

const file = args.get('--file');
if (!file) {
  console.error('Usage: node scripts/ingest-bank-csv.mjs --file <path> [--api-base http://localhost:3001/api/v1] [--user local]');
  process.exit(1);
}

const apiBase = args.get('--api-base') ?? 'http://localhost:3001/api/v1';
const userId = args.get('--user') ?? 'local';
const csv = await readFile(file, 'utf8');

let res;
try {
  res = await fetch(`${apiBase}/arc/ingest/bank-csv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, csv }),
  });
} catch (error) {
  console.error(`Network error while calling ${apiBase}/arc/ingest/bank-csv: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const text = await res.text();
if (!res.ok) {
  const label = res.status === 401 || res.status === 403
    ? 'Authorization failed'
    : res.status === 404
      ? 'ARC endpoint not found'
      : res.status === 400 || res.status === 413 || res.status === 422
        ? 'Validation failed'
        : 'ARC ingest failed';
  console.error(`${label} (${res.status}): ${text || 'no response body'}`);
  process.exit(1);
}
console.log(text);
