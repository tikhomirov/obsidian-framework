/** Р-034: board file `Проекты/<Проект>/Доска.md` — pure helpers (no Obsidian API). */
import { BOARD_FILE, boardMarkdown, boardPath, boardProjectFromFrontmatter } from "@of/core";

export interface NoteRef {
  path: string;
  name: string;
  /** Folder path, "" for the vault root. */
  folder: string;
  frontmatter: unknown;
}

function projectIdOf(fm: unknown): string | null {
  if (fm === null || typeof fm !== "object") return null;
  const o = fm as Record<string, unknown>;
  return o["type"] === "project" && typeof o["id"] === "string" ? o["id"] : null;
}

/** Folder of the project (where `Проект.md` with `id: <project>` lives). */
export function findProjectFolder(notes: NoteRef[], projectId: string): { folder: string; title: string } | null {
  for (const n of notes) {
    if (n.name !== "Проект.md" || projectIdOf(n.frontmatter) !== projectId) continue;
    const title = (n.frontmatter as Record<string, unknown>)["title"];
    return { folder: n.folder, title: typeof title === "string" && title ? title : projectId };
  }
  return null;
}

/**
 * Project id when `note` is a board: frontmatter `type: board` + `project`, or (before the metadata
 * cache is ready) a file named `Доска.md` next to a `Проект.md`.
 */
export function boardProjectOf(note: NoteRef, siblingProjectFrontmatter: unknown): string | null {
  const fromFm = boardProjectFromFrontmatter(note.frontmatter);
  if (fromFm !== null) return fromFm;
  if (note.name !== BOARD_FILE) return null;
  return projectIdOf(siblingProjectFrontmatter);
}

export function boardFileFor(folder: string, project: { id: string; title: string }): { path: string; content: string } {
  return { path: boardPath(folder), content: boardMarkdown(project) };
}
