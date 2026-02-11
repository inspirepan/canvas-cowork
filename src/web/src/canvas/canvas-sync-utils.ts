import type { CanvasFSEvent } from "../../../shared/protocol.js";

export interface MovePair {
  deleteEvent: CanvasFSEvent;
  createEvent: CanvasFSEvent;
}

interface MoveMeta {
  size?: number;
  mtimeMs?: number;
  content?: string;
}

export function ensureUniquePath(
  desiredPath: string,
  existingPaths: Set<string>,
  reservedPath?: string,
): string {
  const isTaken = (path: string) => existingPaths.has(path) && path !== reservedPath;
  if (!isTaken(desiredPath)) return desiredPath;

  const slashIdx = desiredPath.lastIndexOf("/");
  const dir = slashIdx >= 0 ? desiredPath.slice(0, slashIdx) : "";
  const filename = slashIdx >= 0 ? desiredPath.slice(slashIdx + 1) : desiredPath;
  const dotIdx = filename.lastIndexOf(".");
  const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";

  let counter = 1;
  while (true) {
    const nextName = `${base}-${counter}${ext}`;
    const candidate = dir ? `${dir}/${nextName}` : nextName;
    if (!isTaken(candidate)) return candidate;
    counter++;
  }
}

export function detectMovesEnhanced(
  deletes: CanvasFSEvent[],
  creates: CanvasFSEvent[],
  metaByPath: Map<string, MoveMeta>,
): MovePair[] {
  const moves: MovePair[] = [];
  const usedCreates = new Set<number>();

  const getFileName = (path: string) => path.split("/").pop() ?? path;
  const getExt = (path: string) => {
    const dotIdx = path.lastIndexOf(".");
    return dotIdx >= 0 ? path.slice(dotIdx + 1).toLowerCase() : "";
  };
  const metaMatches = (delMeta: MoveMeta, create: CanvasFSEvent) => {
    if (delMeta.content !== undefined && create.content !== undefined) {
      return delMeta.content === create.content;
    }
    if (delMeta.size === undefined || create.size === undefined) return false;
    if (delMeta.mtimeMs === undefined || create.mtimeMs === undefined) return false;
    return (
      delMeta.size === create.size && Math.round(delMeta.mtimeMs) === Math.round(create.mtimeMs)
    );
  };

  for (const del of deletes) {
    if (del.isDirectory) continue;
    const delFile = getFileName(del.path);

    let matchedIndex = -1;
    for (let i = 0; i < creates.length; i++) {
      if (usedCreates.has(i)) continue;
      const create = creates[i];
      if (create.isDirectory) continue;
      if (del.path !== create.path && delFile === getFileName(create.path)) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex >= 0) {
      usedCreates.add(matchedIndex);
      moves.push({ deleteEvent: del, createEvent: creates[matchedIndex] });
      continue;
    }

    const delMeta = metaByPath.get(del.path);
    if (!delMeta) continue;
    const delExt = getExt(del.path);

    let candidateIndex = -1;
    for (let i = 0; i < creates.length; i++) {
      if (usedCreates.has(i)) continue;
      const create = creates[i];
      if (create.isDirectory) continue;
      if (delExt !== getExt(create.path)) continue;
      if (!metaMatches(delMeta, create)) continue;
      if (candidateIndex >= 0) {
        candidateIndex = -1;
        break;
      }
      candidateIndex = i;
    }

    if (candidateIndex >= 0) {
      usedCreates.add(candidateIndex);
      moves.push({ deleteEvent: del, createEvent: creates[candidateIndex] });
    }
  }

  return moves;
}

export function buildCacheBustedSrc(relPath: string, mtimeMs?: number): string {
  const version = mtimeMs !== undefined ? Math.round(mtimeMs) : Date.now();
  return `/canvas/${relPath}?v=${version}`;
}
