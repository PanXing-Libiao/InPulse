/** ADR-097：Casdoor 群组完整路径的解析结果；路径本身是唯一身份。 */
export interface CasdoorGroupPath {
  readonly owner: string;
  readonly path: string;
  readonly parentPath: string | null;
  readonly name: string;
  readonly depth: number;
}

export class InvalidCasdoorGroupPathError extends Error {
  constructor() {
    super("Casdoor group paths are invalid");
    this.name = "InvalidCasdoorGroupPathError";
  }
}

const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 20;
const MAX_SEGMENT_LENGTH = 100;

function characterLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 校验并规范化 Casdoor groups claim。只接受原始 owner/name 或
 * owner/parent.../name 路径，不裁剪、不改写大小写；返回结果按路径段数、
 * 再按字典序固定排序，保证并发事务以相同顺序创建父级组织。
 */
export function normalizeCasdoorGroupPaths(
  groups: readonly string[],
): readonly CasdoorGroupPath[] {
  if (!Array.isArray(groups)) {
    throw new InvalidCasdoorGroupPathError();
  }
  const seen = new Set<string>();
  const parsed: CasdoorGroupPath[] = [];
  for (const value of groups) {
    if (typeof value !== "string") {
      throw new InvalidCasdoorGroupPathError();
    }
    if (value.length === 0 || seen.has(value)) {
      throw new InvalidCasdoorGroupPathError();
    }
    seen.add(value);
    if (
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.includes("//") ||
      characterLength(value) > MAX_PATH_LENGTH
    ) {
      throw new InvalidCasdoorGroupPathError();
    }
    const segments = value.split("/");
    if (segments.length < 2 || segments.length > MAX_SEGMENTS) {
      throw new InvalidCasdoorGroupPathError();
    }
    for (const segment of segments) {
      const length = characterLength(segment);
      if (segment.trim().length === 0 || length > MAX_SEGMENT_LENGTH) {
        throw new InvalidCasdoorGroupPathError();
      }
    }
    const owner = segments[0]!;
    parsed.push({
      owner,
      path: value,
      parentPath:
        segments.length === 2 ? null : segments.slice(0, -1).join("/"),
      name: segments[segments.length - 1]!,
      depth: segments.length,
    });
  }
  return parsed.sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}

/** 展开每个直接群的祖先群组；owner 本身不是组织。 */
export function expandCasdoorGroupAncestors(
  groups: readonly CasdoorGroupPath[],
): readonly CasdoorGroupPath[] {
  const byPath = new Map<string, CasdoorGroupPath>();
  for (const group of groups) {
    const segments = group.path.split("/");
    for (let depth = 2; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join("/");
      byPath.set(path, {
        owner: segments[0]!,
        path,
        parentPath: depth === 2 ? null : segments.slice(0, depth - 1).join("/"),
        name: segments[depth - 1]!,
        depth,
      });
    }
  }
  return [...byPath.values()].sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}
