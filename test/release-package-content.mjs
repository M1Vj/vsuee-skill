import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const CHECKSUM_START = 148;
const CHECKSUM_END = 156;

export const EXPECTED_PACKAGE_FILES = Object.freeze([
    "package/LICENSE",
    "package/package.json",
    "package/plugin.json",
    "package/README.md",
    "package/skills/vsuee/SKILL.md",
    "package/lib/browser-runner.mjs",
    "package/lib/moodle-client.mjs",
    "package/lib/sync-manager.mjs",
    "package/bin/vsuee.mjs",
]);

function readTarText(header, start, end) {
    return header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
}

function readTarOctal(header, start, end, label) {
    const text = readTarText(header, start, end).trim();
    if (!/^[0-7]+$/.test(text)) {
        throw new Error(`Invalid ${label} field in tar header.`);
    }

    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Unsafe ${label} value in tar header.`);
    }

    return value;
}

function verifyHeaderChecksum(header, entryName) {
    const expectedChecksum = readTarOctal(
        header,
        CHECKSUM_START,
        CHECKSUM_END,
        "checksum",
    );
    let actualChecksum = 0;

    for (let index = 0; index < BLOCK_SIZE; index += 1) {
        actualChecksum += index >= CHECKSUM_START && index < CHECKSUM_END
            ? 0x20
            : header[index];
    }

    if (actualChecksum !== expectedChecksum) {
        throw new Error(`Invalid tar header checksum for '${entryName}'.`);
    }
}

export function verifyPackageTarball(
    tarball,
    expectedFiles = EXPECTED_PACKAGE_FILES,
) {
    if (!Buffer.isBuffer(tarball)) {
        throw new TypeError("Uncompressed tarball must be a Buffer.");
    }

    const files = [];
    const payloads = new Map();
    let offset = 0;
    let zeroBlocks = 0;

    while (offset + BLOCK_SIZE <= tarball.length) {
        const header = tarball.subarray(offset, offset + BLOCK_SIZE);
        offset += BLOCK_SIZE;

        if (header.every((byte) => byte === 0)) {
            zeroBlocks += 1;
            if (zeroBlocks === 2) {
                break;
            }
            continue;
        }

        if (zeroBlocks > 0) {
            throw new Error("Tar archive contains data after an end marker.");
        }

        const name = readTarText(header, 0, 100);
        const prefix = readTarText(header, 345, 500);
        const entryName = prefix ? `${prefix}/${name}` : name;
        if (!entryName) {
            throw new Error("Tar archive contains an unnamed entry.");
        }

        verifyHeaderChecksum(header, entryName);

        const size = readTarOctal(header, 124, 136, "size");
        const type = header[156];
        if (type !== 0 && type !== 48) {
            throw new Error(
                `Unexpected tar entry type ${type} for '${entryName}'.`,
            );
        }

        const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
        const entryEnd = offset + paddedSize;
        if (entryEnd > tarball.length) {
            throw new Error(`Truncated tar payload for '${entryName}'.`);
        }

        files.push(entryName);
        payloads.set(entryName, tarball.subarray(offset, offset + size));
        offset = entryEnd;
    }

    if (zeroBlocks !== 2) {
        throw new Error("Tar archive is missing its two-block end marker.");
    }

    if (tarball.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error("Tar archive contains non-zero trailing data.");
    }

    const expectedSet = new Set(expectedFiles);
    const actualSet = new Set(files);
    const missingFiles = [...expectedSet].filter((file) => !actualSet.has(file));
    const unexpectedFiles = [...actualSet].filter((file) => !expectedSet.has(file));
    const duplicateFiles = files.filter(
        (file, index) => files.indexOf(file) !== index,
    );

    if (
        missingFiles.length > 0
        || unexpectedFiles.length > 0
        || duplicateFiles.length > 0
        || files.length !== expectedSet.size
    ) {
        const details = [
            missingFiles.length > 0
                ? `Missing files:\n${missingFiles.join("\n")}`
                : "",
            unexpectedFiles.length > 0
                ? `Unexpected files:\n${unexpectedFiles.join("\n")}`
                : "",
            duplicateFiles.length > 0
                ? `Duplicate files:\n${[...new Set(duplicateFiles)].join("\n")}`
                : "",
            files.length !== expectedSet.size
                ? `Expected ${expectedSet.size} files, found ${files.length}.`
                : "",
        ].filter(Boolean);

        throw new Error(details.join("\n"));
    }

    let packageManifest;
    let pluginManifest;
    try {
        packageManifest = JSON.parse(payloads.get("package/package.json").toString("utf8"));
        pluginManifest = JSON.parse(payloads.get("package/plugin.json").toString("utf8"));
    } catch (error) {
        throw new Error("Release manifests must contain valid JSON.", { cause: error });
    }

    if (
        packageManifest.name !== "vsuee-skill"
        || pluginManifest.name !== packageManifest.name
        || typeof packageManifest.version !== "string"
        || packageManifest.version.length === 0
        || pluginManifest.version !== packageManifest.version
    ) {
        throw new Error("Release manifests must have matching package names and versions.");
    }

    return files;
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    const inputPath = process.argv[2];
    if (!inputPath) {
        throw new Error("Input tarball path is required.");
    }

    const compressedTarball = readFileSync(path.resolve(inputPath));
    verifyPackageTarball(gunzipSync(compressedTarball));
}
