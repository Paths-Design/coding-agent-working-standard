'use strict';

const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');

function flattenLeaves(group, prefix = []) {
  if (group.kind === 'leaf') {
    return [{ command: [...prefix, group.name].join(' '), options: group.options || [] }];
  }
  if (!Array.isArray(group.subcommands)) {
    return [{ command: [...prefix, group.name].join(' '), options: group.options || [] }];
  }
  return group.subcommands.flatMap((subcommand) =>
    flattenLeaves(subcommand, [...prefix, group.name])
  );
}

function jsonLikeOptions() {
  return COMMAND_SURFACE_METADATA.flatMap((group) => flattenLeaves(group))
    .flatMap((leaf) =>
      leaf.options
        .filter((option) =>
          /--json|<json>|JSON|lifecycle-mapping/.test(
            `${option.flag} ${option.description}`
          )
        )
        .map((option) => ({
          command: leaf.command,
          flag: option.flag,
          description: option.description,
        }))
    );
}

function isOperatorSuppliedJsonInput(option) {
  if (option.command === 'evidence record' && option.flag === '--data <json>') {
    return true;
  }
  if (option.command === 'specs migrate' && option.flag === '--lifecycle-mapping <path>') {
    return true;
  }
  return false;
}

describe('CLI JSON input surface reconciliation', () => {
  test('only known operator-supplied JSON input flags are exposed in command metadata', () => {
    const inputs = jsonLikeOptions()
      .filter(isOperatorSuppliedJsonInput)
      .map((option) => `${option.command} ${option.flag}`)
      .sort();

    expect(inputs).toEqual([
      'evidence record --data <json>',
      'specs migrate --lifecycle-mapping <path>',
    ]);
  });

  test('json-like flags not classified as inputs are output or diagnostic selectors', () => {
    const unexpectedInputs = jsonLikeOptions()
      .filter((option) => !isOperatorSuppliedJsonInput(option))
      .filter((option) => {
        const text = `${option.flag} ${option.description}`;
        return !/emit|Show structured data|output|stdout|JSON output|JSON prune plan|JSON to stdout|read-only/i.test(
          text
        );
      })
      .map((option) => `${option.command} ${option.flag} — ${option.description}`);

    expect(unexpectedInputs).toEqual([]);
  });
});
