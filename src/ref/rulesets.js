// ── Ruleset library ────────────────────────────────────────────────────────
// Reads Rulesets.json: named sets of IOS commands emitted per condition.
// Lives in the repo (not localStorage) so a team shares one standard and
// changes to it arrive by pull request.
import RS from "./Rulesets.json";

// The conditions generateConfig knows how to emit. A ruleset may omit any of
// them; the omitted bucket is simply empty.
export const COMMAND_KEYS = [
  "dot1x", "access", "trunk", "portchannel", "shutdownTrue", "shutdownFalse",
];

export const RULESET_IDS = Object.keys(RS.rulesets || {});
export const DEFAULT_RULESET_ID =
  RS.rulesets?.[RS.default] ? RS.default : RULESET_IDS[0];

export const isKnownRuleset = id => Boolean(RS.rulesets?.[id]);
export const rulesetName    = id => RS.rulesets[id]?.name || id;
export const rulesetSummary = id => RS.rulesets[id]?.description || "";

export const RULESET_OPTIONS = RULESET_IDS.map(id => ({
  id, name: rulesetName(id), description: rulesetSummary(id),
}));

// Always returns every bucket, as a fresh copy — callers edit the result.
export function rulesetCommands(id) {
  const cmds = RS.rulesets[id]?.commands || {};
  return Object.fromEntries(COMMAND_KEYS.map(k => [k, [...(cmds[k] || [])]]));
}

// Serializes edited commands back into Rulesets.json shape, so an in-session
// tweak can be pasted into the repo file and reviewed as a diff.
export function toRulesetJSON(id, commands) {
  return JSON.stringify({
    [id]: {
      name: rulesetName(id),
      description: rulesetSummary(id),
      commands: Object.fromEntries(COMMAND_KEYS.map(k => [k, commands[k] || []])),
    },
  }, null, 2);
}

export default RS;
