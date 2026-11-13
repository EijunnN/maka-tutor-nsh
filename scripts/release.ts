// Publica una versión nueva: `bun scripts/release.ts 0.2.0` (o `patch`, `minor`).
// Sube la versión y el build en nsh.json, hace commit y tag, y los sube:
// GitHub Actions (.github/workflows/release.yml) prueba, empaqueta Windows y
// Linux y crea el Release del que la app se actualiza sola.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const run = (cmd: string, args: string[], capture = false) => {
  const r = spawnSync(cmd, args, { stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    if (capture) process.stderr.write(r.stderr ?? "");
    console.error(`✗ ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
  return (r.stdout ?? "").trim();
};

const parse = (v: string) => v.split(".").map(Number) as [number, number, number];
const config = JSON.parse(readFileSync("nsh.json", "utf8")) as { version: string; build: number };
const [major, minor, patch] = parse(config.version);

const arg = process.argv[2];
if (!arg) {
  console.log(`Versión actual: ${config.version}. Uso: bun scripts/release.ts <X.Y.Z | patch | minor | major>`);
  process.exit(1);
}
const next =
  arg === "patch" ? `${major}.${minor}.${patch + 1}`
  : arg === "minor" ? `${major}.${minor + 1}.0`
  : arg === "major" ? `${major + 1}.0.0`
  : arg.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`«${arg}» no es una versión X.Y.Z`);
  process.exit(1);
}
const newer = (a: string, b: string) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2];
};
if (!newer(next, config.version)) {
  console.error(`${next} no es mayor que la actual (${config.version})`);
  process.exit(1);
}

// Sin cambios sueltos: el release es exactamente lo que está en el commit.
if (run("git", ["status", "--porcelain"], true)) {
  console.error("Hay cambios sin commitear. Haz commit (o descártalos) antes de publicar.");
  process.exit(1);
}

// Solo esas dos líneas, conservando el formato de nsh.json.
const text = readFileSync("nsh.json", "utf8")
  .replace(/("version":\s*)"[^"]*"/, `$1"${next}"`)
  .replace(/("build":\s*)\d+/, `$1${config.build + 1}`);
writeFileSync("nsh.json", text);

const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], true);
run("git", ["add", "nsh.json"]);
run("git", ["commit", "-m", `release: v${next}`]);
run("git", ["tag", "-a", `v${next}`, "-m", `Maka Tutor NSH ${next}`]);
run("git", ["push", "origin", branch]);
run("git", ["push", "origin", `v${next}`]);
const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], true);
console.log(`\n✓ v${next} enviada. GitHub la compila y publica (unos minutos):`);
console.log(`  https://github.com/${repo}/actions`);
console.log(`  https://github.com/${repo}/releases/tag/v${next}`);
console.log("Las apps instaladas la ofrecerán solas («Versión disponible · Actualizar»).");
