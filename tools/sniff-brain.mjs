#!/usr/bin/env node
/**
 * sniff-brain — taps the live /brain Socket.IO namespace for SECONDS seconds
 * and reports spike count, weight-change count, region histogram, and a
 * sample of spike events. Useful for verifying a Brain deployment from the
 * command line without spinning up the web client.
 *
 * Usage:
 *   npm run sniff:brain
 *   HOST=http://localhost:3001 USER_ID=<uuid> SECONDS=8 npm run sniff:brain
 */
import { io } from 'socket.io-client';

const HOST = process.env.HOST || 'http://localhost:3001';
const USER = process.env.USER_ID || '00000000-0000-4000-8000-000000000001';
const SECONDS = Number(process.env.SECONDS || 4);

const s = io(`${HOST}/brain`, {
  query: { userId: USER },
  transports: ['websocket'],
  reconnection: false,
});

let spikes = 0;
let weights = 0;
let ticks = 0;
const regions = {};
const sample = [];

s.on('connect', () => {
  console.log(`connected ${s.id}  · namespace=/brain  user=${USER}  window=${SECONDS}s`);
});
s.on('spike', (e) => {
  spikes++;
  regions[e.region] = (regions[e.region] || 0) + 1;
  if (sample.length < 5) {
    sample.push(`spike ${String(e.region).padEnd(11)} ${String(e.neuronId).slice(0, 18)} → ${(e.outgoing || []).length} outgoing`);
  }
});
s.on('weight-change', () => { weights++; });
s.on('tick', () => { ticks++; });
s.on('connect_error', (e) => {
  console.error('connect_error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log(`\nover ${SECONDS}s: ${spikes} spikes · ${weights} weight changes · ${ticks} tick events`);
  for (const ln of sample) console.log(' ', ln);
  console.log('regions:', regions);
  process.exit(0);
}, SECONDS * 1000);
