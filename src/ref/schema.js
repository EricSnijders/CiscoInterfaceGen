// ── Shared schema vocabulary ───────────────────────────────────────────────
// Imports no JSON, so both the browser app and the Node CI validator can use
// it. Keeping these lists in one place is what stops the running app and the
// pull-request check from disagreeing about what a valid ruleset looks like.

// The conditions generateConfig knows how to emit commands for.
export const COMMAND_KEYS = [
  "dot1x", "access", "trunk", "portchannel", "shutdownTrue", "shutdownFalse",
];

// Facts a ruleset's `when` clause may match on.
export const RULE_FACTS = [
  "mode",          // "Access" | "Trunk"
  "dot1x", "shutdown", "portChannel", "uplinkModule", "hasVlan",  // booleans
  "portType",      // connector, e.g. "RJ45" | "SFP" | "SFP+" | "SFP28" | "QSFP28"
  "model", "member",
  "interface",     // "physical" | "port-channel"
];

// Facts with a closed set of values, checked in CI so a typo like
// `mode: Trunked` fails the pull request instead of silently never matching.
export const FACT_VALUES = {
  mode: ["Access", "Trunk"],
  interface: ["physical", "port-channel"],
};

export const BOOLEAN_FACTS = ["dot1x", "shutdown", "portChannel", "uplinkModule", "hasVlan"];
