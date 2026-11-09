// ============================================================================
// Copies the website's data into public/data/ just before the site is
// published (Cloudflare runs this automatically; see wrangler.jsonc).
// The nightly job's private memory (data/cache/) is left out: the website
// doesn't need it, and leaving it out keeps the published site small.
// ============================================================================

import { cp, rm } from 'node:fs/promises';
import path from 'node:path';

const from = path.resolve('data');
const to = path.resolve('public', 'data');

await rm(to, { recursive: true, force: true });
await cp(from, to, {
  recursive: true,
  filter: src => !src.startsWith(path.join(from, 'cache')),
});
console.log('Copied data/ to public/data/ (without the cache).');
