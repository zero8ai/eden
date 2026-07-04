/**
 * Pure read/write helpers for markdown-form eve schedules (`agent/schedules/<name>.md`):
 * YAML frontmatter declaring `cron`, body = the fire-and-forget message the agent receives
 * when it fires (eve@0.18 `lowerScheduleMarkdown`). Unknown frontmatter keys are preserved
 * verbatim on save — the editor owns only `cron` and the body.
 */

export interface ScheduleFile {
  cron: string;
  /** The prompt sent to the agent when the schedule fires. */
  message: string;
  /** Frontmatter lines other than cron, preserved as written. */
  extraFrontmatter: string[];
}

export function parseScheduleFile(source: string): ScheduleFile {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { cron: "", message: source.trim(), extraFrontmatter: [] };

  let cron = "";
  const extraFrontmatter: string[] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const cm = line.match(/^cron:\s*(.*)$/);
    if (cm) {
      cron = cm[1].trim().replace(/^["']|["']$/g, "");
    } else if (line.trim()) {
      extraFrontmatter.push(line);
    }
  }
  return { cron, message: m[2].trim(), extraFrontmatter };
}

export function buildScheduleFile(file: ScheduleFile): string {
  const frontmatter = [`cron: "${file.cron}"`, ...file.extraFrontmatter].join("\n");
  return `---\n${frontmatter}\n---\n\n${file.message.trim()}\n`;
}
