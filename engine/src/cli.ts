import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
// Papilot starts the review server through client.ts; this is its entry point.
export async function main(argv = process.argv) {
  const program = new Command()
    .name("review-engine")
    .description("Papilot's review server for LaTeX edits as PDF diffs.")
    .exitOverride();
  program
    .command("serve")
    .requiredOption("--root <path>")
    .option("--port <number>", "", "0")
    .option("--idle <seconds>", "", "43200")
    .action(async (options: { root: string; port: string; idle: string }) => {
      const { serve } = await import("./server.ts");
      await serve(options.root, Number(options.port), Number(options.idle));
      // The server has released its lock. Work it no longer serves, such as
      // queued reference checks, must not keep this process running.
      process.exit(0);
    });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    console.log(JSON.stringify({ error: (error as Error).message }));
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
