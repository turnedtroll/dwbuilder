import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { assemble, draftEnvelope } from "../engine/index.js";
const game = JSON.parse(readFileSync(new URL("../data/game.json", import.meta.url)));
const A = JSON.parse(readFileSync(new URL("../data/archetypes.json", import.meta.url))).archetypes;
const out = process.argv[2] ?? "out/builds"; mkdirSync(out, { recursive: true });
for (const a of A) {
  const b = assemble({ role: a.role, oath: a.oath[0]?.[0] ?? null }, [a], game);
  const env = draftEnvelope(b);
  writeFileSync(`${out}/${a.id}.json`, JSON.stringify({ ...env, meta_score: b.meta_score, archetype_id: a.id, validation: b.validation }, null, 1));
}
console.log(`wrote ${A.length} builds to ${out}`);
