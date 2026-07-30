import assert from 'node:assert/strict';
import { test } from 'node:test';

// Explicit .ts extension: this is a RUNTIME import, so unlike the sibling tests
// (which only `import type` and therefore erase away) it has to resolve under
// Node's ESM loader, and extensionless relative specifiers do not.
import { MODULE_CATALOGUE, resolveVisionVendor } from './contract.ts';

/**
 * The vendor resolver decides which model's name lands in
 * `ResultProvenance.models`. A result attributed to the wrong model is worse
 * than no result, because provenance is what makes a finding reproducible — so
 * an explicit override that can't be honoured must fail closed rather than
 * quietly serve a different vendor.
 */

test('with no override, the first vendor with a key wins in priority order', () => {
  assert.equal(resolveVisionVendor({ ANTHROPIC_API_KEY: 'k' }), 'anthropic');
  assert.equal(resolveVisionVendor({ OPENAI_API_KEY: 'k' }), 'openai');
  assert.equal(resolveVisionVendor({ GEMINI_API_KEY: 'k' }), 'gemini');
  assert.equal(resolveVisionVendor({ GOOGLE_API_KEY: 'k' }), 'gemini');

  // Anthropic outranks OpenAI when both are present.
  assert.equal(resolveVisionVendor({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }), 'anthropic');
});

test('no keys at all resolves to null', () => {
  assert.equal(resolveVisionVendor({}), null);
});

test('an override selects that vendor even when a higher-priority key exists', () => {
  const vendor = resolveVisionVendor({
    LANTAGE_VISION_VENDOR: 'openai',
    ANTHROPIC_API_KEY: 'k',
    OPENAI_API_KEY: 'k',
  });
  assert.equal(vendor, 'openai');
});

test('an override without its own key fails closed and does NOT fall through', () => {
  // The trap this guards: forcing openai, forgetting OPENAI_API_KEY, and having
  // an Anthropic key lying around. Falling through would run Anthropic while the
  // operator believed they were testing OpenAI.
  const vendor = resolveVisionVendor({
    LANTAGE_VISION_VENDOR: 'openai',
    ANTHROPIC_API_KEY: 'k',
  });
  assert.equal(vendor, null);
});

test('an unrecognised override resolves to null rather than being ignored', () => {
  const vendor = resolveVisionVendor({
    LANTAGE_VISION_VENDOR: 'not-a-vendor',
    OPENAI_API_KEY: 'k',
  });
  assert.equal(vendor, null);
});

test('the override is case- and whitespace-tolerant', () => {
  assert.equal(
    resolveVisionVendor({ LANTAGE_VISION_VENDOR: '  OpenAI ', OPENAI_API_KEY: 'k' }),
    'openai',
  );
});

test('an empty override string is treated as unset, not as an unknown vendor', () => {
  assert.equal(resolveVisionVendor({ LANTAGE_VISION_VENDOR: '', OPENAI_API_KEY: 'k' }), 'openai');
});

test('FACE is the only module taking two images, and the keyless modules require nothing', () => {
  const byId = Object.fromEntries(MODULE_CATALOGUE.map((m) => [m.id, m]));

  assert.equal(byId.FACE.images, 2);
  for (const id of ['LOCATE', 'INTERIOR', 'VEHICLE', 'AUTHENTIC']) {
    assert.equal(byId[id].images, 1, `${id} should take one image`);
  }

  // These two must keep working with no configuration at all.
  assert.deepEqual([...byId.FACE.requires], []);
  assert.deepEqual([...byId.AUTHENTIC.requires], []);
});
