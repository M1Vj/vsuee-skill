import { spawnSync } from "node:child_process";
import {
    constants,
    copyFileSync,
    mkdtempSync,
    readdirSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    getNpmCli,
    getScriptName,
    resolveProjectPath,
} from "./utility.mjs";

export function copyPackedTarballExclusive(sourcePath, destinationPath) {
    copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
}

export function packTarball(inputPath, outputPath) {
    const resolvedInputPath = resolveProjectPath(inputPath);
    const resolvedOutputPath = resolveProjectPath(outputPath);
    const stagingDirectory = mkdtempSync(path.join(tmpdir(), "vsuee-pack-"));

    try {
        const result = spawnSync(
            getNpmCli(),
            [
                "pack",
                resolvedInputPath,
                "--pack-destination",
                stagingDirectory,
            ],
            {
                stdio: "inherit",
            },
        );

        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            return result.status ?? 1;
        }

        const stagedFiles = readdirSync(stagingDirectory);
        if (stagedFiles.length !== 1 || !stagedFiles[0].endsWith(".tgz")) {
            throw new Error("npm pack did not create exactly one tarball.");
        }

        copyPackedTarballExclusive(
            path.join(stagingDirectory, stagedFiles[0]),
            path.join(resolvedOutputPath, stagedFiles[0]),
        );
        return 0;
    } finally {
        rmSync(stagingDirectory, { recursive: true, force: true });
    }
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    const scriptName = getScriptName(import.meta.url);
    const [inputPath, outputPath, ...unexpectedArguments] = process.argv.slice(2);

    if (!inputPath || !outputPath || unexpectedArguments.length > 0) {
        throw new Error(
            `Usage: node ${scriptName} <inputPath> <outputPath>`,
        );
    }

    process.exit(packTarball(inputPath, outputPath));
}
