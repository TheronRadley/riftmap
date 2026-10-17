/**
 * Minimal, dependency-free runtime validation.
 *
 * Every boundary in Riftmap (native engine stdout, IPC payloads, parsed Git
 * output) is untrusted input. These helpers fail loudly with a path-qualified
 * message instead of letting malformed data leak into the analysis model.
 */

export class ValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path === '$' ? '$' : path}: ${message}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

type Obj = Record<string, unknown>;

export function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function obj(value: unknown, path: string): Obj {
  if (!isObject(value)) throw new ValidationError(path, 'expected an object');
  return value;
}

export function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ValidationError(path, `expected a string, got ${kind(value)}`);
  return value;
}

export function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(path, `expected a finite number, got ${kind(value)}`);
  }
  return value;
}

export function int(value: unknown, path: string): number {
  const n = num(value, path);
  if (!Number.isInteger(n)) throw new ValidationError(path, 'expected an integer');
  return n;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(path, `expected a boolean, got ${kind(value)}`);
  return value;
}

export function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(path, `expected an array, got ${kind(value)}`);
  return value as unknown[];
}

export function nullable<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T | null {
  if (value === null || value === undefined) return null;
  return read(value, path);
}

export function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const s = str(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw new ValidationError(path, `expected one of ${allowed.join('|')}, got "${s}"`);
  }
  return s as T;
}

export function field(source: Obj, path: string, key: string): unknown {
  if (!(key in source)) throw new ValidationError(`${path}.${key}`, 'is missing');
  return source[key];
}

export function optField<T>(source: Obj, path: string, key: string, read: (v: unknown, p: string) => T, fallback: T): T {
  if (!(key in source) || source[key] === null || source[key] === undefined) return fallback;
  return read(source[key], `${path}.${key}`);
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Parses a JSON string and validates it with `read`. Both JSON syntax errors
 * and shape errors are reported as `ValidationError` so callers have a single
 * failure mode to handle.
 */
export function parseJson<T>(text: string, read: (value: unknown, path: string) => T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError('$', `invalid JSON (${(error as Error).message})`);
  }
  return read(parsed, '$');
}
