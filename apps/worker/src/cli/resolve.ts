/**
 * Resolver spike: prove identify() → Catalog MCP search end to end against
 * one real image, before wiring the resolver into the intake pipeline.
 *
 * Run: pnpm resolve -- <path-to-image> ["caption text"]
 *
 * Requires NVIDIA_API_KEY, SHOPIFY_CATALOG_CLIENT_ID/SECRET, and
 * UCP_AGENT_PROFILE_URL in .env.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { resolve } from '../resolver/resolve.ts';

const MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function main() {
  // Nested pnpm script forwarding (root `resolve` -> workspace `resolve`) can
  // leave a stray literal "--" in argv; strip it rather than mis-parse it as
  // the image path.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const [imagePath, caption] = args;
  if (!imagePath) {
    console.error('Usage: pnpm resolve -- <path-to-image> ["caption text"]');
    process.exit(1);
  }

  const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
  if (!mediaType) {
    console.error(`Unsupported image type: ${extname(imagePath)} (expected .jpg/.png/.webp)`);
    process.exit(1);
  }

  const imageBase64 = (await readFile(imagePath)).toString('base64');

  console.log('--- Resolver spike ---\n');
  console.log('Identifying...');

  const result = await resolve({ media: { imageBase64, mediaType, caption } });

  console.log('\nSignal:');
  console.log(`  brand:       ${result.signal.brand ?? '(none)'}`);
  console.log(`  productType: ${result.signal.productType}`);
  console.log(`  color:       ${result.signal.color ?? '(none)'}`);
  console.log(`  features:    ${result.signal.distinguishingFeatures.join(', ') || '(none)'}`);
  console.log(`  confidence:  ${result.signal.confidence}`);
  console.log(`  searchQuery: "${result.signal.searchQuery}"`);

  console.log(`\nResolution: ${result.resolution}`);
  console.log(`Candidates: ${result.candidates.length}\n`);

  for (const [i, c] of result.candidates.entries()) {
    console.log(`${i}. ${c.title} — ${c.merchant ?? 'unknown merchant'}`);
    console.log(`   ${c.priceAmount ?? '?'} ${c.currency ?? ''}  ${c.productUrl}`);
  }
}

main().catch((err) => {
  console.error('\n', err);
  process.exit(1);
});
