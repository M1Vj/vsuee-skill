import { rmSync } from "node:fs";

import { getScriptName, resolveProjectPath } from "./utility.mjs";

const inputPath = process.argv[2];
const scriptName = getScriptName(import.meta.url);

if (!inputPath) {
    throw new Error(
        `Usage: node ${scriptName} <inputPath>`,
    );
}

rmSync(resolveProjectPath(inputPath), {
    recursive: true,
    force: true,
});
