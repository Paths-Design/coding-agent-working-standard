import { parse } from 'acorn';
import type { ArrowFunctionExpression, Expression, Node, Statement } from 'acorn';

export type InterpreterWrite = {
  target: string;
  operation: 'write' | 'append';
  /** UTF-16 source offsets of the target argument, with an exclusive end. */
  start: number;
  end: number;
};
export type InterpreterEffects =
  | { kind: 'readonly'; profile: string; writes: [] }
  | { kind: 'finite-writes'; profile: string; writes: InterpreterWrite[] }
  | { kind: 'unresolved'; profile: null; reason: string; writes: [] };

const PROFILE = 'caws.node-source-effects.v1';
const SOURCE_BYTES = 64 * 1024;
const AST_NODES = 8192;
const DEPTH = 64;
const VALUES = 4096;
const STEPS = 32768;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
type Primitive = string | number | boolean | null | undefined;
type Value =
  | { kind: 'primitive'; value: Primitive }
  | { kind: 'array'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> }
  | { kind: 'fs' }
  | { kind: 'opaque' }
  | { kind: 'function'; node: ArrowFunctionExpression; env: Environment };
type Environment = { values: Map<string, Value>; parent?: Environment };

function refuse(reason: string): never {
  throw new Error(reason);
}

/**
 * A source-only, deliberately incomplete effect profile. Submitted source is
 * parsed and abstractly interpreted, never executed, imported, or read from disk.
 * The profile assumes ordinary, unmodified Node builtins and startup state; it
 * does not establish launch custody, runtime integrity, or filesystem authority.
 * Python has no admitted grammar in this version.
 */
