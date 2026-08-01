/**
 * LOCATE latency/cost bench.
 *
 *   node scripts/bench-locate.ts                                    # the shipped defaults
 *   node scripts/bench-locate.ts --models gpt-5.5,gpt-5.6-terra,gpt-5.6-luna
 *   node scripts/bench-locate.ts --efforts none,low,medium --repeat 2
 *   node scripts/bench-locate.ts --long-edges 1568,1024,768 --technique on,off
 *   node scripts/bench-locate.ts --images a.jpg,b.jpg --truth 37.7558,-122.4475
 *
 * CAUTION on repeated runs. OpenAI caches a byte-identical request prefix, so a
 * second run of the same scenario bills most of its input at a tenth of the rate
 * and the `cost $` column drops for a reason that has nothing to do with the
 * change under test. The `cached in` column is there so that is visible. Cost
 * comparisons must be read off runs with `cached in` = 0, or recomputed from the
 * token columns. Measured 2026-07-31: the cache never hits across DIFFERENT
 * images, whatever the content ordering, so it never fires in production.
 *
 * Why this exists: every tuning claim about LOCATE — model, reasoning effort,
 * image size, output caps, prompt size — is a claim about a real photo going to a
 * real vendor. This runs the *whole* `locate()` path, not a synthetic call, so
 * the numbers include image preparation, the technique-doc suffix, the schema and
 * the synthesis step that decides whether a region survives support matching.
 *
 * It reports four things per run and refuses to collapse them into one score:
 *   - wall-clock, split into total and the vision call;
 *   - provider-reported tokens in/out and the cost computed from them;
 *   - clue counts by category, which is the evidence the product ships;
 *   - the distance from the top candidate to a known ground truth.
 *
 * A configuration is only better if it does not move the last two. Speed bought
 * by dropping observations is not a win here — the citable observation list is
 * the product.
 *
 * NOT a test. It costs money and needs a key, so it is never run by `node --test`.
 */

import { readFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A resolve hook scoped to this repo's own sources.
 *
 * Deliberately NOT `@/lib/cascade/testing/aliasHooks`: that one appends `.ts` to
 * every extensionless relative specifier, including the ones CommonJS packages
 * use internally, which makes `require('./constructor')` inside `sharp` fail. The
 * visible symptom is a silent one — `prepareImage` reports
 * `passthrough-oversized`, the full 2560px frame goes to the vendor, and every
 * conclusion about image size in this bench would have been measured against an
 * image that was never resized. So the rewrite is confined to files under this
 * repo, and `node_modules` resolves normally.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

type NextResolve = (specifier: string, context: unknown) => unknown;
interface ModuleHooksApi {
  registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, next: NextResolve) => unknown;
  }): void;
}

const hasExtension = (s: string): boolean => /\.[cm]?[jt]sx?$/.test(s) || /\.(json|node)$/.test(s);

