import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runScripts } from "../scripts/run-scripts.mjs";
import { copyPackedTarballExclusive } from "../scripts/npm-pack-tarball.mjs";
import { resolveProjectPath } from "../scripts/utility.mjs";
import {
    createIsolatedNpmEnvironment,
    createLocalInstallArguments,
} from "./local-installation.mjs";
import {
    EXPECTED_PACKAGE_FILES,
    verifyPackageTarball,
} from "./release-package-content.mjs";

const BLOCK_SIZE = 512;

function createTarHeader(name, { size = 0, type = "0", sizeText } = {}) {
    const header = Buffer.alloc(BLOCK_SIZE);
    header.write(name, 0, 100, "utf8");
    header.write(sizeText ?? size.toString(8).padStart(11, "0"), 124, 11, "ascii");
    header[135] = 0;
    header[156] = type.charCodeAt(0);
    header.fill(0x20, 148, 156);

    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function createTar(entries) {
    const blocks = [];
    for (const entry of entries) {
        const payload = entry.payload ?? Buffer.alloc(entry.size ?? 0);
        blocks.push(createTarHeader(entry.name, {
            ...entry,
            size: entry.size ?? payload.length,
        }));
        blocks.push(payload);
        const padding = Math.ceil(payload.length / BLOCK_SIZE) * BLOCK_SIZE
            - payload.length;
        if (padding > 0) {
            blocks.push(Buffer.alloc(padding));
        }
    }
    blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
    return Buffer.concat(blocks);
}

function createCanonicalEntries() {
    return EXPECTED_PACKAGE_FILES.map((name) => {
        if (name === "package/package.json" || name === "package/plugin.json") {
            return {
                name,
                payload: Buffer.from(JSON.stringify({
                    name: "vsuee-skill",
                    version: "1.0.1",
                })),
            };
        }
        return { name };
    });
}

test("staged workflow stops after the first failed script", () => {
    const executed = [];
    const exitCode = runScripts(["fail-release-step", "must-not-run"], {
        spawnSyncImpl(_npm, [, script]) {
            executed.push(script);
            return { status: script === "fail-release-step" ? 17 : 0 };
        },
    });

    assert.equal(exitCode, 17);
    assert.deepEqual(executed, ["fail-release-step"]);
});

test("publish workflow accepts canonical release tags only", () => {
    const workflow = readFileSync(
        new URL("../.github/workflows/publish.yml", import.meta.url),
        "utf8",
    );

    assert.match(workflow, /tags:\s*\n\s+- "v\*"/);
    assert.doesNotMatch(workflow, /^\s+branches:/m);
    assert.match(workflow, /if: github\.repository == 'M1Vj\/vsuee-skill'/);
    assert.match(workflow, /expected_tag="v\$\{package_version\}"/);
    assert.match(workflow, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/);
    assert.match(
        workflow,
        /npm stage publish \.tmp\/build\/release\/dist\/vsuee-skill\.tgz/,
    );
});

test("release workflows pin third-party actions to immutable commits", () => {
    for (const workflowPath of ["feature.yml", "publish.yml"]) {
        const workflow = readFileSync(
            new URL(`../.github/workflows/${workflowPath}`, import.meta.url),
            "utf8",
        );
        const references = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)]
            .map((match) => match[1]);

        assert.ok(references.length > 0, `${workflowPath} must use actions`);
        for (const reference of references) {
            assert.match(
                reference,
                /^[^@]+@[0-9a-f]{40}$/,
                `${workflowPath} has a mutable action reference: ${reference}`,
            );
        }
    }
});

test("filesystem helpers reject parent and symlink escapes", () => {
    assert.throws(() => resolveProjectPath(".."), /inside the project workspace/);
    assert.throws(() => resolveProjectPath("."), /inside the project workspace/);

    mkdirSync(".tmp", { recursive: true });
    const projectSandbox = mkdtempSync(path.join(".tmp", "path-guard-"));
    const externalSandbox = mkdtempSync(path.join(tmpdir(), "vsuee-external-"));
    const escapePath = path.join(projectSandbox, "escape");

    try {
        symlinkSync(externalSandbox, escapePath, "junction");
        assert.throws(
            () => resolveProjectPath(path.join(escapePath, "child")),
            /outside the project workspace/,
        );
    } finally {
        rmSync(projectSandbox, { recursive: true, force: true });
        rmSync(externalSandbox, { recursive: true, force: true });
    }
});

test("local installation verifier does not accept a deletion target", () => {
    const markerDirectory = mkdtempSync(
        path.join(tmpdir(), "vsuee-install-marker-"),
    );
    const markerPath = path.join(markerDirectory, "keep.txt");
    writeFileSync(markerPath, "preserve", "utf8");

    try {
        const result = spawnSync(
            process.execPath,
            [
                "test/local-installation.mjs",
                "missing-package.tgz",
                markerDirectory,
            ],
            { encoding: "utf8" },
        );

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(markerPath), true);
    } finally {
        rmSync(markerDirectory, { recursive: true, force: true });
    }
});

