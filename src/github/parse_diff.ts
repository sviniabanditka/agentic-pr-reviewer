import type { FileStatus, RawPatchFile } from "../../src/review/diff.js";

const HEADER_PATTERN = /^diff --git a\/(.+) b\/(.+)$/;

/** git emits one text for all files, with "diff --git" marking each boundary. */
export function parseDiffOutput(raw: string): RawPatchFile[] {
  if (raw.trim().length === 0) return [];

  const chunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of raw.split("\n")) {
    if (HEADER_PATTERN.test(line)) chunks.push((current = []));
    current?.push(line);
  }

  return chunks.map((chunk) => parseOneFile(chunk.join("\n")));
}

function parseOneFile(text: string): RawPatchFile {
  const lines = text.split("\n");
  const header = HEADER_PATTERN.exec(lines[0] ?? "");
  const aPath = header?.[1];
  const bPath = header?.[2];
  if (aPath === undefined || bPath === undefined) {
    throw new Error(`unrecognized diff chunk: ${lines[0]}`);
  }

  let status: FileStatus = "modified";
  let oldPath: string | undefined;
  let isBinary = false;
  let patchStart = -1;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("new file mode")) {
      status = "added";
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      // bPath already carries the new path from the header.
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true;
    } else if (line.startsWith("@@ ")) {
      patchStart = i;
      break;
    }
  }

  const path = status === "deleted" ? aPath : bPath;
  if (status === "modified" && aPath !== bPath) {
    // find-renames without a "rename from/to" pair (git still emits a full diff@---/+++).
    status = "renamed";
    oldPath = aPath;
  }

  let additions = 0;
  let deletions = 0;
  let patch: string | undefined;
  if (!isBinary && patchStart !== -1) {
    patch = lines.slice(patchStart).join("\n");
    for (const line of lines.slice(patchStart)) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }

  return {
    path,
    ...(oldPath !== undefined ? { oldPath } : {}),
    status,
    additions,
    deletions,
    ...(patch !== undefined ? { patch } : {}),
  };
}
