import { readFile, writeFile } from "node:fs/promises";

const packageNames = ["@soljs/sol", "@soljs/compiler", "@soljs/solkit"] as const;
const manifestPaths = [
  "runtime/package.json",
  "compiler/package.json",
  "solkit/package.json",
  "example/package.json",
  "web/package.json",
] as const;
const dependencySections = ["dependencies", "devDependencies", "peerDependencies"] as const;

type ReleaseType = "patch" | "minor";
type Manifest = Record<string, unknown> & { name?: unknown; version?: unknown };

function releaseType(value: string | undefined): ReleaseType {
  if (value !== "patch" && value !== "minor") {
    throw new TypeError("Release type must be patch or minor");
  }
  return value;
}

function stableVersion(value: unknown, label: string): [number, number, number] {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new TypeError(`${label} must be a stable semantic version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nextVersion(current: string, type: ReleaseType): string {
  const [major, minor, patch] = stableVersion(current, "Published version");
  return type === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

async function publishedVersion(name: (typeof packageNames)[number]): Promise<string> {
  const process = Bun.spawn(["npm", "view", name, "version", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not read ${name} from npm: ${stderr.trim() || `exit ${exitCode}`}`);
  }
  const version: unknown = JSON.parse(stdout);
  stableVersion(version, `${name} version`);
  return version as string;
}

function dependencySection(manifest: Manifest, key: (typeof dependencySections)[number]) {
  const section = manifest[key];
  if (section === undefined) return undefined;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new TypeError(`${String(manifest.name)} ${key} must be an object`);
  }
  return section as Record<string, unknown>;
}

const type = releaseType(Bun.argv[2]);
const publishedVersions = await Promise.all(packageNames.map(publishedVersion));
const [current] = publishedVersions;
if (!current || publishedVersions.some((version) => version !== current)) {
  throw new Error(
    `Published package versions are not synchronized: ${publishedVersions.join(", ")}`,
  );
}
const version = nextVersion(current, type);

await Promise.all(
  manifestPaths.map(async (path) => {
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new TypeError(`${path} must contain a package manifest object`);
    }
    const packageManifest = manifest as Manifest;
    if (typeof packageManifest.name !== "string") throw new TypeError(`${path} must have a name`);
    if (packageNames.includes(packageManifest.name as (typeof packageNames)[number])) {
      packageManifest.version = version;
    }
    for (const key of dependencySections) {
      const dependencies = dependencySection(packageManifest, key);
      if (!dependencies) continue;
      for (const name of packageNames) {
        if (name in dependencies) dependencies[name] = version;
      }
    }
    await writeFile(path, `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");
  }),
);

console.log(version);
