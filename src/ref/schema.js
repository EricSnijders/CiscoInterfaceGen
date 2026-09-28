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
// uplinkPrefix replaces prefix on trunk ports, so an uplink reads "U;Core".
export const NAMING_KEYS = ["prefix", "uplinkPrefix", "noDot1xSuffix"];

// management: what the Management IP becomes. An access switch addresses an
// SVI; a routed distribution switch addresses a loopback.
export const MANAGEMENT_KEYS = ["interface", "number"];
export const MANAGEMENT_INTERFACES = ["vlan", "loopback"];

// deviceToggles: box-wide features, switched on per device rather than per
// port — StackWise Virtual, for instance. Each becomes a checkbox in the
// wizard, a top-level YAML key, and a block of global config.
export const DEVICE_TOGGLE_KEYS = ["key", "label", "commands", "hint"];

// portDefaults: initial state of a newly added port group in the wizard.
// channelMode is the mode filled in when Port-channel is ticked.
export const PORT_DEFAULT_KEYS = ["dot1x", "shutdown", "channelMode"];
export const PORT_DEFAULT_BOOLEANS = ["dot1x", "shutdown"];

// portRoles: ports that exist for a device feature rather than for traffic —
// StackWise Virtual links, dual-active detection. A role replaces the normal
// mode/dot1x/shutdown emission with its own commands, and the wizard can pick
// the ports for it. Roles consume ports from the tail of a member's list in
// declaration order, so SVL taking 23-24 leaves DAD on 22.
export const PORT_ROLE_KEYS = ["label", "requiresToggle", "select", "range", "commands"];
export const ROLE_SELECT_KEYS = ["perMember", "from"];
export const ROLE_FROM = ["onboard", "module"];

// uplinks: how the wizard picks uplink ports and bundles them.
export const UPLINK_KEYS = [
  "standaloneCount",  // uplinks on a single, unstacked switch
  "perMember",        // uplinks per member once it is a stack
  "prefer",           // take them from the network module, or from onboard ports
  "channelGroup", "channelMode",
];
export const UPLINK_PREFER = ["module", "onboard"];