export function classifyInterpreterEffects(
  language: 'node' | 'python',
  source: string
): InterpreterEffects {
  try {
    if (Buffer.byteLength(source, 'utf8') > SOURCE_BYTES) refuse('source byte budget exceeded');
    if (language !== 'node') refuse('no admitted Python source-effect profile');
    const program = parse(source, { ecmaVersion: 2022, sourceType: 'script' });

    // Bound the entire tree, including bodies that are not invoked. Acorn parse
    // failures (including its own recursion limit) are caught by the same hold.
    const pending: Array<{ node: Node; depth: number }> = [{ node: program, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++nodes > AST_NODES || current.depth > DEPTH) refuse('AST budget exceeded');
      for (const item of Object.values(current.node)) {
        const children: unknown[] = Array.isArray(item) ? item : [item];
        for (const child of children) {
          if (child && typeof child === 'object' && 'type' in child) {
            pending.push({ node: child as Node, depth: current.depth + 1 });
          }
        }
      }
    }

    const writes: InterpreterWrite[] = [];
    const functions = new Set<ArrowFunctionExpression>();
    const called = new Set<ArrowFunctionExpression>();
    let steps = 0;
    let values = 0;
    let valueBytes = 0;
    let callDepth = 0;
    let callbackDepth = 0;
    const tick = (): void => {
      if (++steps > STEPS) refuse('evaluation step budget exceeded');
    };
    const make = <T extends Value>(value: T): T => {
      if (++values > VALUES) refuse('abstract value budget exceeded');
      if (value.kind === 'primitive' && typeof value.value === 'string') {
        valueBytes += Buffer.byteLength(value.value, 'utf8');
        if (valueBytes > SOURCE_BYTES) refuse('abstract string budget exceeded');
      }
      return value;
    };
    const primitive = (value: Primitive): Value => make({ kind: 'primitive', value });
    const lookup = (name: string, env: Environment): Value => {
      for (let scope: Environment | undefined = env; scope; scope = scope.parent) {
        const value = scope.values.get(name);
        if (value) return value;
      }
      return refuse(`unknown identifier: ${name}`);
    };
    const data = (value: Value): void => {
      tick();
      if (value.kind === 'array') value.items.forEach(data);
      else if (value.kind === 'object') value.fields.forEach(data);
      else if (value.kind !== 'primitive' && value.kind !== 'opaque') {
        refuse('capability or function used as plain data');
      }
    };
    const text = (value: Value): string => {
      if (value.kind !== 'primitive' || typeof value.value !== 'string') {
        refuse('target or option is not a finite string');
      }
      return value.value;
    };
    const memberName = (node: Expression): string => {
      if (
        node.type !== 'MemberExpression' ||
        node.computed ||
        node.optional ||
        node.property.type !== 'Identifier' ||
        RESERVED.has(node.property.name)
      )
        refuse('unsupported property access');
      return node.property.name;
    };
    const isBuiltin = (node: Expression, name: string, env: Environment): boolean => {
      if (node.type !== 'Identifier' || node.name !== name) return false;
      for (let scope: Environment | undefined = env; scope; scope = scope.parent) {
        if (scope.values.has(name)) return false;
      }
      return true;
    };
    const apply = (fn: Value, args: Value[], mapCallback = false): Value => {
      if (fn.kind !== 'function') refuse('call target is not an admitted function');
      if (++callDepth > DEPTH) refuse('function depth budget exceeded');
      if (fn.node.params.length !== args.length) refuse('function arity is not modeled');
      called.add(fn.node);
      const local: Environment = { values: new Map(), parent: fn.env };
      fn.node.params.forEach((param, index) => {
        if (param.type !== 'Identifier' || !args[index]) refuse('unsupported function parameter');
        local.values.set(param.name, args[index]!);
      });
      if (mapCallback) callbackDepth++;
      const result =
        fn.node.body.type === 'BlockStatement'
          ? statements(fn.node.body.body, local, true)
          : expression(fn.node.body, local);
      if (mapCallback) callbackDepth--;
      callDepth--;
      return result;
    };
    const expression = (node: Expression, env: Environment): Value => {
      tick();
      switch (node.type) {
        case 'Literal':
          if (
            node.regex ||
            node.bigint ||
            (typeof node.value === 'object' && node.value !== null)
          ) {
            refuse('unsupported literal');
          }
          return primitive(node.value as Primitive);
        case 'Identifier':
          return lookup(node.name, env);
        case 'ArrayExpression': {
          const items = node.elements.map((item) => {
            if (!item || item.type === 'SpreadElement')
              refuse('array holes or spread are unsupported');
            const value = expression(item, env);
            data(value);
            return value;
          });
          return make({ kind: 'array', items });
        }
        case 'ObjectExpression': {
          const fields = new Map<string, Value>();
          for (const property of node.properties) {
            if (
              property.type !== 'Property' ||
              property.kind !== 'init' ||
              property.method ||
              property.computed
            ) {
              refuse('object accessors, methods, or spread are unsupported');
            }
            const key =
              property.key.type === 'Identifier'
                ? property.key.name
                : property.key.type === 'Literal' && typeof property.key.value === 'string'
                  ? property.key.value
                  : refuse('unsupported object key');
            if (RESERVED.has(key)) refuse('prototype-related object key');
            const value = expression(property.value, env);
            data(value);
            fields.set(key, value);
          }
          return make({ kind: 'object', fields });
        }
        case 'BinaryExpression': {
          if (node.operator !== '+' || node.left.type === 'PrivateIdentifier')
            refuse('unsupported operator');
          const left = expression(node.left, env);
          const right = expression(node.right, env);
          if (left.kind !== 'primitive' || right.kind !== 'primitive')
            refuse('implicit object coercion');
          if (typeof left.value === 'string' && typeof right.value === 'string') {
            return primitive(left.value + right.value);
          }
          if (typeof left.value === 'number' && typeof right.value === 'number') {
            return primitive(left.value + right.value);
          }
          return refuse('mixed primitive coercion is unsupported');
        }
        case 'ArrowFunctionExpression':
          if (
            node.async ||
            node.generator ||
            node.params.some((param) => param.type !== 'Identifier')
          ) {
            refuse('unsupported arrow function');
          }
          functions.add(node);
          return make({ kind: 'function', node, env });
        case 'MemberExpression': {
          const key = memberName(node);
          if (node.object.type === 'Super') refuse('super is unsupported');
          const object = expression(node.object, env);
          if (object.kind !== 'object' || !object.fields.has(key))
            refuse('property is not proven own plain data');
          return object.fields.get(key)!;
        }
        case 'CallExpression': {
          if (
            node.optional ||
            node.callee.type === 'Super' ||
            node.arguments.some((arg) => arg.type === 'SpreadElement')
          ) {
            refuse('unsupported call syntax');
          }
          const args = node.arguments as Expression[];
          if (isBuiltin(node.callee, 'require', env)) {
            if (
              args.length !== 1 ||
              args[0]?.type !== 'Literal' ||
              !['fs', 'node:fs'].includes(String(args[0].value))
            ) {
              refuse('only literal builtin fs require is admitted');
            }
            return make({ kind: 'fs' });
          }
          if (node.callee.type === 'MemberExpression') {
            const method = memberName(node.callee);
            const receiver = node.callee.object;
            if (receiver.type === 'Super') refuse('super is unsupported');
            if (isBuiltin(receiver, 'console', env) && method === 'log') {
              args.map((arg) => expression(arg, env)).forEach(data);
              return primitive(undefined);
            }
            if (isBuiltin(receiver, 'JSON', env) && method === 'stringify') {
              if (args.length !== 1) refuse('JSON replacer and spacing are unsupported');
              data(expression(args[0]!, env));
              // No concrete output is needed; never invoke host serialization on submitted values.
              return make({ kind: 'opaque' });
            }
            const object = expression(receiver, env);
            if (object.kind === 'fs') {
              if (
                !['readFileSync', 'readdirSync', 'writeFileSync', 'appendFileSync'].includes(method)
              ) {
                refuse('unsupported fs API');
              }
              const writing = method === 'writeFileSync' || method === 'appendFileSync';
              const min = writing ? 2 : 1;
              if (args.length < min || args.length > min + 1) refuse('unsupported fs call arity');
              const target = text(expression(args[0]!, env));
              if (target.includes('\0')) refuse('NUL in filesystem target');
              if (writing) data(expression(args[1]!, env));
              // Object options may override readFileSync flags and truncate a file.
              // Admit only encoding strings, never an options object or coercion.
              if (args[min]) text(expression(args[min]!, env));
              if (writing) {
                if (callbackDepth) refuse('filesystem writes in callbacks are unsupported');
                writes.push({
                  target,
                  operation: method === 'appendFileSync' ? 'append' : 'write',
                  start: args[0]!.start,
                  end: args[0]!.end,
                });
                return primitive(undefined);
              }
              return make({ kind: 'opaque' });
            }
            if (object.kind === 'array' && method === 'map') {
              if (args.length !== 1 || args[0]?.type !== 'ArrowFunctionExpression')
                refuse('map requires a direct arrow callback');
              const fn = expression(args[0], env);
              if (!object.items.length) refuse('empty map leaves callback behavior unproven');
              const items = object.items.map((item) => {
                const result = apply(fn, [item], true);
                data(result);
                return result;
              });
              return make({ kind: 'array', items });
            }
            return refuse('unsupported method call');
          }
          const fn = expression(node.callee, env);
          return apply(
            fn,
            args.map((arg) => expression(arg, env))
          );
        }
        default:
          return refuse(`unsupported expression: ${node.type}`);
      }
    };
    const statements = (body: Statement[], env: Environment, inFunction = false): Value => {
      let result = primitive(undefined);
      for (let index = 0; index < body.length; index++) {
        tick();
        const statement = body[index]!;
        if (statement.type === 'EmptyStatement') continue;
        if (statement.type === 'ExpressionStatement') expression(statement.expression, env);
        else if (statement.type === 'VariableDeclaration' && statement.kind === 'const') {
          for (const declaration of statement.declarations) {
            if (declaration.id.type !== 'Identifier' || !declaration.init)
              refuse('unsupported declaration');
            if (env.values.has(declaration.id.name)) refuse('duplicate declaration');
            const value = expression(declaration.init, env);
            if (
              value.kind === 'fs' &&
              !(
                declaration.init.type === 'CallExpression' &&
                isBuiltin(declaration.init.callee as Expression, 'require', env)
              )
            ) {
              refuse('aliased filesystem capability');
            }
            if (value.kind === 'function' && declaration.init.type !== 'ArrowFunctionExpression')
              refuse('aliased function');
            env.values.set(declaration.id.name, value);
          }
        } else if (
          statement.type === 'ReturnStatement' &&
          inFunction &&
          index === body.length - 1
        ) {
          result = statement.argument ? expression(statement.argument, env) : primitive(undefined);
        } else refuse(`unsupported statement: ${statement.type}`);
      }
      return result;
    };
    // Script parsing rejects import/export declarations; the cast narrows Acorn's
    // shared Program type, which also represents module programs.
    statements(program.body as Statement[], { values: new Map() });
    if ([...functions].some((fn) => !called.has(fn))) refuse('uninvoked function body is unproven');
    return writes.length
      ? { kind: 'finite-writes', profile: PROFILE, writes }
      : { kind: 'readonly', profile: PROFILE, writes: [] };
  } catch (error) {
    return {
      kind: 'unresolved',
      profile: null,
      writes: [],
      reason: error instanceof Error ? error.message : 'source analysis failed',
    };
  }
}
