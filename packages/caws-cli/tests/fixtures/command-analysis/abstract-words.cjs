// Exported abstract-component domain, including unions the source entry point
// does not currently originate. These are argv semantics, not runtime receipts.
module.exports = [
  { id: 'union', source: '${V}', bindings: { V: ['a', 'b'] }, fields: [['a'], ['b']] },
  {
    id: 'union-limit',
    source: '"$V"',
    bindings: { V: Array.from({ length: 32 }, (_, i) => `v${i}`) },
    fields: Array.from({ length: 32 }, (_, i) => [`v${i}`]),
  },
  {
    id: 'union-exceeded',
    source: '"$V"',
    bindings: { V: Array.from({ length: 33 }, (_, i) => `v${i}`) },
    fields: [[null]],
    reasons: ['value-budget', 'unknown-splitting'],
  },
  {
    id: 'cartesian',
    source: '${A}${B}',
    bindings: { A: ['a', 'b'], B: ['1', '2'] },
    fields: [['a1'], ['a2'], ['b1'], ['b2']],
  },
  { id: 'empty-quoted', source: '"$V"', bindings: { V: [''] }, fields: [['']] },
  { id: 'empty-unquoted', source: '$V', bindings: { V: [''] }, fields: [[]] },
  { id: 'empty-double-quote', source: '""', bindings: {}, fields: [['']] },
  { id: 'default-ifs', source: '$V', bindings: { V: ['  a\tb\n'] }, fields: [['a', 'b']] },
  { id: 'quoted-ifs-data', source: '"$V"', bindings: { V: ['  a\tb\n'] }, fields: [['  a\tb\n']] },
  {
    id: 'mixed-fields',
    source: 'pre${V}post',
    bindings: { V: ['a b'] },
    fields: [['prea', 'bpost']],
  },
  {
    id: 'assignment-field',
    source: '$V',
    assignment: true,
    bindings: { V: ['a b'] },
    fields: [['a b']],
  },
  { id: 'opaque-quoted', source: '"$V"', bindings: {}, fields: [[null]] },
  {
    id: 'opaque-unquoted',
    source: '$V',
    bindings: {},
    fields: [[null]],
    reasons: ['unknown-splitting'],
  },
  {
    id: 'glob-unquoted',
    source: '$V',
    bindings: { V: ['*.ts'] },
    fields: [['*.ts']],
    reasons: ['pathname-expansion'],
  },
  { id: 'glob-quoted', source: '"$V"', bindings: { V: ['*.ts'] }, fields: [['*.ts']] },
];
