import { useState, useRef, useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import Wizard from "./Wizard";
import { buildHardwareMaps } from "./ref/hardware";
import { CHANNEL_MODE_VALUES } from "./ref/schema";
import { load as yamlLoad } from "js-yaml";
import {
  RULESET_IDS, RULESET_OPTIONS, DEFAULT_RULESET_ID, isKnownRuleset,
  rulesetCommands, rulesetName, rulesetSummary, rulesetRuleCount,
  rulesetRules, matchesRule, toRulesetJSON, rulesetNaming, formatDescription,
  rulesetPortDefaults, rulesetUplinks, rulesetManagement, rulesetDeviceToggles,
  ALL_DEVICE_TOGGLE_KEYS,
} from "./ref/rulesets";

// ── Default command sets ───────────────────────────────────────────────────
// The commands themselves live in Rulesets.json; this is only their UI copy.
const DEFAULTS_META = [
  { key: "dot1x",         label: "Dot1x = True",       hint: "Added to every access port when Dot1x: True" },
  { key: "access",        label: "Access mode",         hint: "Added to every access port (non-trunk)" },
  { key: "trunk",         label: "Trunk mode",          hint: "Added to every trunk/uplink port" },
  { key: "portchannel",   label: "Port-channel member", hint: "Added to physical ports in a port-channel. Use {cgNum} and {cgMode} as placeholders." },
  { key: "shutdownTrue",  label: "Shutdown = True",     hint: "Added when Shutdown: True" },
  { key: "shutdownFalse", label: "Shutdown = False",    hint: "Added when Shutdown: False" },
];

// ── YAML schema: known keys per context ───────────────────────────────────
// Device-toggle keys are reserved too, so a file naming one is not mistaken
// for a port group.
const TOP_LEVEL_RESERVED = ["Devices", "Modules", "Management", "Ruleset", ...ALL_DEVICE_TOGGLE_KEYS];
const PORT_GROUP_KEYS = ["Interfaces","Mode","VLAN","Dot1x","Shutdown","Description","UplinkModule","PortChannel","ChannelGroup","ChannelMode","Range"];
const BOOL_KEYS = new Set(["Dot1x","Shutdown","UplinkModule","PortChannel","Range"]);
// IOS accepts at most five comma-separated ranges per "interface range".
const MAX_RANGES_PER_COMMAND = 5;
const MODE_VALUES = ["Access","Trunk"];
const MGMT_KEYS = ["IP","VLAN","DefaultGW"];

// ── YAML validator → returns Monaco markers ────────────────────────────────
function validateYAML(text) {
  const lines = text.split("\n");
  const markers = [];
  let topContext = null;
  let currentGroup = null;

  const mark = (lineNum, msg, severity = 8) => markers.push({
    startLineNumber: lineNum, endLineNumber: lineNum,
    startColumn: 1, endColumn: 200,
    message: msg,
    severity, // 8=Error, 4=Warning, 2=Info
  });

  // Genuine syntax errors (bad indentation, tabs, duplicate keys, unclosed
  // quotes) come from js-yaml with a line number. Schema checks below would
  // only pile noise on top of them, so report the syntax error alone.
  try { yamlLoad(text); }
  catch (e) {
    const line = (e.mark?.line ?? 0) + 1;
    return [{ startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 200,
              message: `YAML syntax: ${e.reason || e.message}`, severity: 8 }];
  }

  let hasDevices = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r/, "");
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.search(/\S/);
    const trimmed = raw.trim();
    const lineNum = i + 1;

    if (indent === 0) {
      const m = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!m) { mark(lineNum, "Invalid syntax — expected 'Key: Value' or 'Key:'"); continue; }
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (key === "Devices") { hasDevices = true; topContext = "Devices"; currentGroup = null; }
      else if (TOP_LEVEL_RESERVED.includes(key)) {
        if (key === "Ruleset" && val && !isKnownRuleset(val))
          mark(lineNum, `Unknown ruleset "${val}". Available: ${RULESET_IDS.join(", ")}`);
        topContext = key; currentGroup = null;
      }
      else { topContext = null; currentGroup = key; }
      continue;
    }

    if (indent === 2) {
      const m = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!m) { mark(lineNum, "Invalid syntax — expected 'Key: Value'"); continue; }
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, "");

      if (topContext === "Management") {
        if (!MGMT_KEYS.includes(key))
          mark(lineNum, `Unknown Management key "${key}". Valid: ${MGMT_KEYS.join(", ")}`, 4);
        if (key === "IP" && val && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(val))
          mark(lineNum, `IP must be in CIDR format, e.g. 192.168.1.10/24`);
        if (key === "VLAN" && val && isNaN(parseInt(val)))
          mark(lineNum, `VLAN must be a number`);
        if (key === "DefaultGW" && val && !/^\d+\.\d+\.\d+\.\d+$/.test(val))
          mark(lineNum, `DefaultGW must be a plain IP address, e.g. 192.168.1.1`);
      } else if (topContext === "Devices" || topContext === "Modules") {
        // member/slot keys — no strict validation needed
      } else if (currentGroup) {
        if (!PORT_GROUP_KEYS.includes(key))
          mark(lineNum, `Unknown key "${key}". Valid port group keys: ${PORT_GROUP_KEYS.join(", ")}`, 4);
        // Match what the generator actually accepts, including YAML's yes/no.
        if (BOOL_KEYS.has(key) && val && !["true","false","yes","no"].includes(val.toLowerCase()))
          mark(lineNum, `"${key}" must be True or False`);
        if (key === "Mode" && val && !MODE_VALUES.map(v=>v.toLowerCase()).includes(val.toLowerCase()))
          mark(lineNum, `Mode must be Access or Trunk`);
        if (key === "VLAN" && val && (isNaN(parseInt(val)) || parseInt(val) < 1 || parseInt(val) > 4094))
          mark(lineNum, `VLAN must be a number between 1 and 4094`);
        if (key === "ChannelMode" && val && !CHANNEL_MODE_VALUES.map(v=>v.toLowerCase()).includes(val.toLowerCase()))
          mark(lineNum, `ChannelMode must be one of: ${CHANNEL_MODE_VALUES.join(", ")}`, 4);
        if (key === "Interfaces" && val) {
          // validate interface shorthand format
          const parts = val.split(",").map(s => s.trim());
          for (const part of parts) {
            if (part.match(/^\d+\/\d+\/\d+$/)) continue; // uplink
            if (part.match(/^\d+\/\d+$/)) continue;       // access
            if (part.match(/^\d+\/\d+\s*-\s*\d+\/\d+$/)) continue; // range
            if (part) mark(lineNum, `Invalid interface "${part}" — use 1/1, 1/1/1, or 1/1 - 1/5`, 4);
          }
        }
      }
      continue;
    }

    if (indent !== 0 && indent !== 2)
      mark(lineNum, `Unexpected indent (${indent} spaces) — use 0 or 2 spaces only`, 4);
  }

  if (!hasDevices)
    markers.push({ startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 1, message: 'Missing required "Devices" section', severity: 8 });

  return markers;
}

