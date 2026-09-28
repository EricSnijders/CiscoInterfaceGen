import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import Editor, { useMonaco } from "@monaco-editor/react";
import Wizard from "./Wizard";
import { buildHardwareMaps } from "./ref/hardware";

// ── Default command sets ───────────────────────────────────────────────────
const INITIAL_DEFAULTS = {
  dot1x:        ["authentication port-control auto","dot1x pae authenticator","spanning-tree portfast"],
  access:       ["switchport mode access"],
  trunk:        ["switchport mode trunk"],
  portchannel:  ["channel-group {cgNum} mode {cgMode}"],
  shutdownTrue: ["shutdown"],
  shutdownFalse:["no shutdown"],
};
const DEFAULTS_META = [
  { key: "dot1x",         label: "Dot1x = True",       hint: "Added to every access port when Dot1x: True" },
  { key: "access",        label: "Access mode",         hint: "Added to every access port (non-trunk)" },
  { key: "trunk",         label: "Trunk mode",          hint: "Added to every trunk/uplink port" },
  { key: "portchannel",   label: "Port-channel member", hint: "Added to physical ports in a port-channel. Use {cgNum} and {cgMode} as placeholders." },
  { key: "shutdownTrue",  label: "Shutdown = True",     hint: "Added when Shutdown: True" },
  { key: "shutdownFalse", label: "Shutdown = False",    hint: "Added when Shutdown: False" },
];

