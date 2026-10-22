// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  FEATURES,
  POLL_INTERVALS,
  SCENE_TRIGGERS,
  SILENT_MINUTES,
} from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const USER_LOCATION_ISSUE = 'https://github.com/GladysAssistant/Gladys/issues/3224';

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/, 'scene triggers need 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-invoxia:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-invoxia');
  assert.equal(lock.name, 'gladys-invoxia');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.location, undefined, 'the houses of Gladys are never read');
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
    assert.ok(read(`docs/${lang}.md`).includes(USER_LOCATION_ISSUE), `docs/${lang}.md: the issue`);
  }
  assert.ok(read('TODO.md').includes(USER_LOCATION_ISSUE), 'TODO.md: the issue');
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested with a real Invoxia/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai traceur/i);
});

test('the license (no personal name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /gps-tracker/);
  assert.match(notices, /Copyright \(c\) 2021 Ezlo Picori/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; the secret is never said encrypted', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.poll_interval.options.map((o) => o.value),
    POLL_INTERVALS,
  );
  assert.deepEqual(
    fields.silent_minutes.options.map((o) => o.value),
    SILENT_MINUTES,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'username',
    'password',
    'poll_interval',
    'silent_minutes',
  ]);
  assert.equal(fields.password.type, 'secret');
  assert.equal(fields.username.type, 'string');
  assert.match(
    fields.password.description.en,
    /never shown again, never logged, sent only to the Invoxia API/,
  );
  assert.match(fields.password.description.fr, /jamais réaffiché, jamais journalisé/);
  for (const [name, text] of [
    ['manifest', JSON.stringify(manifest)],
    ['docs/en.md', read('docs/en.md')],
    ['docs/fr.md', read('docs/fr.md')],
    ['README.md', read('README.md')],
  ]) {
    assert.doesNotMatch(text, /chiffr|encrypt/i, `${name}: a secret is not encrypted`);
  }
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined, 'read only: no scene action');
  assert.equal(manifest.widgets, undefined);
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.ok(app.includes(`SCENE_TRIGGERS.${name}`), `${name} is never fired`);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('the trigger: filters and variables are keys of the event; thresholds of the code', () => {
  const data = ['device', 'minutes', 'device_name', 'silent_for', 'last_seen'];
  const [trigger] = manifest.scene_triggers;
  for (const key of keys([...trigger.fields, ...trigger.variables])) {
    assert.ok(data.includes(key), `${trigger.key}: ${key} is not in the event`);
  }
  const device = trigger.fields.find((f) => f.key === 'device');
  assert.equal(device.source, 'devices');
  assert.equal(device.required, false);
  const minutes = trigger.fields.find((f) => f.key === 'minutes');
  assert.equal(minutes.required, true, 'no wildcard: one event per threshold');
  assert.deepEqual(
    minutes.options.map((o) => o.value),
    SILENT_MINUTES,
  );
  assert.ok(!trigger.variables.some((v) => /lat|lon|position/.test(v.key)), 'no position');
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('features: read only, no switch, pairs and units of the core; keys fixed', () => {
  const gladys = createFakeGladys({ selector: 'invoxia' });
  const { features } = buildDevice(gladys, {
    key: '0123456789abcdef',
    name: 'x',
    hasMoving: true,
  });
  // Pairs drawn by the front, units of DEVICE_FEATURE_UNITS_BY_CATEGORY
  // (server/utils/constants.js of the core).
  const allowed = {
    unknown: { types: ['unknown', 'binary'], units: [] },
    battery: { types: ['integer'], units: ['percent'] },
    'distance-sensor': {
      types: ['decimal'],
      units: ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile'],
    },
    text: { types: ['text'], units: [] },
  };
  for (const feature of features) {
    assert.equal(feature.read_only, true, feature.name);
    const rule = allowed[feature.category];
    assert.ok(
      rule?.types.includes(feature.type),
      `${feature.name}: ${feature.category}/${feature.type}`,
    );
    if (rule.units.length === 0) assert.equal(feature.unit, undefined, `${feature.name}: no unit`);
    else assert.ok(rule.units.includes(feature.unit), `${feature.name}: ${feature.unit}`);
    assert.notEqual(feature.category, 'switch');
    assert.notEqual(feature.category, 'motion-sensor');
  }
  assert.deepEqual(
    features.map((f) => f.external_id.split(':').at(-1)).sort(),
    Object.values(FEATURES).sort(),
  );
  const history = Object.fromEntries(
    features.map((f) => [f.external_id.split(':').at(-1), f.keep_history]),
  );
  assert.equal(history.latitude, false, 'positions: no history by default');
  assert.equal(history.longitude, false);
  assert.equal(history.accuracy, false);
});
