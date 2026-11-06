/* Stand-in for docker, journalctl and kubectl in fixit's log tests: not the real tools.
 * It appends its argv (one JSON line) to $STANDIN_ARGS and prints the file named by
 * $STANDIN_LOG: to stderr when called as docker (container stderr arrives there), else to
 * stdout. $STANDIN_EXIT makes it fail after printing. It ignores --since and --until,
 * so a test sees what fixit's own window filter does.
 */
"use strict";
const fs = require("fs");
module.exports = function run(tool) {
  if (process.env.STANDIN_ARGS) fs.appendFileSync(process.env.STANDIN_ARGS, JSON.stringify([tool, ...process.argv.slice(2)]) + "\n");
  const text = process.env.STANDIN_LOG ? fs.readFileSync(process.env.STANDIN_LOG, "utf8") : "";
  (tool === "docker" ? process.stderr : process.stdout).write(text);
  process.exitCode = Number(process.env.STANDIN_EXIT || 0);
};