// ── YAML schema: known keys per context ───────────────────────────────────
const TOP_LEVEL_RESERVED = ["Devices", "Modules", "Management"];
const PORT_GROUP_KEYS = ["Interfaces","Mode","VLAN","Dot1x","Shutdown","Description","UplinkModule","PortChannel","ChannelGroup","ChannelMode"];
const BOOL_KEYS = new Set(["Dot1x","Shutdown","UplinkModule","PortChannel"]);
const MODE_VALUES = ["Access","Trunk"];
const CHANNEL_MODE_VALUES = ["Active","Passive","On","Auto","Desirable"];
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
      else if (TOP_LEVEL_RESERVED.includes(key)) { topContext = key; currentGroup = null; }
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
        if (BOOL_KEYS.has(key) && val && !["True","False","true","false"].includes(val))
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
function parseYAML(text) {
  const lines = text.split("\n");
  const root = {};
  let topContext = null;
  let currentGroup = null;
  for (const raw of lines) {
    const line = raw.replace(/\r/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    if (indent === 0) {
      const m = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (val) { root[key] = val; topContext = null; currentGroup = null; }
      else {
        if (TOP_LEVEL_RESERVED.includes(key)) { root[key] = {}; topContext = key; currentGroup = null; }
        else { root[key] = {}; topContext = null; currentGroup = key; }
      }
      continue;
    }
    if (indent === 2) {
      const m = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim().replace(/^["']|["']$/g, "");
      if (topContext) root[topContext][key] = val;
      else if (currentGroup) root[currentGroup][key] = val;
    }
  }
  return root;
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
    const ifaces = excelMaps.platforms[model];
    if (!ifaces?.length) return `! UNRESOLVED_PLATFORM(${sh}) — no tab for "${model}"`;
    return ifaces[port - 1] || `! UNRESOLVED_PORT(${sh})`;
  }
  return `! UNRESOLVED(${sh})`;
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
function generateConfig(yaml, excelMaps, defaults) {
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
  if (mgmtVlan) lines.push(`! Management VLAN: ${mgmtVlan}${mgmtIPRaw ? `  IP: ${mgmtIPRaw}` : ""}${mgmtGW ? `  GW: ${mgmtGW}` : ""}`);
  lines.push(`! ================================================`);
  lines.push(`!`);
  if (mgmtGW) { lines.push(`ip default-gateway ${mgmtGW}`); lines.push(`!`); }
  if (mgmtVlan) {
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
    const desc = grp.Description || groupName;
    const vlan = grp.VLAN || grp.Vlan || null;
    const pcVars = { cgNum, cgMode };
    lines.push(`! --- ${groupName} ---`);
    const emitCommands = () => {
      lines.push(` description ${desc}`);
      if (isUplink) {
        for (const cmd of defaults.trunk) lines.push(` ${applyVars(cmd, pcVars)}`);
      } else {
        if (vlan) lines.push(` switchport access vlan ${vlan}`);
        for (const cmd of defaults.access) lines.push(` ${applyVars(cmd, pcVars)}`);
        if (dot1x) for (const cmd of defaults.dot1x) lines.push(` ${applyVars(cmd, pcVars)}`);
      }
      if (hasPc) for (const cmd of defaults.portchannel) lines.push(` ${applyVars(cmd, pcVars)}`);
      const sdCmds = shutdown ? defaults.shutdownTrue : defaults.shutdownFalse;
      for (const cmd of sdCmds) lines.push(` ${applyVars(cmd, pcVars)}`);
      lines.push(`!`);
    };
    for (const token of tokens) {
      if (token.type === "range") {
        const { rangeStr, error } = resolveIfaceRange(token, memberModelMap, excelMaps);
        if (error) { lines.push(rangeStr); continue; }
        lines.push(`interface range ${rangeStr}`);
        emitCommands();
      } else {
        lines.push(`interface ${resolveIface(token.sh, memberModelMap, excelMaps)}`);
        emitCommands();
      }
    }
    if (hasPc && !portChannelsDone.has(cgNum)) {
      portChannelsDone.add(cgNum);
      lines.push(`interface Port-channel${cgNum}`);
      lines.push(` description ${desc}`);
      if (isUplink) {
        for (const cmd of defaults.trunk) lines.push(` ${applyVars(cmd, pcVars)}`);
      } else {
        if (vlan) lines.push(` switchport access vlan ${vlan}`);
        for (const cmd of defaults.access) lines.push(` ${applyVars(cmd, pcVars)}`);
      }
      const sdCmds = shutdown ? defaults.shutdownTrue : defaults.shutdownFalse;
      for (const cmd of sdCmds) lines.push(` ${applyVars(cmd, pcVars)}`);
      lines.push(`!`);
    }
  }
  return lines.join("\n");
}

// ── Parse Excel ────────────────────────────────────────────────────────────
function parseExcelMaps(wb, devices, modulesYaml) {
  const platforms = {};
  for (const model of new Set(Object.values(devices))) {
    const sheet = wb.Sheets[model];
    if (!sheet) continue;
    platforms[model] = XLSX.utils.sheet_to_json(sheet, { header: 1 })
      .filter(r => r?.[0] && typeof r[0] === "string").map(r => r[0].trim());
  }
  const modules = {};
  if (modulesYaml) {
    for (const [slotKey, modModel] of Object.entries(modulesYaml)) {
      const sheet = wb.Sheets[modModel];
      if (!sheet) continue;
      modules[slotKey] = XLSX.utils.sheet_to_json(sheet, { header: 1 })
        .filter(r => r?.[0] && typeof r[0] === "string").map(r => r[0].trim());
    }
  }
  return { platforms, modules };
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
function DefaultsModal({ defaults, onSave, onClose }) {
  const [local, setLocal] = useState(
    () => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, v.join("\n")]))
  );
  const [activeKey, setActiveKey] = useState(DEFAULTS_META[0].key);
  const activeMeta = DEFAULTS_META.find(m => m.key === activeKey);
  const handleSave = () => {
    onSave(Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v.split("\n").map(s => s.trim()).filter(Boolean)])));
    onClose();
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 12, width: 680, maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Command Defaults</div>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>Edit IOS commands per condition. One per line.</div>
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
          </div>
          <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#e2e8f0", marginBottom: 4 }}>{activeMeta.label}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>{activeMeta.hint}</div>
            </div>
            <textarea value={local[activeKey]} onChange={e => setLocal(prev => ({ ...prev, [activeKey]: e.target.value }))} spellCheck={false}
              style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.7, background: "#0d1117", color: "#a3e635", border: "1px solid #334155", borderRadius: 8, padding: 14, flex: 1, minHeight: 180, resize: "vertical", outline: "none", width: "100%", boxSizing: "border-box" }} />
            <button onClick={() => setLocal(prev => ({ ...prev, [activeKey]: INITIAL_DEFAULTS[activeKey].join("\n") }))}
              style={{ alignSelf: "flex-start", padding: "5px 12px", borderRadius: 6, background: "none", border: "1px solid #475569", color: "#64748b", cursor: "pointer", fontSize: 12 }}>
              ↺ Reset this section
            </button>
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
  const [workbook, setWorkbook]         = useState(null);
  const [excelName, setExcelName]       = useState("");
  const [config, setConfig]             = useState("");
  const [error, setError]               = useState("");
  const [dragging, setDragging]         = useState(false);
  const [defaults, setDefaults]         = useState(INITIAL_DEFAULTS);
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
          [/^\s{2}[A-Za-z][A-Za-z0-9_\/\-]*(?=\s*:)/, "keyword.field"],
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

  const handleExcel = async file => {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    setWorkbook(wb); setExcelName(file.name); setError("");
  };

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
      let ifaceMaps;
      if (workbook) {
        // An uploaded workbook overrides the built-in hardware library.
        ifaceMaps = parseExcelMaps(workbook, yaml.Devices, yaml.Modules);
        const missing = [...new Set(Object.values(yaml.Devices||{}))].filter(m => !ifaceMaps.platforms[m]);
        if (missing.length) throw new Error(`No Excel tab for: ${missing.join(", ")}. Available: ${workbook.SheetNames.join(", ")}`);
      } else {
        ifaceMaps = buildHardwareMaps(yaml.Devices, yaml.Modules);
        const missing = [...new Set(Object.values(yaml.Devices||{}))].filter(m => !ifaceMaps.platforms[m]?.length);
        if (missing.length) throw new Error(`Unknown model(s) in Switch_Hardware.json: ${missing.join(", ")}`);
      }
      setConfig(generateConfig(yaml, ifaceMaps, defaults));
    } catch (e) { setError(e.message); setConfig(""); }
  };

  const handleGenerate = () => runGenerate(yamlText);

  // Wizard hands over finished YAML: show it in the editor and generate.
  const handleWizardApply = text => { setYamlText(text); setMode("yaml"); runGenerate(text); };

  const handleDownload = () => {
    const blob = new Blob([config], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "switch-config.cfg"; a.click();
  };

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) handleExcel(f);
  }, []);

  const errorCount   = markers.filter(m => m.severity === 8).length;
  const warningCount = markers.filter(m => m.severity === 4).length;

  const btnSecondary = { padding: "8px 14px", borderRadius: 7, cursor: "pointer", fontSize: 13, background: "#1e293b", border: "1px solid #334155", color: "#94a3b8", display: "flex", alignItems: "center", gap: 6 };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "#0f172a", height: "100vh", overflow: "hidden", color: "#e2e8f0" }}>
      {showDefaults && <DefaultsModal defaults={defaults} onSave={setDefaults} onClose={() => setShowDefaults(false)} />}

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
        <button onClick={() => setShowDefaults(true)} style={{ ...btnSecondary, borderColor: "#475569", color: "#cbd5e1" }}>⚙ Edit Defaults</button>
      </div>

      <div style={{ padding: "24px 40px", width: "100%", boxSizing: "border-box", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28, height: "calc(100vh - 62px)" }}>

        {/* LEFT */}
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>

          {mode === "wizard" ? <Wizard onApply={handleWizardApply} /> : <>

          {/* Top scrollable: Excel + quick ref */}
          <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>

            {/* Excel upload */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>
                1. Platform Excel <span style={{ color: "#475569", fontWeight: 400 }}>(optional — overrides Switch_Hardware.json)</span>
              </div>
              <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
                onClick={() => document.getElementById("xlFile").click()}
                style={{ border: `2px dashed ${dragging ? "#3b82f6" : "#334155"}`, borderRadius: 8, padding: 14, textAlign: "center", background: dragging ? "#1e3a5f" : "#1e293b", cursor: "pointer", transition: "all .2s" }}>
                {excelName ? <span style={{ color: "#3b82f6", fontWeight: 600 }}>📊 {excelName}</span>
                  : <span style={{ color: "#475569", fontSize: 13 }}>Drop .xlsx here or click to browse</span>}
                <input id="xlFile" type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={e => e.target.files[0] && handleExcel(e.target.files[0])} />
              </div>
              {workbook && <div style={{ marginTop: 6, fontSize: 11, color: "#64748b" }}>Tabs found: {workbook.SheetNames.join(", ")}</div>}
            </div>

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
          </>}
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
