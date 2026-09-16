import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getNpmCli, getScriptName } from "./utility.mjs";

export function runScripts(scripts, { spawnSyncImpl = spawnSync } = {}) {
    if (!Array.isArray(scripts) || scripts.length === 0) {
        throw new Error(
            `Usage: node ${getScriptName(import.meta.url)} <script> [...]`,
        );
    }

    for (const script of scripts) {
        if (typeof script !== "string" || !/^[A-Za-z0-9._:-]+$/.test(script)) {
            throw new Error(`Invalid npm script name '${script}'.`);
        }

        const result = spawnSyncImpl(
            getNpmCli(),
            ["run", script],
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
    }

    return 0;
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    process.exit(runScripts(process.argv.slice(2)));
}
