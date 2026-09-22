import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULTS, TIERS } from '../lib/config.mjs';

// The tier table lives in config; each SKILL.md must carry the same model and effort.
for (const tier of TIERS) {
  test(`skills/${tier}/SKILL.md matches config.routes.${tier}`, () => {
    const text = readFileSync(new URL(`../skills/${tier}/SKILL.md`, import.meta.url), 'utf8');
    const frontmatter = text.split('---')[1];
    const model = frontmatter.match(/^model:\s*(\S+)/m)?.[1];
    const effort = frontmatter.match(/^effort:\s*(\S+)/m)?.[1];
    assert.equal(model, DEFAULTS.routes[tier].model);
    assert.equal(effort, DEFAULTS.routes[tier].effort);
  });
}
