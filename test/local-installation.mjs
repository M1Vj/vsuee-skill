import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getNpmCli } from "../scripts/utility.mjs";

export function createIsolatedNpmEnvironment(
    installationDirectory,
    sourceEnvironment = process.env,
) {
    const environment = Object.fromEntries(
        Object.entries(sourceEnvironment).filter(
            ([key]) => !key.toLowerCase().startsWith("npm_config_"),
        ),
    );

    return {
        ...environment,
        npm_config_cache: join(installationDirectory, ".npm-cache"),
        npm_config_global: "false",
        npm_config_globalconfig: join(installationDirectory, "global.npmrc"),
        npm_config_include_workspace_root: "false",
        npm_config_prefix: join(installationDirectory, "global"),
        npm_config_userconfig: join(installationDirectory, ".npmrc"),
        npm_config_workspaces: "false",
    };
}

export function createLocalInstallArguments(installationDirectory, packagePath) {
    return [
        "install",
        "--global=false",
        "--workspaces=false",
        "--include-workspace-root=false",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-save",
        "--prefix",
        installationDirectory,
        packagePath,
    ];
}

const run = (command, args, options) =>
    new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            ...options,
            stdio: "inherit",
        });

        child.on("error", reject);

        child.on("close", (code) => {
            if (code === 0) {
                resolvePromise();
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });
    });

export async function verifyLocalInstallation(packagePathArgument) {
    const packagePath = resolve(packagePathArgument);
    await access(packagePath);

    const installationDirectory = await mkdtemp(
        join(tmpdir(), "vsuee-skill-install-"),
    );
    const npmEnvironment = createIsolatedNpmEnvironment(installationDirectory);

    try {
        await writeFile(
            join(installationDirectory, "package.json"),
            JSON.stringify({ private: true }),
            "utf8",
        );
        await writeFile(join(installationDirectory, ".npmrc"), "", "utf8");
        await writeFile(join(installationDirectory, "global.npmrc"), "", "utf8");

        await run(
            getNpmCli(),
            createLocalInstallArguments(installationDirectory, packagePath),
            {
                cwd: installationDirectory,
                env: npmEnvironment,
            },
        );

        const installedCli = join(
            installationDirectory,
            "node_modules",
            "vsuee-skill",
            "bin",
            "vsuee.mjs",
        );
        await access(installedCli);

        await run(process.execPath, [installedCli, "--help"], {
            cwd: installationDirectory,
            env: npmEnvironment,
        });
    } finally {
        await rm(installationDirectory, {
            recursive: true,
            force: true,
        });
    }
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    const [, , packagePathArgument, ...unexpectedArguments] = process.argv;
    if (!packagePathArgument || unexpectedArguments.length > 0) {
        console.error("Usage: node local-installation.mjs <package-path>");
        process.exit(1);
    }

    await verifyLocalInstallation(packagePathArgument);
}
