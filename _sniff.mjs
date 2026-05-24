import { io } from 'socket.io-client';

const BRAIN = 'https://pkg-brain-9909.fly.dev/brain';
console.log('connecting to', BRAIN, 'userId=local');

const sock = io(BRAIN, {
  query: { userId: 'local' },
  transports: ['websocket', 'polling'],
  timeout: 10000,
});

let spikes = 0, weights = 0, insights = 0, dreams = 0, pathways = 0;
const samples = [];

sock.on('connect', () => console.log('CONNECTED', sock.id));
sock.on('connect_error', (e) => console.log('connect_error:', e.message));
sock.on('disconnect', (r) => console.log('disconnected:', r));

sock.on('spike', (m) => { spikes++; if (samples.length < 3) samples.push({ev: 'spike', ...m}); });
sock.on('weight', (m) => { weights++; });
sock.on('insight', (m) => { insights++; if (samples.length < 5) samples.push({ev: 'insight', neurons: m.neurons, synapses: m.synapses, region_count: m.regions?.length}); });
sock.on('dream', (m) => { dreams++; samples.push({ev: 'dream', ...m}); });
sock.on('pathway', (m) => { pathways++; samples.push({ev: 'pathway', ...m}); });

setTimeout(() => {
  console.log('\n=== summary after 10s ===');
  console.log({ spikes, weights, insights, dreams, pathways });
  console.log('samples:', JSON.stringify(samples, null, 2));
  sock.close();
  process.exit(0);
}, 10000);