// ── YAML autocomplete provider ─────────────────────────────────────────────
function getCompletions(model, position) {
  const text = model.getValue();
  const lines = text.split("\n");
  const lineIdx = position.lineNumber - 1;
  const currentLine = lines[lineIdx] || "";
  const indent = currentLine.search(/\S/);
  const trimmed = currentLine.trim();

  // Figure out context
  let topContext = null, currentGroup = null;
  for (let i = 0; i < lineIdx; i++) {
    const l = lines[i].replace(/\r/, "");
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = l.search(/\S/);
    if (ind === 0) {
      const m = l.trim().match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim(); const val = m[2].trim();
      if (TOP_LEVEL_RESERVED.includes(key)) { topContext = key; currentGroup = null; }
      else if (!val) { topContext = null; currentGroup = key; }
      else { topContext = null; currentGroup = null; }
    }
  }

  const suggestions = [];
  const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: 1, endColumn: currentLine.length + 1 };

  if (indent === 0 || trimmed === "") {
    // Top level suggestions
    for (const k of [...TOP_LEVEL_RESERVED, "MyPortGroup"]) {
      suggestions.push({ label: k, kind: 14, insertText: `${k}:\n  `, range, detail: "Top-level section" });
    }
  } else if (indent === 2) {
    if (topContext === "Management") {
      const pairs = [["IP", "192.168.1.10/24"],["VLAN","10"],["DefaultGW","192.168.1.1"]];
      for (const [k, v] of pairs)
        suggestions.push({ label: k, kind: 14, insertText: `${k}: ${v}`, range, detail: "Management field" });
    } else if (topContext === "Devices") {
      suggestions.push({ label: "1: ModelName", kind: 14, insertText: "1: C9300-24P", range, detail: "Member 1 model" });
      suggestions.push({ label: "2: ModelName", kind: 14, insertText: "2: C9300-48P", range, detail: "Member 2 model" });
    } else if (topContext === "Modules") {
      suggestions.push({ label: "1/1: ModuleName", kind: 14, insertText: "1/1: NM-8X", range, detail: "Member/Slot: Module" });
    } else if (currentGroup) {
      const snippets = [
        ["Interfaces", "Interfaces: 1/1, 1/3"],
        ["Mode", "Mode: Access"],
        ["VLAN", "VLAN: 10"],
        ["Dot1x", "Dot1x: True"],
        ["Shutdown", "Shutdown: False"],
        ["Description", 'Description: "My ports"'],
        ["UplinkModule", "UplinkModule: False"],
        ["PortChannel", "PortChannel: True"],
        ["ChannelGroup", "ChannelGroup: 1"],
        ["ChannelMode", "ChannelMode: Active"],
        ["Range", "Range: True"],
      ];
      for (const [k, v] of snippets)
        suggestions.push({ label: k, kind: 14, insertText: v, range, detail: "Port group field" });
    }
  }

  return { suggestions };
}

// ── CIDR helpers ───────────────────────────────────────────────────────────
function cidrToMask(cidr) {
  const prefix = parseInt(cidr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map(s => (mask >> s) & 0xff).join(".");
}
function parseIPCIDR(ipcidr) {
  const [ip, prefix] = ipcidr.split("/");
  if (!ip || !prefix) return null;
  const mask = cidrToMask(prefix);
  if (!mask) return null;
  return { ip: ip.trim(), mask };
}

// ── YAML parser ────────────────────────────────────────────────────────────
// js-yaml handles the syntax (quoting, comments, tabs, duplicate keys); the
// line-based validator above owns the schema. It types scalars, so every value
// is normalized back to the flat string dialect the generator compares against
// ("True"/"False", "10") rather than booleans and numbers.
function normalizeScalars(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(normalizeScalars);
  if (typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeScalars(x)]));
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

