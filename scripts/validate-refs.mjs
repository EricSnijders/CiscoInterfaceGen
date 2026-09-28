// Structural check for the two reference files in src/ref.
//
// These files are data, not code: a colleague adding a switch model or tweaking
// a ruleset edits JSON, and a mistake there breaks the app for everyone at once
// (a stray brace once made Switch_Hardware.json unparseable). `npm run validate`
// catches that here and in CI, before it reaches main.
//
// Exits 0 when clean, 1 with a list of problems otherwise.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMAND_KEYS, RULE_FACTS, FACT_VALUES, BOOLEAN_FACTS } from "../src/ref/schema.js";

const REF = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ref");
const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

function readJSON(name) {
  try {
    return JSON.parse(readFileSync(join(REF, name), "utf8"));
  } catch (e) {
    fail(name, `not valid JSON — ${e.message}`);
    return null;
  }
}

// ── Switch_Hardware.json ───────────────────────────────────────────────────
function checkInterfaces(file, owner, blocks) {
  if (!Array.isArray(blocks) || !blocks.length)
    return fail(file, `${owner}: "interfaces" must be a non-empty array`);

  const seen = [];
  blocks.forEach((b, i) => {
    const at = `${owner}.interfaces[${i}]`;
    if (typeof b?.namePattern !== "string" || !b.namePattern)
      fail(file, `${at}: "namePattern" must be a non-empty string`);
    else if (!b.namePattern.includes("{port}"))
      fail(file, `${at}: namePattern "${b.namePattern}" must contain {port}`);
    if (typeof b?.type !== "string" || !b.type)
      fail(file, `${at}: "type" must be a non-empty string (the connector, e.g. RJ45)`);

    const r = b?.portRange;
    if (!r || typeof r.start !== "number" || typeof r.end !== "number")
      return fail(file, `${at}: "portRange" needs numeric start and end`);
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1)
      return fail(file, `${at}: portRange must be whole numbers starting at 1 or more`);
    if (r.end < r.start)
      return fail(file, `${at}: portRange end (${r.end}) is before start (${r.start})`);

    // Overlapping ranges would silently shadow each other when expanded.
    for (const [os, oe, oi] of seen)
      if (r.start <= oe && os <= r.end)
        fail(file, `${at}: ports ${r.start}-${r.end} overlap interfaces[${oi}] (${os}-${oe})`);
    seen.push([r.start, r.end, i]);
  });
}

function checkHardware() {
  const file = "Switch_Hardware.json";
  const hw = readJSON(file);
  if (!hw) return [];

  if (!hw.switches || typeof hw.switches !== "object")
    return fail(file, `missing a "switches" object`), [];
  const models = Object.keys(hw.switches);
  if (!models.length) fail(file, `"switches" is empty — the model dropdown would have nothing in it`);

  for (const [model, def] of Object.entries(hw.switches)) checkInterfaces(file, model, def?.interfaces);

  for (const [name, def] of Object.entries(hw.modules || {})) {
    checkInterfaces(file, name, def?.interfaces);
    const compat = def?.compatibleWith;
    if (compat !== undefined && !Array.isArray(compat))
      fail(file, `${name}: "compatibleWith" must be an array (empty means fits every model)`);
    else for (const m of compat || [])
      if (!models.includes(m))
        fail(file, `${name}: compatibleWith names "${m}", which is not a switch in this file`);
  }
  return models;
}

// ── Rulesets.json ──────────────────────────────────────────────────────────
function checkWhen(file, at, when) {
  if (typeof when !== "object" || when === null || Array.isArray(when))
    return fail(file, `${at}: "when" must be an object of facts`);
  if (!Object.keys(when).length)
    fail(file, `${at}: "when" is empty, so the rule matches every interface — remove it or add a condition`);

  for (const [fact, want] of Object.entries(when)) {
    if (!RULE_FACTS.includes(fact)) {
      fail(file, `${at}: unknown fact "${fact}". Valid: ${RULE_FACTS.join(", ")}`);
      continue;
    }
    const wants = Array.isArray(want) ? want : [want];
    if (!wants.length) fail(file, `${at}: "${fact}" is an empty list, so it can never match`);
    if (BOOLEAN_FACTS.includes(fact) && wants.some(w => typeof w !== "boolean"))
      fail(file, `${at}: "${fact}" takes true or false, not ${JSON.stringify(want)}`);
    const allowed = FACT_VALUES[fact];
    if (allowed) for (const w of wants)
      if (!allowed.some(a => a.toLowerCase() === String(w).toLowerCase()))
        fail(file, `${at}: "${fact}" cannot be ${JSON.stringify(w)}. Valid: ${allowed.join(", ")}`);
  }
}

function checkRulesets(models) {
  const file = "Rulesets.json";
  const rs = readJSON(file);
  if (!rs) return;

  const sets = rs.rulesets;
  if (!sets || typeof sets !== "object") return fail(file, `missing a "rulesets" object`);
  const ids = Object.keys(sets);
  if (!ids.length) return fail(file, `"rulesets" is empty — the app has no commands to emit`);
  if (rs.default && !ids.includes(rs.default))
    fail(file, `"default" names "${rs.default}", which is not one of: ${ids.join(", ")}`);

  const isStringArray = v => Array.isArray(v) && v.every(x => typeof x === "string");

  for (const [id, def] of Object.entries(sets)) {
    if (typeof def?.name !== "string" || !def.name)
      fail(file, `${id}: needs a "name" for the dropdown`);

    for (const [bucket, cmds] of Object.entries(def?.commands || {})) {
      if (!COMMAND_KEYS.includes(bucket))
        fail(file, `${id}.commands: unknown bucket "${bucket}". Valid: ${COMMAND_KEYS.join(", ")}`);
      if (!isStringArray(cmds))
        fail(file, `${id}.commands.${bucket}: must be an array of command strings`);
    }

    const rules = def?.rules;
    if (rules !== undefined && !Array.isArray(rules))
      fail(file, `${id}: "rules" must be an array`);
    else (rules || []).forEach((rule, i) => {
      const at = `${id}.rules[${i}]`;
      checkWhen(file, at, rule?.when);
      if (!isStringArray(rule?.commands))
        fail(file, `${at}: "commands" must be an array of command strings`);
      else if (!rule.commands.length)
        fail(file, `${at}: "commands" is empty, so the rule does nothing`);
      // A model fact that matches no known switch can never fire.
      for (const m of [rule?.when?.model].flat().filter(Boolean))
        if (models.length && !models.includes(m))
          fail(file, `${at}: model "${m}" is not in Switch_Hardware.json`);
    });

    if (!Object.keys(def?.commands || {}).length && !(def?.rules || []).length)
      fail(file, `${id}: has neither commands nor rules, so it emits nothing`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
checkRulesets(checkHardware());

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) in src/ref:\n`);
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}
console.log("✓ src/ref/Switch_Hardware.json and src/ref/Rulesets.json are valid");
