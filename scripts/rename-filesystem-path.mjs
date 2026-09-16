import path from "node:path";
import { existsSync, readdirSync, renameSync } from "node:fs";

import {
    assertPathSegment,
    getScriptName,
    resolveProjectPath,
} from "./utility.mjs";

const [basePath, ...arguments_] = process.argv.slice(2);
const scriptName = getScriptName(import.meta.url);

if (
    !basePath ||
    (!arguments_.length || arguments_.length % 2 !== 0) ||
    !existsSync(basePath)
) {
    throw new Error(
        `Usage: node ${scriptName} <basePath> <sourcePath> <destinationPath> [...]`,
    );
}

const resolvedBasePath = resolveProjectPath(basePath);

for (let index = 0; index < arguments_.length; index += 2) {
    const sourcePath = assertPathSegment(arguments_[index], "source path");
    const destinationPath = assertPathSegment(arguments_[index + 1], "destination path");
    const destinationPaths = path.join(resolvedBasePath, destinationPath);

    const sourcePaths = readdirSync(resolvedBasePath).filter((entry) => {
        if (!sourcePath.includes("*")) {
            return entry === sourcePath;
        }

        const filesystemPattern = new RegExp(
            `^${sourcePath
                .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")}$`,
        );

        return filesystemPattern.test(entry);
    });

    if (sourcePaths.length !== 1) {
        throw new Error(
            `Expected exactly one match for filesystem path '${sourcePath}', found ${sourcePaths.length}.`,
        );
    }

    renameSync(
        path.join(resolvedBasePath, sourcePaths[0]),
        destinationPaths,
    );
}
