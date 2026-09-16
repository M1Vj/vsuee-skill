import path from "node:path";
import { cpSync } from "node:fs";

import { getScriptName, resolveProjectPath } from "./utility.mjs";

const scriptName = getScriptName(import.meta.url);
const [outputPath, ...inputPaths] = process.argv.slice(2);

if (!outputPath || !inputPaths.length) {
    throw new Error(
        `Usage: node ${scriptName} <outputPath> <inputPath> [...]`,
    );
}

const resolvedOutputPath = resolveProjectPath(outputPath);

for (const inputPath of inputPaths) {
    const resolvedInputPath = resolveProjectPath(inputPath);
    cpSync(
        resolvedInputPath,
        path.join(resolvedOutputPath, path.basename(resolvedInputPath)),
        {
            recursive: true,
        },
    );
}
