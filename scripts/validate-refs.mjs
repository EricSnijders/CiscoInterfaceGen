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
import {
  COMMAND_KEYS, RULE_FACTS, FACT_VALUES, BOOLEAN_FACTS,
  NAMING_KEYS, PORT_DEFAULT_KEYS, UPLINK_KEYS, UPLINK_PREFER, CHANNEL_MODE_VALUES,
  MANAGEMENT_KEYS, MANAGEMENT_INTERFACES, DEVICE_TOGGLE_KEYS,
  PORT_DEFAULT_BOOLEANS, PORT_ROLE_KEYS, ROLE_SELECT_KEYS, ROLE_FROM,
} from "../src/ref/schema.js";

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

// naming / portDefaults / uplinks — the sections condition rules cannot express.
function checkSections(file, id, def) {
  const unknown = (section, obj, allowed) => {
    for (const k of Object.keys(obj))
      if (!allowed.includes(k))
        fail(file, `${id}.${section}: unknown key "${k}". Valid: ${allowed.join(", ")}`);
  };

  const naming = def.naming;
  if (naming !== undefined) {
    if (typeof naming !== "object" || naming === null || Array.isArray(naming))
      fail(file, `${id}.naming: must be an object`);
    else {
      unknown("naming", naming, NAMING_KEYS);
      for (const k of NAMING_KEYS)
        if (naming[k] !== undefined && typeof naming[k] !== "string")
          fail(file, `${id}.naming.${k}: must be a string`);
    }
  }

  const pd = def.portDefaults;
  if (pd !== undefined) {
    if (typeof pd !== "object" || pd === null || Array.isArray(pd))
      fail(file, `${id}.portDefaults: must be an object`);
    else {
      unknown("portDefaults", pd, PORT_DEFAULT_KEYS);
      for (const [k, v] of Object.entries(pd))
        if (PORT_DEFAULT_BOOLEANS.includes(k) && typeof v !== "boolean")
          fail(file, `${id}.portDefaults.${k}: must be true or false`);
      if (pd.channelMode !== undefined &&
          !CHANNEL_MODE_VALUES.some(m => m.toLowerCase() === String(pd.channelMode).toLowerCase()))
        fail(file, `${id}.portDefaults.channelMode: must be one of ${CHANNEL_MODE_VALUES.join(", ")}`);
    }
  }

  const mg = def.management;
  if (mg !== undefined) {
    if (typeof mg !== "object" || mg === null || Array.isArray(mg))
      fail(file, `${id}.management: must be an object`);
    else {
      unknown("management", mg, MANAGEMENT_KEYS);
      if (mg.interface !== undefined && !MANAGEMENT_INTERFACES.includes(String(mg.interface).toLowerCase()))
        fail(file, `${id}.management.interface: must be one of ${MANAGEMENT_INTERFACES.join(", ")}`);
      if (mg.number !== undefined && (!Number.isInteger(mg.number) || mg.number < 0))
        fail(file, `${id}.management.number: must be a whole number of 0 or more`);
    }
  }

  const toggles = def.deviceToggles;
  if (toggles !== undefined) {
    if (!Array.isArray(toggles)) fail(file, `${id}.deviceToggles: must be an array`);
    else toggles.forEach((t, i) => {
      const at = `${id}.deviceToggles[${i}]`;
      if (typeof t !== "object" || t === null || Array.isArray(t))
        return fail(file, `${at}: must be an object`);
      unknown(`deviceToggles[${i}]`, t, DEVICE_TOGGLE_KEYS);
      // The key becomes a top-level YAML key, so it must look like one.
      if (typeof t.key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(t.key))
        fail(file, `${at}.key: must be a letters-and-digits name, e.g. StackWiseVirtual`);
      if (t.label !== undefined && typeof t.label !== "string")
        fail(file, `${at}.label: must be a string`);
      if (t.hint !== undefined && typeof t.hint !== "string")
        fail(file, `${at}.hint: must be a string`);
      if (!Array.isArray(t.commands) || !t.commands.every(c => typeof c === "string"))
        fail(file, `${at}.commands: must be an array of command strings`);
      else if (!t.commands.length)
        fail(file, `${at}.commands: is empty, so the toggle does nothing`);
    });
  }

  const roles = def.portRoles;
  if (roles !== undefined) {
    if (typeof roles !== "object" || roles === null || Array.isArray(roles))
      fail(file, `${id}.portRoles: must be an object keyed by role name`);
    else for (const [name, r] of Object.entries(roles)) {
      const at = `${id}.portRoles.${name}`;
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name))
        fail(file, `${at}: role name must be letters and digits — it is typed into YAML as Role: ${name}`);
      if (typeof r !== "object" || r === null || Array.isArray(r)) { fail(file, `${at}: must be an object`); continue; }
      unknown(`portRoles.${name}`, r, PORT_ROLE_KEYS);
      if (!Array.isArray(r.commands) || !r.commands.every(c => typeof c === "string") || !r.commands.length)
        fail(file, `${at}.commands: must be a non-empty array of command strings`);
      if (r.range !== undefined && typeof r.range !== "boolean")
        fail(file, `${at}.range: must be true or false`);
      // A toggle that does not exist would hide the role's button forever.
      if (r.requiresToggle !== undefined &&
          !(def.deviceToggles || []).some(t => t.key === r.requiresToggle))
        fail(file, `${at}.requiresToggle: "${r.requiresToggle}" is not a deviceToggle of this ruleset`);
      const sel = r.select;
      if (sel !== undefined) {
        if (typeof sel !== "object" || sel === null || Array.isArray(sel)) fail(file, `${at}.select: must be an object`);
        else {
          unknown(`portRoles.${name}.select`, sel, ROLE_SELECT_KEYS);
          if (sel.perMember !== undefined && (!Number.isInteger(sel.perMember) || sel.perMember < 1))
            fail(file, `${at}.select.perMember: must be a whole number of 1 or more`);
          if (sel.from !== undefined && !ROLE_FROM.includes(sel.from))
            fail(file, `${at}.select.from: must be one of ${ROLE_FROM.join(", ")}`);
        }
      }
    }
  }

  const up = def.uplinks;
  if (up !== undefined) {
    if (typeof up !== "object" || up === null || Array.isArray(up))
      return fail(file, `${id}.uplinks: must be an object`);
    unknown("uplinks", up, UPLINK_KEYS);
    for (const k of ["standaloneCount", "perMember"])
      if (up[k] !== undefined && (!Number.isInteger(up[k]) || up[k] < 1))
        fail(file, `${id}.uplinks.${k}: must be a whole number of 1 or more`);
    if (up.prefer !== undefined && !UPLINK_PREFER.includes(up.prefer))
      fail(file, `${id}.uplinks.prefer: must be one of ${UPLINK_PREFER.join(", ")}`);
    if (up.channelMode !== undefined &&
        !CHANNEL_MODE_VALUES.some(m => m.toLowerCase() === String(up.channelMode).toLowerCase()))
      fail(file, `${id}.uplinks.channelMode: must be one of ${CHANNEL_MODE_VALUES.join(", ")}`);
    if (up.channelGroup !== undefined && !(Number.isInteger(up.channelGroup) && up.channelGroup >= 1))
      fail(file, `${id}.uplinks.channelGroup: must be a whole number of 1 or more`);
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

    checkSections(file, id, def || {});

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
