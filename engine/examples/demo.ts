// The example paper and the agent's edits to it, for the end-to-end and
// browser tests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/core/git.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
export interface DemoPlan {
  task: string;
  title: string;
  section: string;
  edits: { file: string; old: string; new: string }[];
}
export function prepareDemo(base: string) {
  const root = path.join(base, "example-paper");
  if (fs.existsSync(root))
    throw new Error(`${root} already exists; choose another --dir.`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(here, "paper"), path.join(root, "paper"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    "*.aux\n*.log\n*.pdf\n*.synctex.gz\n*.fdb_latexmk\n*.fls\n*.out\n",
  );
  const repo = new Repo(root);
  repo.run(["init", "-q"]);
  repo.run(["add", "."]);
  repo.run([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@localhost",
    "commit",
    "-qm",
    "Example paper",
  ]);
  return {
    root,
    plan: JSON.parse(
      fs.readFileSync(path.join(here, "agent-edits.json"), "utf8"),
    ) as DemoPlan,
  };
}
export function applyDemo(worktree: string, plan: DemoPlan) {
  for (const edit of plan.edits) {
    const file = path.join(worktree, edit.file),
      text = fs.readFileSync(file, "utf8");
    if (!text.includes(edit.old))
      throw new Error(`Edit not applicable: ${edit.file}`);
    fs.writeFileSync(file, text.replace(edit.old, edit.new));
  }
}
