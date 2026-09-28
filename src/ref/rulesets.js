// ── Ruleset library ────────────────────────────────────────────────────────
// Reads Rulesets.json: named sets of IOS commands emitted per condition.
// Lives in the repo (not localStorage) so a team shares one standard and
// changes to it arrive by pull request.
//
// A ruleset expresses policy two ways, and may use both:
//   commands — six fixed buckets, editable in the UI. Simple, covers most needs.
//   rules    — [{ when: {...facts}, commands: [...] }], for policy the buckets
//              cannot express ("dot1x only on copper"). Repo-only, by design:
//              conditions belong in review, not in a textarea.
// Both compile to one ordered rule list and run through one evaluator.
import RS from "./Rulesets.json";
import { COMMAND_KEYS, RULE_FACTS } from "./schema";

export { COMMAND_KEYS, RULE_FACTS };

export const RULESET_IDS = Object.keys(RS.rulesets || {});
export const DEFAULT_RULESET_ID =
  RS.rulesets?.[RS.default] ? RS.default : RULESET_IDS[0];

export const isKnownRuleset = id => Boolean(RS.rulesets?.[id]);
export const rulesetName    = id => RS.rulesets[id]?.name || id;
export const rulesetSummary = id => RS.rulesets[id]?.description || "";
export const rulesetRuleCount = id => (RS.rulesets[id]?.rules || []).length;

export const RULESET_OPTIONS = RULESET_IDS.map(id => ({
  id, name: rulesetName(id), description: rulesetSummary(id),
}));

// Always returns every bucket, as a fresh copy — callers edit the result.
export function rulesetCommands(id) {
  const cmds = RS.rulesets[id]?.commands || {};
  return Object.fromEntries(COMMAND_KEYS.map(k => [k, [...(cmds[k] || [])]]));
}

// The six buckets as their equivalent ordered rules. This ordering is the
// emission order of the original hand-written generator, preserved exactly:
// vlan line, mode commands, dot1x, channel-group, then shutdown state.
function bucketsToRules(commands) {
  const body = [
    { when: { mode: "Access", hasVlan: true }, commands: ["switchport access vlan {vlan}"] },
    { when: { mode: "Trunk"  }, commands: commands.trunk },
    { when: { mode: "Access" }, commands: commands.access },
    // dot1x and channel-group apply to physical members, never to the
    // Port-channel interface itself.
    { when: { mode: "Access", dot1x: true, interface: "physical" }, commands: commands.dot1x },
    { when: { portChannel: true, interface: "physical" }, commands: commands.portchannel },
  ];
  const state = [
    { when: { shutdown: true  }, commands: commands.shutdownTrue },
    { when: { shutdown: false }, commands: commands.shutdownFalse },
  ];
  const keep = r => r.commands?.length;
  return { body: body.filter(keep), state: state.filter(keep) };
}

// Bucket body rules, then the ruleset's own condition rules, then shutdown
// state last — so `no shutdown` always closes an interface block rather than
// landing in the middle of it.
export function rulesetRules(id, commands) {
  const { body, state } = bucketsToRules(commands || rulesetCommands(id));
  const explicit = (RS.rulesets[id]?.rules || [])
    .map(r => ({ when: r.when || {}, commands: r.commands || [] }))
    .filter(r => r.commands.length);
  return [...body, ...explicit, ...state];
}

// Booleans compare truthily; everything else compares case-insensitively as a
// string. An array in `when` means "any of these".
function factEquals(want, got) {
  if (typeof want === "boolean") return Boolean(got) === want;
  return String(want).toLowerCase() === String(got ?? "").toLowerCase();
}

export function matchesRule(when, facts) {
  return Object.entries(when).every(([fact, want]) =>
    Array.isArray(want) ? want.some(w => factEquals(w, facts[fact]))
                        : factEquals(want, facts[fact]));
}

// ── Sections the condition rules cannot express ────────────────────────────
export const rulesetNaming       = id => RS.rulesets[id]?.naming || {};
export const rulesetPortDefaults = id => RS.rulesets[id]?.portDefaults || {};
export const rulesetUplinks      = id => RS.rulesets[id]?.uplinks || null;
export const rulesetManagement   = id => RS.rulesets[id]?.management || {};
export const rulesetDeviceToggles= id => RS.rulesets[id]?.deviceToggles || [];

// Every device-toggle key any ruleset defines. The YAML validator needs the
// union, since a file may name a toggle belonging to a different ruleset.
export const ALL_DEVICE_TOGGLE_KEYS = [...new Set(
  Object.values(RS.rulesets || {}).flatMap(r => (r.deviceToggles || []).map(t => t.key)).filter(Boolean)
)];

export const rulesetPortRoles = id => RS.rulesets[id]?.portRoles || {};

// Roles are matched case-insensitively, since they are typed into YAML.
export function rulesetPortRole(id, role) {
  const roles = rulesetPortRoles(id);
  const key = Object.keys(roles).find(k => k.toLowerCase() === String(role).toLowerCase());
  return key ? { ...roles[key], name: key } : null;
}

export const ALL_PORT_ROLES = [...new Set(
  Object.values(RS.rulesets || {}).flatMap(r => Object.keys(r.portRoles || {}))
)];

// A group's Description as it should appear on the interface. Trunks take
// uplinkPrefix, everything else takes prefix. Any convention prefix already
// present is stripped first, so flipping a group between access and trunk
// re-labels it rather than stacking ";" and "U;".
export function formatDescription(desc, { mode, dot1x, role }, naming = {}) {
  const { prefix = "", uplinkPrefix = "", noDot1xSuffix = "" } = naming;
  // A role port carries neither traffic mode nor dot1x, so it takes the plain
  // prefix and is never marked as unsecured.
  const isTrunk = !role && String(mode).toLowerCase() === "trunk";
  const wanted = isTrunk && uplinkPrefix ? uplinkPrefix : prefix;

  let out = String(desc ?? "");
  for (const p of [uplinkPrefix, prefix].filter(Boolean).sort((a, b) => b.length - a.length))
    if (out.startsWith(p)) { out = out.slice(p.length); break; }
  if (wanted) out = wanted + out;

  // ZB marks an access port deliberately left without 802.1X. A trunk was
  // never a candidate for dot1x, so it is not marked.
  const unsecured = !isTrunk && !role && !dot1x;
  if (noDot1xSuffix && unsecured && !out.endsWith(noDot1xSuffix)) out = `${out} ${noDot1xSuffix}`;
  return out;
}

// Serializes edited commands back into Rulesets.json shape, so an in-session
// tweak can be pasted into the repo file and reviewed as a diff.
export function toRulesetJSON(id, commands) {
  const rs = RS.rulesets[id] || {};
  const out = {
    name: rulesetName(id),
    description: rulesetSummary(id),
    commands: Object.fromEntries(COMMAND_KEYS.map(k => [k, commands[k] || []])),
  };
  if (rs.rules?.length) out.rules = rs.rules;   // preserved, not editable here
  return JSON.stringify({ [id]: out }, null, 2);
}

export default RS;