(nodeModule as unknown as ModuleHooksApi).registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const target = path.join(srcRoot, specifier.slice(2));
      return next(pathToFileURL(hasExtension(target) ? target : `${target}.ts`).href, context);
    }
    const parent = context.parentURL ?? '';
    const ours = parent.startsWith(pathToFileURL(repoRoot).href) && !parent.includes('/node_modules/');
    if (ours && (specifier.startsWith('./') || specifier.startsWith('../')) && !hasExtension(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const locateModule = (await import('../src/lib/live/locate.ts')) as typeof import('../src/lib/live/locate.ts');
const { locate } = locateModule;
const { OpenAiVisionProvider } = (await import(
  '../src/lib/live/vision/openai.ts'
)) as typeof import('../src/lib/live/vision/openai.ts');

import type { LiveVisionProvider, LiveVlmRequest, LiveVlmResult } from '../src/lib/live/vision/types.ts';
import type { StructuredRequest, StructuredResult } from '../src/lib/live/vision/types.ts';
import type { Result, StageFailure } from '../src/lib/cascade/types.ts';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = path.join(
  process.cwd(),
  '.lantage-uploads',
  '9044161a5a011867b375f5a38da8b376f07be3eb1cb51ac1562ce9e1122091af.jpg',
);

/** s008.jpg: a Street View capture on Twin Peaks Blvd, San Francisco. */
const DEFAULT_TRUTH = { lat: 37.7558, lon: -122.4475 };

/**
 * A SECOND fixture is worth building before trusting any model comparison made
 * on the default one.
 *
 * The default frame contains the legible string "San Francisco, California", so
 * every model gets it right and the comparison measures nothing. The useful
 * counterpart is the same frame cropped to the bare Street View pane — a blurred
 * hillside and a road, no readable text — where the only correct answer is to
 * decline. That is where a cheaper model would show itself, by inventing a
 * region instead of setting `insufficientSignal`. Reproduce it with:
 *
 *   sharp(DEFAULT_IMAGE).extract({ left: 830, top: 10, width: 1540, height: 880 })
 *
 * and pass it via `--images`. Measured 2026-07-31: gpt-5.5, gpt-5.6-terra and
 * gpt-5.6-luna all declined, at every reasoning effort.
 */

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * `.env.local` is read here rather than assumed to be in `process.env`: this
 * script runs on bare Node, with none of Next's env loading.
 */
async function loadEnvLocal(): Promise<void> {
  let text: string;
  try {
    text = await readFile(path.join(process.cwd(), '.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------------------
// Recording wrapper
// ---------------------------------------------------------------------------

/**
 * Delegates to a real provider and keeps the raw extraction.
 *
 * `locate()` returns evidence, not clues, and the clue counts are exactly what a
 * quality comparison turns on — so the bench needs to see both sides of the
 * boundary in one run rather than making two calls and paying twice.
 */
class RecordingProvider implements LiveVisionProvider {
  readonly vendor: LiveVisionProvider['vendor'];
  readonly model: string;
  readonly name: string;
  last: LiveVlmResult | undefined;
  lastError: string | undefined;
  // Not a constructor parameter property: the loader runs strip-only TypeScript
  // and rejects that syntax outright.
  private readonly inner: LiveVisionProvider;

  constructor(inner: LiveVisionProvider) {
    this.inner = inner;
    this.vendor = inner.vendor;
    this.model = inner.model;
    this.name = inner.name;
  }

  async extractClues(req: LiveVlmRequest): Promise<Result<LiveVlmResult, StageFailure>> {
    const res = await this.inner.extractClues(req);
    if (res.ok) this.last = res.value;
    else this.lastError = res.error.reason;
    return res;
  }

  extractStructured<T>(req: StructuredRequest<T>): Promise<Result<StructuredResult<T>, StageFailure>> {
    return this.inner.extractStructured(req);
  }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  image: string;
  model: string;
  effort: string;
  maxLongEdgePx: number | undefined;
  technique: boolean;
}

interface RunResult {
  label: string;
  totalMs: number;
  visionMs: number;
  inputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  outputTokens: number | undefined;
  reasoningTokens: number | undefined;
  costUsd: number | undefined;
  clues: { text: number; infra: number; env: number; arch: number };
  priors: string[];
  topLabel: string | undefined;
  topKm: number | undefined;
  radiusKm: number | undefined;
  band: string | undefined;
  imagePx: string;
  promptChars: number;
  note: string;
}

async function runOnce(
  scenario: Scenario,
  bytes: Uint8Array,
  truth: { lat: number; lon: number },
): Promise<RunResult> {
  // 'default' means "do not pass one, let the provider's own default stand", so
  // the shipped configuration can be benched without restating it here and
  // silently drifting from it.
  const inner = new OpenAiVisionProvider({
    ...(scenario.model === 'default' ? {} : { model: scenario.model }),
    ...(scenario.effort === 'provider' ? {} : { reasoningEffort: scenario.effort }),
    ...(scenario.maxLongEdgePx === undefined ? {} : { maxLongEdgePx: scenario.maxLongEdgePx }),
  });
  const provider = new RecordingProvider(inner);

  const technique = scenario.technique ? await locateModule.readTechniqueDoc(process.env) : null;
  const promptChars = locateModule.buildPromptSuffix(technique).length;

  const started = Date.now();
  const result = await locate(
    { uploadId: 'bench', bytes, mime: 'image/jpeg' },
    {
      provider,
      geocoder: null,
      readTechniqueDoc: async () => technique,
      env: process.env as Record<string, string | undefined>,
    },
  );
  const totalMs = Date.now() - started;

  const vision = result.stages.find((s) => s.stage === 'vlm-clues');
  const clues = provider.last?.clues;
  const top = result.geo[0];

  return {
    label: scenario.label,
    totalMs,
    visionMs: vision?.ranMs ?? 0,
    inputTokens: provider.last?.usage.inputTokens,
    cachedInputTokens: provider.last?.usage.cachedInputTokens,
    outputTokens: provider.last?.usage.outputTokens,
    reasoningTokens: provider.last?.usage.reasoningTokens,
    costUsd: provider.last?.usage.costUsd,
    clues: {
      text: clues?.text.length ?? 0,
      infra: clues?.infrastructure.length ?? 0,
      env: clues?.environment.length ?? 0,
      arch: clues?.architecture.length ?? 0,
    },
    priors: (clues?.regionPrior ?? []).map((p) => `${p.label} (${p.rawConfidence.toFixed(2)})`),
    topLabel: top?.place?.label,
    topKm: top ? haversineKm(top.center, truth) : undefined,
    radiusKm: top ? top.radiusM / 1000 : undefined,
    band: top?.confidence.band,
    imagePx: provider.last ? formatPx(provider.last.image) : '-',
    promptChars,
    note: provider.lastError ?? (result.geo.length === 0 ? unresolvedNote(result) : ''),
  };
}

function unresolvedNote(result: Awaited<ReturnType<typeof locate>>): string {
  const first = result.unresolvedRegions[0];
  return first ? `no candidate: ${first.label} — ${first.reason.slice(0, 90)}` : 'no candidate';
}

function formatPx(image: LiveVlmResult['image']): string {
  // The method matters as much as the size: 'passthrough' at full resolution
  // means the local resizer never ran, which silently invalidates any
  // conclusion about image size.
  const size = image.px ? `${image.px.w}x${image.px.h}` : '?';
  return `${size} ${image.method}`;
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

function list(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  await loadEnvLocal();
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set (checked process.env and .env.local). Nothing was run.');
    process.exitCode = 1;
    return;
  }

  const imagePaths = list(arg('images', arg('image', DEFAULT_IMAGE)));
  const bytesByPath = new Map<string, Uint8Array>();
  for (const p of imagePaths) bytesByPath.set(p, new Uint8Array(await readFile(p)));
  const truthArg = arg('truth', `${DEFAULT_TRUTH.lat},${DEFAULT_TRUTH.lon}`).split(',');
  const truth = { lat: Number(truthArg[0]), lon: Number(truthArg[1]) };

  // 'default' / 'provider' exercise whatever the provider ships with; name a model
  // or an effort explicitly to compare against it.
  const models = list(arg('models', 'default'));
  const efforts = list(arg('efforts', 'provider'));
  const longEdges = list(arg('long-edges', '')).map(Number);
  const techniqueModes = list(arg('technique', 'on')).map((v) => v === 'on');
  const repeat = Number(arg('repeat', '1'));

  const scenarios: Scenario[] = [];
  for (const model of models) {
    for (const effort of efforts) {
      for (const edge of longEdges.length > 0 ? longEdges : [Number.NaN]) {
        for (const technique of techniqueModes) {
          for (const image of imagePaths) {
            const px = Number.isNaN(edge) ? 'vendor-cap' : `${edge}px`;
            const name = imagePaths.length > 1 ? ` · ${path.basename(image)}` : '';
            scenarios.push({
              label: `${model} · effort=${effort} · ${px} · doc=${technique ? 'on' : 'off'}${name}`,
              image,
              model,
              effort,
              maxLongEdgePx: Number.isNaN(edge) ? undefined : edge,
              technique,
            });
          }
        }
      }
    }
  }

  const results: RunResult[] = [];
  for (const scenario of scenarios) {
    for (let i = 0; i < repeat; i += 1) {
      const label = repeat > 1 ? `${scenario.label} #${i + 1}` : scenario.label;
      process.stderr.write(`running ${label}\n`);
      const bytes = bytesByPath.get(scenario.image) as Uint8Array;
      const run = await runOnce({ ...scenario, label }, bytes, truth);
      results.push(run);
      process.stderr.write(
        `  ${run.totalMs}ms total / ${run.visionMs}ms vision · in ${run.inputTokens ?? '-'} (${run.cachedInputTokens ?? 0} cached) out ${run.outputTokens ?? '-'} · ${run.costUsd === undefined ? 'cost unknown' : `$${run.costUsd.toFixed(4)}`} · ${run.topLabel ?? 'no candidate'} ${run.topKm === undefined ? '' : `${run.topKm.toFixed(0)}km`}\n`,
      );
    }
  }

  report(results);
}

function report(results: RunResult[]): void {
  const cols = [
    'scenario',
    'total ms',
    'vision ms',
    'tok in',
    'cached in',
    'tok out',
    'reason tok',
    'cost $',
    '$/1k',
    'clues t/i/e/a',
    'sent px',
    'suffix chars',
    'top candidate',
    'err km',
    'radius km',
    'band',
  ];
  const rows = results.map((r) => [
    r.label,
    String(r.totalMs),
    String(r.visionMs),
    r.inputTokens === undefined ? '-' : String(r.inputTokens),
    r.cachedInputTokens === undefined ? '-' : String(r.cachedInputTokens),
    r.outputTokens === undefined ? '-' : String(r.outputTokens),
    r.reasoningTokens === undefined ? '-' : String(r.reasoningTokens),
    r.costUsd === undefined ? 'unknown' : r.costUsd.toFixed(5),
    r.costUsd === undefined ? 'unknown' : (r.costUsd * 1000).toFixed(2),
    `${r.clues.text}/${r.clues.infra}/${r.clues.env}/${r.clues.arch}`,
    r.imagePx,
    String(r.promptChars),
    r.topLabel ?? '-',
    r.topKm === undefined ? '-' : r.topKm.toFixed(1),
    r.radiusKm === undefined ? '-' : r.radiusKm.toFixed(0),
    r.band ?? '-',
  ]);

  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;

  console.log(line(cols));
  console.log(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  for (const row of rows) console.log(line(row));

  console.log('\nRegion priors returned, per run:');
  for (const r of results) {
    console.log(`  ${r.label}: ${r.priors.join(' · ') || '(none)'}${r.note ? `  [${r.note}]` : ''}`);
  }
}

await main();
