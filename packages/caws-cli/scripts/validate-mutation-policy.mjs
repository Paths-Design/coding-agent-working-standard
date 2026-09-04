#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const allowedStrategies = new Set(['mutation', 'contract', 'behavioral']);

function normalize(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function parseArgs(argv) {
  const options = {
    root: defaultRoot,
    policy: path.join(defaultRoot, 'mutation-policy.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' || arg === '--policy') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(file, errors, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${label} is not readable JSON: ${file} (${error.message})`);
    return null;
  }
}

function listSourceFiles(root, sourceRoots, errors) {
  const files = [];
  const walk = (absoluteDir) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (/\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(normalize(path.relative(root, absolute)));
      }
    }
  };

  for (const relativeRoot of sourceRoots) {
    const absoluteRoot = path.resolve(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
      errors.push(`missing source root: ${normalize(relativeRoot)}`);
      continue;
    }
    walk(absoluteRoot);
  }
  return files.sort();
}

function validateSortedUnique(values, label, errors) {
  const sorted = [...values].sort();
  if (JSON.stringify(values) !== JSON.stringify(sorted)) {
    errors.push(`${label} must be sorted lexically`);
  }
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) errors.push(`${label} contains duplicate entry: ${value}`);
    seen.add(value);
  }
}

export function validateMutationPolicy({ root, policyFile }) {
  const errors = [];
  const policy = readJson(policyFile, errors, 'mutation policy');
  if (!policy) return { errors, sourceCount: 0, targetCount: 0, surfaceCount: 0 };

  if (policy.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion: ${String(policy.schemaVersion)}`);
  }

  const sourceRoots = Array.isArray(policy.sourceRoots) ? policy.sourceRoots : [];
  if (sourceRoots.length === 0) errors.push('sourceRoots must be a non-empty array');
  const actualSources = listSourceFiles(root, sourceRoots, errors);
  const actualSet = new Set(actualSources);

  const proofGroups = Array.isArray(policy.proofGroups) ? policy.proofGroups : [];
  if (proofGroups.length === 0) errors.push('proofGroups must be a non-empty array');
  const classifications = new Map();
  const groupIds = new Set();
  let mutationFiles = [];

  for (const [groupIndex, group] of proofGroups.entries()) {
    const label = `proofGroups[${groupIndex}]`;
    if (!group || typeof group !== 'object') {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof group.id !== 'string' || group.id.length === 0) {
      errors.push(`${label}.id must be a non-empty string`);
    } else if (groupIds.has(group.id)) {
      errors.push(`duplicate proof group id: ${group.id}`);
    } else {
      groupIds.add(group.id);
    }
    if (!allowedStrategies.has(group.strategy)) {
      errors.push(`${label}.strategy must be mutation, contract, or behavioral`);
    }
    if (typeof group.command !== 'string' || group.command.length === 0) {
      errors.push(`${label}.command must be a non-empty string`);
    }
    if (typeof group.rationale !== 'string' || group.rationale.length === 0) {
      errors.push(`${label}.rationale must be a non-empty string`);
    }

    const files = Array.isArray(group.files) ? group.files.map(normalize) : [];
    if (files.length === 0) errors.push(`${label}.files must be a non-empty array`);
    validateSortedUnique(files, `${label}.files`, errors);
    if (group.strategy === 'mutation') mutationFiles = mutationFiles.concat(files);

    for (const file of files) {
      const prior = classifications.get(file);
      if (prior) {
        errors.push(`source classified more than once: ${file} (${prior}, ${group.id})`);
      } else {
        classifications.set(file, group.id);
      }
      if (!actualSet.has(file)) errors.push(`classified source does not exist: ${file}`);
    }
  }

  for (const source of actualSources) {
    if (!classifications.has(source)) errors.push(`unclassified source: ${source}`);
  }

  const surfaces = policy.surfaces && typeof policy.surfaces === 'object' ? policy.surfaces : {};
  const surfaceEntries = Object.entries(surfaces);
  if (surfaceEntries.length === 0) errors.push('surfaces must define at least one mutation surface');
  const targetSources = [];

  for (const [surfaceId, surface] of surfaceEntries) {
    const label = `surfaces.${surfaceId}`;
    if (!surface || typeof surface !== 'object') {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof surface.config !== 'string' || surface.config.length === 0) {
      errors.push(`${label}.config must be a non-empty string`);
    } else if (!fs.existsSync(path.resolve(root, surface.config))) {
      errors.push(`missing mutation config: ${surface.config}`);
    }
    if (typeof surface.reportDir !== 'string' || surface.reportDir.length === 0) {
      errors.push(`${label}.reportDir must be a non-empty string`);
    }
    if (typeof surface.threshold !== 'number' || surface.threshold < 0 || surface.threshold > 100) {
      errors.push(`${label}.threshold must be a number from 0 through 100`);
    }

    const tests = Array.isArray(surface.tests) ? surface.tests.map(normalize) : [];
    if (tests.length === 0) errors.push(`${label}.tests must be a non-empty array`);
    validateSortedUnique(tests, `${label}.tests`, errors);
    for (const testFile of tests) {
      if (!fs.existsSync(path.resolve(root, testFile))) {
        errors.push(`missing mutation test: ${testFile}`);
      }
    }

    const targets = Array.isArray(surface.targets) ? surface.targets : [];
    if (targets.length === 0) errors.push(`${label}.targets must be a non-empty array`);
    const targetPaths = [];
    for (const [targetIndex, target] of targets.entries()) {
      if (!target || typeof target.source !== 'string' || target.source.length === 0) {
        errors.push(`${label}.targets[${targetIndex}].source must be a non-empty string`);
        continue;
      }
      const source = normalize(target.source);
      targetPaths.push(source);
      targetSources.push(source);
      if (!fs.existsSync(path.resolve(root, source))) errors.push(`missing mutation source: ${source}`);
      if (!mutationFiles.includes(source)) {
        errors.push(`mutation target is not classified as mutation: ${source}`);
      }
      if (
        target.threshold !== undefined &&
        (typeof target.threshold !== 'number' || target.threshold < 0 || target.threshold > 100)
      ) {
        errors.push(`${label}.targets[${targetIndex}].threshold must be a number from 0 through 100`);
      }
    }
    validateSortedUnique(targetPaths, `${label}.targets`, errors);
  }

  const targetCounts = new Map();
  for (const source of targetSources) targetCounts.set(source, (targetCounts.get(source) || 0) + 1);
  for (const [source, count] of targetCounts) {
    if (count > 1) errors.push(`mutation source belongs to multiple surfaces: ${source}`);
  }
  for (const file of mutationFiles) {
    if (!targetCounts.has(file)) errors.push(`mutation-classified source has no surface target: ${file}`);
  }

  return {
    errors,
    sourceCount: actualSources.length,
    targetCount: targetSources.length,
    surfaceCount: surfaceEntries.length,
  };
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`mutation-policy: ${error.message}`);
    return 2;
  }

  const result = validateMutationPolicy({ root: options.root, policyFile: options.policy });
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`mutation-policy: ${error}`);
    return 1;
  }

  console.log(`PASS: ${result.sourceCount} source files accounted for exactly once`);
  console.log(`PASS: ${result.targetCount} mutation targets across ${result.surfaceCount} surfaces`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
