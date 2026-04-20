export function removeCircularReferences<T>(obj: T, maxDepth: number = 10): T {
  const seen = new WeakSet();

  function clean(value: unknown, depth: number): unknown {
    if (depth > maxDepth) {
      return '[Max Depth Reached]';
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (seen.has(value as object)) {
      return '[Circular Reference]';
    }

    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map(item => clean(item, depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = clean(val, depth + 1);
    }

    return result;
  }

  return clean(obj, 0) as T;
}
