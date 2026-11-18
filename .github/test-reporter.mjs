// node --test reporter that turns each failed test into a GitHub annotation and a step-summary entry.
// Pair it with the spec reporter, which keeps the full log readable. No dependencies.
import { appendFileSync } from "node:fs";
import { relative } from "node:path";

const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

export default async function* reporter(source) {
  const failures = [];
  for await (const { type, data } of source) {
    // A suite fails only because a child did; the child carries the real error.
    if (type !== "test:fail" || data.details?.error?.failureType === "subtestsFailed") continue;
    const file = data.file ? relative(process.cwd(), data.file) : "";
    const message = String(data.details?.error?.cause?.message ?? data.details?.error?.message ?? "test failed");
    failures.push({ file, line: data.line, name: data.name, message });
    const location = file ? `file=${escapeProperty(file)},line=${data.line ?? 1},` : "";
    yield `::error ${location}title=${escapeProperty(`Unit test failed: ${data.name}`)}::${escapeData(message)}\n`;
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (failures.length > 0 && summaryPath) {
    const rows = failures.map((f) => `- \`${f.file}:${f.line ?? ""}\` ${f.name}: ${f.message.split("\n")[0]}`);
    appendFileSync(summaryPath, `### Unit tests: ${failures.length} failed\n\n${rows.join("\n")}\n`);
  }
}
