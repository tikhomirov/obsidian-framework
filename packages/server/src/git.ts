/**
 * Server-side read-only clone per project (Р-008/Р-020): commit verification
 * (`fetch` + `cat-file` + `branch -r --contains`) and a work tree for Pi stages.
 * The server never pushes.
 */
import { join } from "node:path";
import type { Project } from "@of/core";
import { exists, readText, writeTextAtomic } from "./fsutil.js";
import type { Exec } from "./runners/process.js";
import type { CommitVerifier } from "./service.js";

export interface GitMirrorOptions {
  clonesDir: string;
  gitBin: string;
  exec: Exec;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

export class GitMirror implements CommitVerifier {
  constructor(private readonly opts: GitMirrorOptions) {}

  clonePath(project: Project): string {
    return join(this.opts.clonesDir, project.id);
  }

  private async git(cwd: string | undefined, args: string[], timeoutMs = 120_000): Promise<string> {
    const r = await this.opts.exec(this.opts.gitBin, args, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0) throw new GitError(`git ${args[0] ?? ""} failed: ${r.stderr.trim().slice(0, 500)}`);
    return r.stdout;
  }

  /** Clone on first use, fetch afterwards. */
  async sync(project: Project): Promise<string> {
    if (!project.repo) throw new GitError(`Project ${project.id} has no repo`);
    const dir = this.clonePath(project);
    if (await exists(join(dir, ".git"))) {
      await this.git(dir, ["fetch", "--prune", "origin"]);
    } else {
      await this.git(undefined, ["clone", "--no-checkout", project.repo, dir], 600_000);
    }
    return dir;
  }

  async remoteBranchExists(project: Project, branch: string): Promise<boolean> {
    if (!SAFE_REF.test(branch)) return false;
    const r = await this.opts.exec(this.opts.gitBin, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], {
      cwd: this.clonePath(project),
    });
    return r.code === 0;
  }

  async verify(project: Project, sha: string, branch: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha) || !SAFE_REF.test(branch)) return false;
    const dir = await this.sync(project);
    const exists = await this.opts.exec(this.opts.gitBin, ["cat-file", "-e", `${sha}^{commit}`], { cwd: dir });
    if (exists.code !== 0) return false;
    const contains = await this.opts.exec(this.opts.gitBin, ["branch", "-r", "--contains", sha], { cwd: dir });
    if (contains.code !== 0) return false;
    return contains.stdout.split("\n").some((l) => l.trim() === `origin/${branch}`);
  }

  /** Clean detached checkout of the task branch (if pushed) or the default branch. */
  async prepareWorktree(project: Project, branch: string | null): Promise<{ dir: string; ref: string }> {
    const dir = await this.sync(project);
    const useBranch = branch !== null && (await this.remoteBranchExists(project, branch));
    const ref = `origin/${useBranch ? branch : project.defaultBranch}`;
    await this.git(dir, ["checkout", "--force", "--detach", ref]);
    await this.git(dir, ["clean", "-fd"]);
    return { dir, ref };
  }

  async readFile(project: Project, relPath: string): Promise<string | null> {
    if (relPath.includes("..")) return null;
    return readText(join(this.clonePath(project), relPath));
  }

  async writeFile(project: Project, relPath: string, text: string): Promise<void> {
    if (relPath.includes("..")) throw new GitError("invalid path");
    await writeTextAtomic(join(this.clonePath(project), relPath), text);
  }
}