function parseYAML(text) {
  const doc = yamlLoad(text);   // throws YAMLException; callers surface it
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  return normalizeScalars(doc);
}

// ── Interface token parser ─────────────────────────────────────────────────
function parseInterfaceTokens(ifaceStr) {
  if (!ifaceStr) return [];
  const tokens = [];
  const parts = ifaceStr.split(",").map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const rangeM = part.match(/^(\d+)\/(\d+)\s*-\s*(\d+)\/(\d+)$/);
    if (rangeM) {
      const [, m1, p1, m2, p2] = rangeM.map(Number);
      if (m1 === m2) tokens.push({ type: "range", sh1: `${m1}/${p1}`, sh2: `${m1}/${p2}`, member: m1, p1, p2 });
      else for (let p = p1; p <= p2; p++) tokens.push({ type: "single", sh: `${m1}/${p}` });
      continue;
    }
    tokens.push({ type: "single", sh: part });
  }
  return tokens;
}

function resolveIface(sh, memberModelMap, excelMaps) {
  sh = sh.trim();
  const uplinkM = sh.match(/^(\d+)\/(\d+)\/(\d+)$/);
  if (uplinkM) {
    const [, member, slot, port] = uplinkM.map(Number);
    const modIfaces = excelMaps.modules[`${member}/${slot}`];
    if (!modIfaces?.length) return `! UNRESOLVED_MODULE(${sh})`;
    return modIfaces[port - 1] || `! UNRESOLVED_PORT(${sh})`;
  }
  const accessM = sh.match(/^(\d+)\/(\d+)$/);
  if (accessM) {
    const [, member, port] = accessM.map(Number);
    const model = memberModelMap[member];
    if (!model) return `! UNRESOLVED_MEMBER(${sh})`;
    // Keyed by member so a stack of identical models resolves each member's
    // own interface names rather than collapsing onto member 1's.
    const ifaces = excelMaps.platforms[member];
    if (!ifaces?.length) return `! UNRESOLVED_PLATFORM(${sh}) — no interface data for "${model}"`;
    return ifaces[port - 1] || `! UNRESOLVED_PORT(${sh})`;
  }
  return `! UNRESOLVED(${sh})`;
}

// Stack member and connector type behind a shorthand, so rulesets can match
// on them. Type is null on Port-channel interfaces, which have no connector.
function describePort(sh, maps) {
  const uplinkM = sh.trim().match(/^(\d+)\/(\d+)\/(\d+)$/);
  if (uplinkM) {
    const [, member, slot, port] = uplinkM.map(Number);
    return { member, portType: maps.moduleTypes?.[`${member}/${slot}`]?.[port - 1] || null };
  }
  const accessM = sh.trim().match(/^(\d+)\/(\d+)$/);
  if (accessM) {
    const [, member, port] = accessM.map(Number);
    return { member, portType: maps.platformTypes?.[member]?.[port - 1] || null };
  }
  return { member: null, portType: null };
}

function resolveIfaceRange(token, memberModelMap, excelMaps) {
  const startIface = resolveIface(token.sh1, memberModelMap, excelMaps);
  if (startIface.startsWith("! ")) return { rangeStr: startIface, error: true };
  return { rangeStr: `${startIface.replace(/\d+$/, "")}${token.p1} - ${token.p2}`, error: false };
}

