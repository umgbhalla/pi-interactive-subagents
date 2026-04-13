import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function buildSubagentTaskArtifactPath(artifactDir: string, name: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = name
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const artifactName = `context/${safeName}-${timestamp}.md`;
  return join(artifactDir, artifactName);
}

export function writeSubagentTaskArtifact(artifactDir: string, name: string, fullTask: string, now = new Date()): string {
  const artifactPath = buildSubagentTaskArtifactPath(artifactDir, name, now);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, fullTask, "utf8");
  return artifactPath;
}