test("local installation ignores inherited npm routing configuration", () => {
    const installationDirectory = path.join(tmpdir(), "isolated-install");
    const environment = createIsolatedNpmEnvironment(installationDirectory, {
        PATH: "/test/bin",
        npm_config_global: "true",
        NPM_CONFIG_PREFIX: "/opt/homebrew",
        npm_config_workspace: "other-package",
    });

    assert.equal(environment.PATH, "/test/bin");
    assert.equal(environment.NPM_CONFIG_PREFIX, undefined);
    assert.equal(environment.npm_config_workspace, undefined);
    assert.equal(environment.npm_config_global, "false");
    assert.equal(environment.npm_config_workspaces, "false");
    assert.equal(environment.npm_config_prefix, path.join(installationDirectory, "global"));

    const argumentsList = createLocalInstallArguments(
        installationDirectory,
        "/tmp/vsuee-skill.tgz",
    );
    assert.ok(argumentsList.includes("--global=false"));
    assert.ok(argumentsList.includes("--workspaces=false"));
    assert.deepEqual(
        argumentsList.slice(argumentsList.indexOf("--prefix"), -1),
        ["--prefix", installationDirectory],
    );
});

test("tarball copy rejects existing and dangling destination symlinks", (t) => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "vsuee-pack-link-"));
    const sourcePath = path.join(sandbox, "source.tgz");
    const existingTarget = path.join(sandbox, "preserve.txt");
    const danglingTarget = path.join(sandbox, "missing.txt");
    const destinationPath = path.join(sandbox, "vsuee-skill-1.0.1.tgz");
    writeFileSync(sourcePath, "new package", "utf8");
    writeFileSync(existingTarget, "preserve", "utf8");

    try {
        try {
            symlinkSync(existingTarget, destinationPath, "file");
        } catch (error) {
            if (error.code === "EPERM") {
                t.skip("File symlinks are unavailable on this platform.");
                return;
            }
            throw error;
        }

        assert.throws(
            () => copyPackedTarballExclusive(sourcePath, destinationPath),
            /EEXIST/,
        );
        assert.equal(readFileSync(existingTarget, "utf8"), "preserve");

        rmSync(destinationPath);
        symlinkSync(danglingTarget, destinationPath, "file");
        assert.throws(
            () => copyPackedTarballExclusive(sourcePath, destinationPath),
            /EEXIST/,
        );
        assert.equal(existsSync(danglingTarget), false);
    } finally {
        rmSync(sandbox, { recursive: true, force: true });
    }
});

test("package verifier accepts exactly the expected regular files", () => {
    const tarball = createTar(createCanonicalEntries());
    assert.deepEqual(verifyPackageTarball(tarball), EXPECTED_PACKAGE_FILES);
});

test("package verifier rejects extra links", () => {
    const tarball = createTar([
        ...createCanonicalEntries(),
        { name: "package/extra-link", type: "2" },
    ]);
    assert.throws(() => verifyPackageTarball(tarball), /entry type/);
});

test("package verifier rejects truncated payloads", () => {
    const entries = createCanonicalEntries();
    entries.at(-1).size = 2048;
    entries.at(-1).payload = Buffer.alloc(0);
    assert.throws(
        () => verifyPackageTarball(createTar(entries)),
        /Truncated tar payload/,
    );
});

test("package verifier rejects malformed sizes", () => {
    const entries = createCanonicalEntries();
    entries[0].sizeText = "not-octal";
    assert.throws(
        () => verifyPackageTarball(createTar(entries)),
        /Invalid size field/,
    );
});

test("package verifier rejects duplicate entries", () => {
    const tarball = createTar([
        ...createCanonicalEntries(),
        { name: EXPECTED_PACKAGE_FILES[0] },
    ]);
    assert.throws(() => verifyPackageTarball(tarball), /Duplicate files/);
});

test("package verifier preserves exact filename whitespace", () => {
    for (const replacement of [
        " package/skills/vsuee/SKILL.md",
        "package/skills/vsuee/SKILL.md ",
    ]) {
        const entries = createCanonicalEntries().map((entry) => (
            entry.name === "package/skills/vsuee/SKILL.md"
                ? { ...entry, name: replacement }
                : entry
        ));
        assert.throws(
            () => verifyPackageTarball(createTar(entries)),
            /Missing files/,
        );
    }
});

test("package verifier rejects mismatched manifest identity or version", () => {
    for (const pluginManifest of [
        { name: "other-package", version: "1.0.1" },
        { name: "vsuee-skill", version: "1.0.0" },
    ]) {
        const entries = createCanonicalEntries().map((entry) => (
            entry.name === "package/plugin.json"
                ? { ...entry, payload: Buffer.from(JSON.stringify(pluginManifest)) }
                : entry
        ));
        assert.throws(
            () => verifyPackageTarball(createTar(entries)),
            /matching package names and versions/,
        );
    }
});
