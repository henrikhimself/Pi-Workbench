import { copyFileSync } from "node:fs";

const [current, incoming] = process.argv.slice(2);
if (!current || !incoming) process.exit(2);
copyFileSync(incoming, current);
