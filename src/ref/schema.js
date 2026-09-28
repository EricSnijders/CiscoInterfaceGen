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

export const CHANNEL_MODE_VALUES = ["Active", "Passive", "On", "Auto", "Desirable"];

// ── Ruleset sections beyond commands/rules ─────────────────────────────────
// Condition rules answer "given an interface, which commands?". These three
// sections cover the things that question cannot reach: what the wizard should
// pre-fill, how a description is written, and which ports become uplinks.

// naming: how a group's Description becomes the emitted `description` line.
export const NAMING_KEYS = ["prefix", "noDot1xSuffix"];

// portDefaults: initial state of a newly added port group in the wizard.
export const PORT_DEFAULT_KEYS = ["dot1x", "shutdown"];

// uplinks: how the wizard picks uplink ports and bundles them.
export const UPLINK_KEYS = [
  "standaloneCount",  // uplinks on a single, unstacked switch
  "perMember",        // uplinks per member once it is a stack
  "prefer",           // take them from the network module, or from onboard ports
  "channelGroup", "channelMode",
];
export const UPLINK_PREFER = ["module", "onboard"];