function applyVars(cmd, vars) {
  return cmd.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// ── Config generator ───────────────────────────────────────────────────────
function generateConfig(yaml, excelMaps, { rules, label, naming, management, deviceToggles }) {
  const lines = [];
  const reservedKeys = new Set(TOP_LEVEL_RESERVED);
  const portChannelsDone = new Set();
  const devices = yaml.Devices || {};
  const memberModelMap = {};
  for (const [k, v] of Object.entries(devices)) memberModelMap[parseInt(k, 10)] = v;
  const memberCount = Object.keys(memberModelMap).length;
  const isStack = memberCount > 1;
  const mgmt = yaml.Management || {};
  const mgmtVlan = mgmt.VLAN || null;
  const mgmtGW = mgmt.DefaultGW || null;
  const mgmtIPRaw = mgmt.IP || null;
  const mgmtIP = mgmtIPRaw ? parseIPCIDR(mgmtIPRaw) : null;

  lines.push(`! ================================================`);
  lines.push(`! Generated by Cisco Config Generator`);
  if (isStack) {
    lines.push(`! Stack (${memberCount} members):`);
    for (const [num, model] of Object.entries(memberModelMap)) lines.push(`!   Member ${num}: ${model}`);
  } else {
    lines.push(`! Standalone: ${memberModelMap[1] || "Unknown"}`);
  }
  if (yaml.Modules && Object.keys(yaml.Modules).length)
    for (const [slot, model] of Object.entries(yaml.Modules)) lines.push(`! Module ${slot}: ${model}`);
  const onLoopback = String(management?.interface || "vlan").toLowerCase() === "loopback";
  const loopbackNum = management?.number ?? 0;
  if (onLoopback && mgmtIPRaw) lines.push(`! Management: Loopback${loopbackNum}  IP: ${mgmtIPRaw}`);
  else if (mgmtVlan) lines.push(`! Management VLAN: ${mgmtVlan}${mgmtIPRaw ? `  IP: ${mgmtIPRaw}` : ""}${mgmtGW ? `  GW: ${mgmtGW}` : ""}`);
  if (label) lines.push(`! Ruleset: ${label}`);
  const activeToggles = (deviceToggles || [])
    .filter(t => ["true", "yes"].includes(String(yaml[t.key] ?? "").toLowerCase()));
  for (const t of activeToggles) lines.push(`! ${t.label || t.key}: enabled`);
  lines.push(`! ================================================`);
  lines.push(`!`);

  // Box-wide features first: global config belongs above the interfaces.
  for (const t of activeToggles) {
    for (const cmd of t.commands || []) lines.push(cmd);
    lines.push(`!`);
  }

  if (mgmtGW) { lines.push(`ip default-gateway ${mgmtGW}`); lines.push(`!`); }
  if (onLoopback) {
    // A routed switch addresses itself on a loopback rather than an SVI.
    if (mgmtIPRaw) {
      lines.push(`interface Loopback${loopbackNum}`);
      lines.push(` description Management`);
      if (mgmtIP) lines.push(` ip address ${mgmtIP.ip} ${mgmtIP.mask}`);
      else lines.push(` ! WARNING: Management IP is not valid CIDR`);
      lines.push(`!`);
    }
  } else if (mgmtVlan) {
    lines.push(`interface Vlan${mgmtVlan}`);
    lines.push(` description Management`);
    if (mgmtIP) lines.push(` ip address ${mgmtIP.ip} ${mgmtIP.mask}`);
    else lines.push(` ! WARNING: No IP defined for management VLAN`);
    lines.push(` no shutdown`);
    lines.push(`!`);
  }

  for (const [groupName, grp] of Object.entries(yaml)) {
    if (reservedKeys.has(groupName) || typeof grp !== "object" || Array.isArray(grp)) continue;
    if (!grp || !Object.keys(grp).length) continue;
    const tokens = parseInterfaceTokens(grp.Interfaces || "");
    const isUplinkMod = ["true","yes"].includes((grp.UplinkModule||"").toLowerCase());
    const isUplink = isUplinkMod || (grp.Mode||"").toLowerCase() === "trunk";
    const hasPc = ["true","yes"].includes((grp.PortChannel||"").toLowerCase());
    const cgNum = grp.ChannelGroup || "1";
    const cgMode = (grp.ChannelMode || "active").toLowerCase();
    const dot1x = ["true","yes"].includes((grp.Dot1x||"").toLowerCase());
    const shutdown = ["true","yes"].includes((grp.Shutdown||"").toLowerCase());
    const rangeMode = ["true","yes"].includes((grp.Range||"").toLowerCase());
    const desc = grp.Description || groupName;
    const vlan = grp.VLAN || grp.Vlan || null;

    // Facts shared by every interface in the group; member and portType vary
    // per interface and are merged in per token below.
    const groupFacts = {
      mode: isUplink ? "Trunk" : "Access",
      dot1x, shutdown, portChannel: hasPc, uplinkModule: isUplinkMod,
      hasVlan: Boolean(vlan),
    };
    const vars = { cgNum, cgMode, vlan: vlan || "", description: desc };

    lines.push(`! --- ${groupName} ---`);

    const emitCommands = facts => {
      lines.push(` description ${formatDescription(desc, facts, naming)}`);
      for (const rule of rules) {
        if (!matchesRule(rule.when, facts)) continue;
        const rowVars = { ...vars, portType: facts.portType || "", member: facts.member ?? "", model: facts.model || "" };
        for (const cmd of rule.commands) lines.push(` ${applyVars(cmd, rowVars)}`);
      }
      lines.push(`!`);
    };

    // A range is emitted as a single block, so its facts come from its first
    // port — the wizard never builds a range that spans two connector types.
    const factsFor = sh => {
      const { member, portType } = describePort(sh, excelMaps);
      return { ...groupFacts, interface: "physical", member, portType, model: memberModelMap[member] };
    };

    // Resolve every token to its printable form, keeping the shorthand so the
    // facts for a block can be read off its first interface.
    const entries = [];
    for (const token of tokens) {
      if (token.type === "range") {
        const { rangeStr, error } = resolveIfaceRange(token, memberModelMap, excelMaps);
        if (error) { lines.push(rangeStr); continue; }
        entries.push({ text: rangeStr, sh: token.sh1, isRange: true });
      } else {
        const name = resolveIface(token.sh, memberModelMap, excelMaps);
        if (name.startsWith("! ")) { lines.push(name); continue; }
        entries.push({ text: name, sh: token.sh, isRange: false });
      }
    }

    if (rangeMode) {
      // One "interface range" for the whole group, chunked to what IOS accepts.
      for (let i = 0; i < entries.length; i += MAX_RANGES_PER_COMMAND) {
        const chunk = entries.slice(i, i + MAX_RANGES_PER_COMMAND);
        lines.push(`interface range ${chunk.map(e => e.text).join(", ")}`);
        emitCommands(factsFor(chunk[0].sh));
      }
    } else {
      for (const e of entries) {
        lines.push(e.isRange ? `interface range ${e.text}` : `interface ${e.text}`);
        emitCommands(factsFor(e.sh));
      }
    }

    if (hasPc && !portChannelsDone.has(cgNum)) {
      portChannelsDone.add(cgNum);
      lines.push(`interface Port-channel${cgNum}`);
      // The logical interface has no connector, so portType stays unset and
      // type-conditioned rules correctly skip it.
      emitCommands({ ...groupFacts, interface: "port-channel", member: null, portType: null });
    }
  }
  return lines.join("\n");
}

// ── Sample YAML ────────────────────────────────────────────────────────────
const SAMPLE_YAML = `Devices:
  1: C9300-24P
  2: C9300-48P
Modules:
  1/1: NM-8X
Management:
  IP: 192.168.1.10/24
  VLAN: 10
  DefaultGW: 192.168.1.1

Vlan10:
  Interfaces: 1/1, 1/3, 1/5
  Mode: Access
  VLAN: 10
  Dot1x: True
  Shutdown: False
  Description: "Workstations"

Vlan20:
  Interfaces: 1/6 - 1/10, 2/1 - 2/5
  Mode: Access
  VLAN: 20
  Dot1x: False
  Shutdown: False
  Description: "Guest WiFi"

Uplink:
  Interfaces: 1/1/1, 1/1/2
  UplinkModule: True
  Mode: Trunk
  PortChannel: True
  ChannelGroup: 1
  ChannelMode: Active
  Description: "Uplink to Core"
`;

// ── Defaults Modal ─────────────────────────────────────────────────────────
function DefaultsModal({ defaults, rulesetId, onSave, onClose }) {
  const [copied, setCopied] = useState(false);
  const [local, setLocal] = useState(
    () => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.join("\n")]))
  );
  const [activeKey, setActiveKey] = useState(DEFAULTS_META[0].key);
  const activeMeta = DEFAULTS_META.find(m => m.key === activeKey);

  // The command buckets are editable here; the policy sections are not, because
  // they change what the wizard does and belong in review. Showing them anyway
  // beats leaving people to discover them by reading Rulesets.json.
  const naming = rulesetNaming(rulesetId);
  const portDefaults = rulesetPortDefaults(rulesetId);
  const uplinks = rulesetUplinks(rulesetId);
  const policyRows = [
    ...(Object.keys(portDefaults).length
      ? [["New port groups start with", Object.entries(portDefaults).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")]] : []),
    ...(naming.prefix ? [["Description prefix", `"${naming.prefix}"`]] : []),
    ...(naming.noDot1xSuffix ? [["Appended without dot1x", `"${naming.noDot1xSuffix}" (access ports only)`]] : []),
    ...(uplinks ? [
      ["Uplinks, standalone", `${uplinks.standaloneCount ?? 2} port(s)`],
      ["Uplinks, per stack member", `${uplinks.perMember ?? 1} port(s)`],
      ["Uplink ports taken from", uplinks.prefer === "module" ? "the network module, else onboard" : "onboard ports"],
      ["Uplink port-channel", `group ${uplinks.channelGroup ?? 1}, ${uplinks.channelMode || "Active"} mode`],
    ] : []),
  ];
  const hasPolicy = policyRows.length > 0 || rulesetRuleCount(rulesetId) > 0;
  const handleSave = () => {
    onSave(Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v.split("\n").map(s => s.trim()).filter(Boolean)])));
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, width: 680, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Ruleset — {rulesetName(rulesetId)}</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
              Edit IOS commands per condition, one per line. Changes apply to this session only.
            </div>
            {rulesetRuleCount(rulesetId) > 0 && (
              <div style={{ fontSize: 12, color: "#facc15", marginTop: 5 }}>
                + {rulesetRuleCount(rulesetId)} condition rule(s) in Rulesets.json — edit the file to change those.
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          <div style={{ width: 190, borderRight: "1px solid #334155", padding: "10px 0", overflowY: "auto", flexShrink: 0 }}>
            {DEFAULTS_META.map(m => (
              <button key={m.key} onClick={() => setActiveKey(m.key)} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 16px", border: "none", cursor: "pointer", background: activeKey === m.key ? "#0f172a" : "none", color: activeKey === m.key ? "#e2e8f0" : "#94a3b8", fontSize: 13, fontWeight: activeKey === m.key ? 600 : 400, borderLeft: activeKey === m.key ? "3px solid #3b82f6" : "3px solid transparent" }}>
                {m.label}
              </button>
            ))}
            {hasPolicy && (
              <button onClick={() => setActiveKey("__policy")}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 16px", border: "none", cursor: "pointer", marginTop: 6, borderTop: "1px solid #334155", background: activeKey === "__policy" ? "#0f172a" : "none", color: activeKey === "__policy" ? "#e2e8f0" : "#94a3b8", fontSize: 13, fontWeight: activeKey === "__policy" ? 600 : 400, borderLeft: activeKey === "__policy" ? "3px solid #facc15" : "3px solid transparent" }}>
                Policy <span style={{ color: "#64748b", fontSize: 11 }}>read-only</span>
              </button>
            )}
          </div>
          <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
            {activeKey === "__policy" ? (
              <>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "#e2e8f0", marginBottom: 4 }}>Policy</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    What this ruleset does beyond the command buckets. Change these in Rulesets.json, where CI checks them.
                  </div>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <tbody>
                    {policyRows.map(([k, v]) => (
                      <tr key={k} style={{ borderBottom: "1px solid #1e293b" }}>
                        <td style={{ padding: "7px 12px 7px 0", color: "#94a3b8", whiteSpace: "nowrap" }}>{k}</td>
                        <td style={{ padding: "7px 0", color: "#e2e8f0" }}>{v}</td>
                      </tr>
                    ))}
                    {rulesetRuleCount(rulesetId) > 0 && (
                      <tr style={{ borderBottom: "1px solid #1e293b" }}>
                        <td style={{ padding: "7px 12px 7px 0", color: "#94a3b8", whiteSpace: "nowrap" }}>Condition rules</td>
                        <td style={{ padding: "7px 0", color: "#e2e8f0" }}>{rulesetRuleCount(rulesetId)}, applied after the buckets above</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {!policyRows.length && (
                  <div style={{ fontSize: 12, color: "#64748b" }}>This ruleset defines no naming, port defaults or uplink policy.</div>
                )}
              </>
            ) : (
              <>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "#e2e8f0", marginBottom: 4 }}>{activeMeta.label}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>{activeMeta.hint}</div>
                </div>
                <textarea value={local[activeKey]} onChange={e => setLocal(prev => ({ ...prev, [activeKey]: e.target.value }))} spellCheck={false}
                  style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.7, background: "#0d1117", color: "#a3e635", border: "1px solid #334155", borderRadius: 8, padding: 14, flex: 1, minHeight: 180, resize: "vertical", outline: "none", width: "100%", boxSizing: "border-box" }} />
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={() => setLocal(prev => ({ ...prev, [activeKey]: rulesetCommands(rulesetId)[activeKey].join("\n") }))}
                    style={{ padding: "5px 12px", borderRadius: 6, background: "none", border: "1px solid #475569", color: "#64748b", cursor: "pointer", fontSize: 12 }}>
                    ↺ Reset this section
                  </button>
                  {/* Makes an in-session tweak reviewable: paste into Rulesets.json, open a PR. */}
                  <button onClick={() => {
                    const commands = Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v.split("\n").map(s => s.trim()).filter(Boolean)]));
                    navigator.clipboard?.writeText(toRulesetJSON(rulesetId, commands));
                    setCopied(true); setTimeout(() => setCopied(false), 2000);
                  }}
                    style={{ padding: "5px 12px", borderRadius: 6, background: "none", border: "1px solid #475569", color: copied ? "#a3e635" : "#64748b", cursor: "pointer", fontSize: 12 }}>
                    {copied ? "✓ Copied" : "⧉ Copy JSON for Rulesets.json"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div style={{ padding: "14px 20px", borderTop: "1px solid #334155", display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 7, background: "none", border: "1px solid #475569", color: "#94a3b8", cursor: "pointer", fontSize: 13 }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 7, background: "#3b82f6", border: "none", color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Save & Close</button>
        </div>
      </div>
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────
export default function App() {
  const [yamlText, setYamlText]         = useState(SAMPLE_YAML);
  const [config, setConfig]             = useState("");
  const [error, setError]               = useState("");
  const [rulesetId, setRulesetId]       = useState(DEFAULT_RULESET_ID);
  const [defaults, setDefaults]         = useState(() => rulesetCommands(DEFAULT_RULESET_ID));
  const [showDefaults, setShowDefaults] = useState(false);
  const [showRef, setShowRef]           = useState(false);
  const [markers, setMarkers]           = useState([]);
  const [mode, setMode]                 = useState("wizard"); // "wizard" | "yaml"
  const [editorReady, setEditorReady]   = useState(false);
  const yamlFileRef = useRef(null);
  const monaco = useMonaco();
  const editorRef = useRef(null);

  // Register language config once Monaco loads
  useEffect(() => {
    if (!monaco) return;

    // Custom YAML-like language for our schema
    monaco.languages.register({ id: "cisco-yaml" });
    monaco.languages.setMonarchTokensProvider("cisco-yaml", {
      tokenizer: {
        root: [
          [/^\s*#.*$/, "comment"],
          [/^[A-Za-z][A-Za-z0-9_-]*(?=\s*:)/, "keyword.section"],
          [/^\s{2}[A-Za-z][A-Za-z0-9_/-]*(?=\s*:)/, "keyword.field"],
          [/:\s*(True|False|true|false)/, ["delimiter", "constant.language"]],
          [/:\s*(\d+)/, ["delimiter", "number"]],
          [/:\s*"[^"]*"/, ["delimiter", "string"]],
          [/:\s*([^\s#][^#]*)/, ["delimiter", "string.value"]],
        ]
      }
    });
    monaco.editor.defineTheme("cisco-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword.section",   foreground: "60a5fa", fontStyle: "bold" },
        { token: "keyword.field",     foreground: "94a3b8" },
        { token: "constant.language", foreground: "f97316" },
        { token: "number",            foreground: "a78bfa" },
        { token: "string",            foreground: "a3e635" },
        { token: "string.value",      foreground: "e2e8f0" },
        { token: "comment",           foreground: "475569", fontStyle: "italic" },
      ],
      colors: { "editor.background": "#0d1117" }
    });

    // Autocomplete
    monaco.languages.registerCompletionItemProvider("cisco-yaml", {
      provideCompletionItems: (model, position) => getCompletions(model, position)
    });
  }, [monaco]);

  // Live validation — runs on every YAML change, and once the editor mounts
  // (which happens late when arriving from the wizard).
  useEffect(() => {
    if (!monaco || !editorRef.current) return;
    const m = validateYAML(yamlText);
    setMarkers(m);
    const model = editorRef.current.getModel();
    if (model) monaco.editor.setModelMarkers(model, "cisco-yaml", m);
  }, [yamlText, monaco, editorReady]);

  // Monaco sizes itself on mount, which happens while the YAML pane is hidden.
  // Re-measure whenever it becomes visible, or it renders zero-height.
  useEffect(() => {
    if (mode === "yaml") editorRef.current?.layout();
  }, [mode, editorReady]);

  const handleYamlImport = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setYamlText(ev.target.result); setError(""); };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Validates `text` directly rather than the markers state, so generating
  // straight from the wizard doesn't race the validation effect.
  const runGenerate = text => {
    const errors = validateYAML(text).filter(m => m.severity === 8);
    if (errors.length) { setError(`Fix ${errors.length} error(s) before generating.`); setConfig(""); return; }
    try {
      setError("");
      const yaml = parseYAML(text);
      const mgmt = yaml.Management || {};
      if (mgmt.IP && !parseIPCIDR(mgmt.IP)) throw new Error(`Invalid IP: "${mgmt.IP}"`);
      // The YAML names the ruleset, so a committed file regenerates identically
      // on anyone's machine. In-session edits apply only to the selected one.
      const rsId = yaml.Ruleset || rulesetId;
      if (!isKnownRuleset(rsId))
        throw new Error(`Unknown ruleset "${rsId}". Available: ${RULESET_IDS.join(", ")}`);
      const commands = rsId === rulesetId ? defaults : rulesetCommands(rsId);

      const members = Object.entries(yaml.Devices || {});
      const ifaceMaps = buildHardwareMaps(yaml.Devices, yaml.Modules);
      const missing = members.filter(([m]) => !ifaceMaps.platforms[parseInt(m, 10)]?.length);
      if (missing.length) throw new Error(
        `Not in Switch_Hardware.json: ${missing.map(([m, mdl]) => `member ${m} (${mdl})`).join(", ")}`);

      setConfig(generateConfig(yaml, ifaceMaps, {
        rules: rulesetRules(rsId, commands),
        label: rulesetName(rsId),
        naming: rulesetNaming(rsId),
        management: rulesetManagement(rsId),
        deviceToggles: rulesetDeviceToggles(rsId),
      }));
    } catch (e) { setError(e.message); setConfig(""); }
  };

  const handleGenerate = () => runGenerate(yamlText);

  // Switching ruleset reloads its commands from Rulesets.json, dropping any
  // in-session edits to the previous one.
  const selectRuleset = id => { setRulesetId(id); setDefaults(rulesetCommands(id)); };

  // Wizard hands over finished YAML: show it in the editor and generate.
  const handleWizardApply = text => { setYamlText(text); setMode("yaml"); runGenerate(text); };

  const handleDownload = () => {
    const blob = new Blob([config], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "switch-config.cfg"; a.click();
  };

  const errorCount   = markers.filter(m => m.severity === 8).length;
  const warningCount = markers.filter(m => m.severity === 4).length;

  const btnSecondary = { padding: "8px 14px", borderRadius: 7, cursor: "pointer", fontSize: 13, background: "#1e293b", border: "1px solid #334155", color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0f172a", height: "100vh", overflow: "hidden", color: "#e2e8f0" }}>
      {showDefaults && <DefaultsModal defaults={defaults} rulesetId={rulesetId} onSave={setDefaults} onClose={() => setShowDefaults(false)} />}

      {/* Header */}
      <div style={{ background: "#1e293b", borderBottom: "1px solid #334155", padding: "13px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ background: "#3b82f6", borderRadius: 8, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>⚙</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Cisco IOS Config Generator</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>Pick hardware → IOS .cfg · YAML generated for you</div>
        </div>
        <div style={{ display: "flex", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: 3, gap: 3 }}>
          {[["wizard", "🧭 Wizard"], ["yaml", "📝 YAML"]].map(([m, lbl]) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                background: mode === m ? "#3b82f6" : "transparent", color: mode === m ? "#fff" : "#94a3b8" }}>
              {lbl}
            </button>
          ))}
        </div>
        <select value={rulesetId} onChange={e => selectRuleset(e.target.value)} title={rulesetSummary(rulesetId)}
          style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#cbd5e1", padding: "8px 10px", fontSize: 13, outline: "none" }}>
          {RULESET_OPTIONS.map(r => <option key={r.id} value={r.id}>📋 {r.name}</option>)}
        </select>
        <button onClick={() => setShowDefaults(true)} style={{ ...btnSecondary, borderColor: "#475569", color: "#cbd5e1" }}>⚙ Edit Ruleset</button>
      </div>

      <div style={{ padding: "24px 40px", width: "100%", boxSizing: "border-box", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, height: "calc(100vh - 62px)" }}>

        {/* LEFT */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

          {/* Both panes stay mounted and are toggled with CSS: unmounting the
              wizard would throw away every selection on a trip to the YAML view. */}
          <div style={{ display: mode === "wizard" ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <Wizard onApply={handleWizardApply} rulesetId={rulesetId} onRulesetChange={selectRuleset} />
          </div>

          <div style={{ display: mode === "yaml" ? "flex" : "none", flexDirection: "column", height: "100%", minHeight: 0 }}>

          {/* Top scrollable: quick ref */}
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>

            {/* Collapsible quick ref */}
            <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}>
              <div onClick={() => setShowRef(v => !v)} style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", userSelect: "none" }}>
                <span style={{ fontWeight: 600, color: "#94a3b8" }}>YAML quick reference</span>
                <span style={{ color: "#475569", fontSize: 11 }}>{showRef ? "▲ collapse" : "▼ expand"}</span>
              </div>
              {showRef && (
                <div style={{ padding: "0 14px 12px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <tbody>
                      {[
                        ["Devices","1 entry = standalone · 2+ = stack (auto)"],
                        ["Modules","member/slot: Model  e.g.  1/1: NM-8X"],
                        ["Management","IP (CIDR), VLAN, DefaultGW — all optional"],
                        ["1/5","Member 1, port 5"],
                        ["2/1 - 2/8","Range: member 2, ports 1–8"],
                        ["1/1/2","Uplink module: member 1, slot 1, port 2"],
                        ["UplinkModule: True","Resolves via module tab, not platform tab"],
                        ["PortChannel: True","Physical interfaces first, then Port-channel"],
                      ].map(([k,v]) => (
                        <tr key={k} style={{ borderBottom: "1px solid #1e3a5f" }}>
                          <td style={{ padding: "4px 10px 4px 0", whiteSpace: "nowrap" }}><code style={{ color: "#e2e8f0" }}>{k}</code></td>
                          <td style={{ padding: "4px 0", color: "#64748b" }}>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Monaco editor — flex:1 fills remaining space */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexShrink: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8" }}>
                2. Switch YAML
                {errorCount > 0 && <span style={{ marginLeft: 8, background: "#7f1d1d", color: "#fca5a5", borderRadius: 4, padding: "1px 7px", fontSize: 11 }}>✕ {errorCount} error{errorCount>1?"s":""}</span>}
                {warningCount > 0 && <span style={{ marginLeft: 6, background: "#78350f", color: "#fcd34d", borderRadius: 4, padding: "1px 7px", fontSize: 11 }}>⚠ {warningCount} warning{warningCount>1?"s":""}</span>}
              </div>
              <button onClick={() => yamlFileRef.current?.click()} style={{ ...btnSecondary, fontSize: 12, padding: "5px 12px" }}>
                📂 Import .yaml
              </button>
              <input ref={yamlFileRef} type="file" accept=".yaml,.yml,.txt" style={{ display: "none" }} onChange={handleYamlImport} />
            </div>
            <div style={{ flex: 1, minHeight: 0, borderRadius: 8, overflow: "hidden", border: "1px solid #334155" }}>
              <Editor
                height="100%"
                language="cisco-yaml"
                theme="cisco-dark"
                value={yamlText}
                onChange={v => setYamlText(v || "")}
                onMount={editor => { editorRef.current = editor; setEditorReady(true); }}
                options={{
                  fontSize: 13,
                  lineHeight: 22,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  renderLineHighlight: "line",
                  suggestOnTriggerCharacters: true,
                  quickSuggestions: true,
                  padding: { top: 12, bottom: 12 },
                  scrollbar: { verticalScrollbarSize: 6 },
                }}
              />
            </div>

            {/* Live error/warning panel */}
            {markers.length > 0 && (
              <div style={{ marginTop: 8, background: "#0d1117", border: "1px solid #334155", borderRadius: 6, maxHeight: 110, overflowY: "auto", flexShrink: 0 }}>
                {markers.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 10px", borderBottom: "1px solid #1e293b", fontSize: 12 }}>
                    <span style={{ color: m.severity === 8 ? "#f87171" : "#fcd34d", flexShrink: 0 }}>{m.severity === 8 ? "✕" : "⚠"}</span>
                    <span style={{ color: "#64748b", flexShrink: 0 }}>Line {m.startLineNumber}</span>
                    <span style={{ color: m.severity === 8 ? "#fca5a5" : "#fde68a" }}>{m.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pinned button */}
          <div style={{ paddingTop: 12, flexShrink: 0 }}>
            <button onClick={handleGenerate}
              style={{ width: "100%", padding: 11, borderRadius: 8, background: errorCount > 0 ? "#1e3a5f" : "#3b82f6", border: "none", color: errorCount > 0 ? "#64748b" : "#fff", fontWeight: 700, cursor: errorCount > 0 ? "not-allowed" : "pointer", fontSize: 14 }}>
              {errorCount > 0 ? `✕ Fix ${errorCount} error${errorCount>1?"s":""} to generate` : "▶ Generate Config"}
            </button>
            {error && <div style={{ marginTop: 8, background: "#450a0a", border: "1px solid #b91c1c", borderRadius: 8, padding: 12, color: "#fca5a5", fontSize: 13 }}>⚠ {error}</div>}
          </div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", overflow: "hidden" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
            <span>3. Generated IOS Config</span>
            {config && (
              <button onClick={handleDownload} style={{ padding: "6px 14px", borderRadius: 6, background: "#1e293b", border: "1px solid #3b82f6", color: "#3b82f6", fontWeight: 600, cursor: "pointer", fontSize: 12 }}>
                ↓ Download .cfg
              </button>
            )}
          </div>
          <pre style={{ fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.7, background: "#0d1117", color: config ? "#a3e635" : "#334155", border: "1px solid #334155", borderRadius: 8, padding: 16, flex: 1, minHeight: 0, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {config || "// Output will appear here after clicking Generate Config"}
          </pre>
        </div>
      </div>
    </div>
  );
}
