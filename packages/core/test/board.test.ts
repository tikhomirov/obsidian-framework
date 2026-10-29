import { describe, expect, it } from "vitest";
import { BOARD_FILE, boardMarkdown, boardPath, boardProjectFromFrontmatter } from "../src/index.js";

describe("board file (Р-034)", () => {
  it("renders a marker file with type/project", () => {
    const md = boardMarkdown({ id: "of", title: "Obsidian Framework" });
    expect(md.startsWith("---\ntype: board\nproject: of\n")).toBe(true);
    expect(md).toContain("# Доска — Obsidian Framework");
  });
  it("detects a board by frontmatter", () => {
    expect(boardProjectFromFrontmatter({ type: "board", project: "of" })).toBe("of");
    expect(boardProjectFromFrontmatter({ type: "task", project: "of" })).toBeNull();
    expect(boardProjectFromFrontmatter({ type: "board", project: "Bad Id" })).toBeNull();
    expect(boardProjectFromFrontmatter({ type: "board" })).toBeNull();
    expect(boardProjectFromFrontmatter(null)).toBeNull();
    expect(boardProjectFromFrontmatter("x")).toBeNull();
  });
  it("builds the path in the project root", () => {
    expect(BOARD_FILE).toBe("Доска.md");
    expect(boardPath("Проекты/Obsidian Framework/")).toBe("Проекты/Obsidian Framework/Доска.md");
  });
});
