/**
 * Project board file (Р-034): `Проекты/<Проект>/Доска.md` in the project root, next to `Проект.md`.
 * The file is only a marker: the plugin renders the board from the server API. It is never a task.
 */
export const BOARD_FILE = "Доска.md";
export const BOARD_BASENAME = "Доска";
export const BOARD_TYPE = "board";

export interface BoardProjectRef {
  id: string;
  title: string;
}

/** Canonical content of a new board file. */
export function boardMarkdown(project: BoardProjectRef): string {
  return [
    "---",
    `type: ${BOARD_TYPE}`,
    `project: ${project.id}`,
    `title: ${JSON.stringify(`Доска — ${project.title}`)}`,
    "---",
    `# Доска — ${project.title}`,
    "",
    "Этот файл плагин Obsidian Framework открывает как доску задач проекта.",
    "Задачи лежат в папке `Задачи/`; статусы меняются только через доску или API.",
    "",
  ].join("\n");
}

/** Project id of a board file, from its parsed frontmatter, or null when the file is not a board. */
export function boardProjectFromFrontmatter(frontmatter: unknown): string | null {
  if (frontmatter === null || typeof frontmatter !== "object") return null;
  const fm = frontmatter as Record<string, unknown>;
  if (fm["type"] !== BOARD_TYPE) return null;
  const project = fm["project"];
  return typeof project === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(project) ? project : null;
}

/** Path of the board file inside a project folder (vault-relative or absolute, `/` separators). */
export function boardPath(projectFolder: string): string {
  return `${projectFolder.replace(/\/+$/, "")}/${BOARD_FILE}`;
}
