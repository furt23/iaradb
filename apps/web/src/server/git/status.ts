/** Parsing of `git status --porcelain=v1 --branch -z` (pure; unit tested). */

export interface GitFile {
  path: string;
  /** staged change: M A D R C or space */
  index: string;
  /** unstaged change: M D or ?, space */
  worktree: string;
  /** source path of a rename/copy */
  from?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

function parseBranch(line: string): Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind"> {
  // "## main...origin/main [ahead 1, behind 2]" | "## No commits yet on main" | "## HEAD (no branch)"
  const body = line.slice(3);
  const noCommits = body.match(/^No commits yet on (.+)$/);
  if (noCommits) return { branch: noCommits[1], upstream: null, ahead: 0, behind: 0 };
  const m = body.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
  const branch = m?.[1] === "HEAD (no branch)" ? null : (m?.[1] ?? null);
  const counts = m?.[3] ?? "";
  return {
    branch,
    upstream: m?.[2] ?? null,
    ahead: Number(counts.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(counts.match(/behind (\d+)/)?.[1] ?? 0),
  };
}

export function parseStatus(output: string): GitStatus {
  const records = output.split("\0");
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith("## ")) {
      Object.assign(status, parseBranch(r));
      continue;
    }
    const file: GitFile = { index: r[0], worktree: r[1], path: r.slice(3) };
    if (file.index === "R" || file.index === "C") file.from = records[++i];
    status.files.push(file);
  }
  return status;
}
