// Reports which cells the local evidence overlay covers: per model, the efforts it fills and the activities per
// effort, every unknown activity cell, every low-confidence cell, models with no capability, and configured model
// ids no overlay entry matches. Reads only the overlay and the profiles' models lists: no other profile field is
// printed, file contents never appear, and there is no network access.
//   npm run evidence:report [-- --json]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTIVITIES } from '../lib/config.mjs';
import { configuredCoverage, summarizeOverlay } from '../lib/evidence-report.mjs';

const HOME = homedir();
const OVERLAY = join(HOME, '.config', 'claude-router', 'evidence.local.mjs');
const PROFILE_DIRS = [join(HOME, '.claude'), join(HOME, '.claude-team')];
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const display = (path) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

function usage() {
  console.log(`Usage: npm run evidence:report [-- options]

  --json        machine-readable output
  -h, --help    this text

Reads the local overlay at ~/.config/claude-router/evidence.local.mjs and the models lists of
~/.claude/*router.json and ~/.claude-team/*router.json. Prints no other profile field and no file contents.`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (!existsSync(OVERLAY)) {
  const message = `evidence report: no local overlay at ${display(OVERLAY)}; run npm run evidence:aa to create it`;
  if (asJson) console.log(JSON.stringify({ overlay: null, message }, null, 2));
  else console.log(message);
  process.exit(0);
}

/** @type {unknown} */
let overlay;
try {
  const module = await import(pathToFileURL(OVERLAY).href);
  overlay = module.EVIDENCE_LOCAL;
} catch {
  console.error(`evidence report: cannot load ${display(OVERLAY)}; regenerate it with npm run evidence:aa`);
  process.exit(1);
}
if (typeof overlay !== 'object' || overlay === null) {
  console.error(`evidence report: ${display(OVERLAY)} exports no EVIDENCE_LOCAL object; regenerate it`);
  process.exit(1);
}

/** @type {Array<{ path: string, json: unknown }>} */
const profiles = [];
/** @type {string[]} */
const parseErrors = [];
for (const dir of PROFILE_DIRS) {
  let names;
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('router.json'))
      .sort();
  } catch {
    continue;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      profiles.push({ path, json: JSON.parse(readFileSync(path, 'utf8')) });
    } catch {
      parseErrors.push(path);
    }
  }
}
for (const path of parseErrors) console.error(`evidence report: ${display(path)} is not valid JSON; skipped`);

const summary = summarizeOverlay(overlay);
const coverage = configuredCoverage(overlay, profiles);
/** @type {Map<string, { id: string, evidence: string | null, covered: boolean, profiles: string[] }>} */
const configured = new Map();
for (const row of coverage) {
  const entry = configured.get(row.id) ?? {
    id: row.id,
    evidence: row.evidence,
    covered: row.covered,
    profiles: [],
  };
  entry.profiles.push(row.profile);
  configured.set(row.id, entry);
}
const configuredIds = [...configured.values()].sort((a, b) => a.id.localeCompare(b.id));
const uncovered = configuredIds.filter((entry) => !entry.covered);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        overlay: {
          path: OVERLAY,
          checked: summary.checked,
          source: summary.source,
          tier: summary.tier,
          models: summary.models.length,
        },
        models: summary.models,
        lowConfidence: summary.lowConfidence,
        missing: summary.missing,
        noCapability: summary.noCapability,
        configured: {
          profiles: profiles.length,
          parseErrors,
          ids: configuredIds,
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`Evidence overlay: ${display(OVERLAY)}`);
const meta = [summary.checked ? `checked ${summary.checked}` : 'checked unknown'];
if (summary.tier) meta.push(`tier ${summary.tier}`);
if (summary.source) meta.push(`source ${summary.source}`);
console.log(`${meta.join(' · ')} · ${summary.models.length} models`);
console.log('');

for (const model of summary.models) {
  const aliases = model.aliases.length ? ` (aliases: ${model.aliases.join(', ')})` : '';
  console.log(`${model.model}${aliases}`);
  if (model.noCapability) console.log('  no capability');
  for (const cell of model.efforts) {
    const values = ACTIVITIES.map((activity) => `${activity}=${cell.activities[activity] ?? 'unknown'}`).join(' ');
    console.log(`  ${cell.effort.padEnd(7)}${values}`);
  }
  if (model.lowConfidence.length) console.log(`  low-confidence: ${model.lowConfidence.join(', ')}`);
  console.log('');
}

console.log(
  summary.missing.length ? `Missing activity cells (${summary.missing.length}):` : 'Missing activity cells: none',
);
for (const cell of summary.missing) console.log(`  ${cell.model} ${cell.effort} ${cell.activity}=unknown`);
console.log('');
console.log(
  summary.noCapability.length
    ? `Models with no capability: ${summary.noCapability.join(', ')}`
    : 'Models with no capability: none',
);
console.log('');
console.log(`Configured model ids: ${configuredIds.length} unique from ${profiles.length} profiles`);
console.log(
  uncovered.length ? `Not covered by the overlay (${uncovered.length}):` : 'Not covered by the overlay: none',
);
for (const entry of uncovered) {
  const where = [...new Set(entry.profiles)].map(display).join(', ');
  console.log(`  ${entry.id} (configured in ${where})`);
}
