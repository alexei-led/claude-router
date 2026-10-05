import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const modules = [
  'config',
  'facts-pure',
  'jev-contract',
  'native-band',
  'native-cost',
  'native-display',
  'native-jev',
  'native-panel',
  'native-router',
  'policy',
];

export async function prepareNativeCandidate({ acceptance = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-native-candidate-'));
  await mkdir(join(directory, '.claude-plugin'));
  await mkdir(join(directory, 'hooks'));
  await mkdir(join(directory, 'lib'));
  const manifest = JSON.parse(await readFile(join(root, '.claude-plugin/plugin.json'), 'utf8'));
  manifest.description = 'Isolated native Router candidate; gateway hooks are disabled for this launch.';
  manifest.types = './types/index.d.ts';
  await writeFile(join(directory, '.claude-plugin/plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(directory, 'hooks/hooks.json'),
    `${JSON.stringify({ modules: [acceptance ? './register.mjs' : './native-router.mjs'] })}\n`,
  );
  await cp(join(root, 'types'), join(directory, 'types'), { recursive: true });
  await cp(join(root, 'hooks/native-router.mjs'), join(directory, 'hooks/native-router.mjs'));
  for (const name of modules) await cp(join(root, `lib/${name}.mjs`), join(directory, `lib/${name}.mjs`));
  if (acceptance) {
    await writeFile(
      join(directory, 'hooks/register.mjs'),
      "import { register as native } from './native-router.mjs';\nimport { registerAcceptance } from './acceptance.mjs';\nexport function register(on, options) { native(on, options); registerAcceptance(on); }\n",
    );
    await cp(join(root, 'experiments/mod-router/hooks/acceptance.mjs'), join(directory, 'hooks/acceptance.mjs'));
  }
  await mkdir(join(directory, 'tests'));
  await cp(join(root, 'test/native-mod.test.ts'), join(directory, 'tests/native-mod.test.ts'));
  return directory;
}

const BASELINE_MODEL = 'claude-sonnet-5-5';
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c']);

function hasFlag(argv, names) {
  return argv.some(
    (arg) => names.has(arg) || [...names].some((name) => name.startsWith('--') && arg.startsWith(`${name}=`)),
  );
}

// A resumed or explicitly modelled launch keeps its own native model; only a fresh launch gets the default.
export function nativeLaunchPlan(argv = []) {
  const keepsModel = hasFlag(argv, RESUME_FLAGS) || hasFlag(argv, new Set(['--model']));
  const env = {
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: '',
    ...(keepsModel ? {} : { ANTHROPIC_MODEL: BASELINE_MODEL }),
  };
  return {
    args: keepsModel ? [] : ['--model', BASELINE_MODEL],
    settings: {
      ...(keepsModel ? {} : { model: BASELINE_MODEL }),
      modelPicker: { options: [] },
      env,
      enabledPlugins: { 'router@alexei-led-claude-router': false },
    },
  };
}
