import { useState, useMemo } from "react";
import { SWITCH_MODELS, switchPorts, modulePorts, modulesFor, switchSummary, moduleSummary } from "./ref/hardware";
import { RULESET_OPTIONS, rulesetSummary, rulesetUplinks, rulesetPortDefaults, rulesetNaming,
         rulesetManagement, rulesetDeviceToggles, rulesetPortRoles, formatDescription } from "./ref/rulesets";

// Colors cycled per port group so the grid reads at a glance.
const GROUP_COLORS = ["#3b82f6","#a3e635","#f97316","#a78bfa","#ec4899","#14b8a6","#facc15","#f87171"];
const MODULE_SLOT = 1;   // one uplink module per member, slot 1
const MAX_MEMBERS = 8;   // Catalyst stack limit

const uid = () => Date.now() + Math.random();
const newMember = () => ({ id: uid(), model: SWITCH_MODELS[0], module: "" });
const newGroup  = (n, defaults = {}) => ({
  id: uid(), name: `Group${n}`, mode: "Access", vlan: "",
  dot1x: Boolean(defaults.dot1x), shutdown: Boolean(defaults.shutdown),
  description: "", portChannel: false, rangeMode: false, role: "",
  channelGroup: "1", channelMode: defaults.channelMode || "Active", ports: [],
});

// ── Uplink selection ───────────────────────────────────────────────────────
// Which ports a ruleset's uplink policy would choose. "First port" means the
// lowest-numbered one, which is the order allPorts is already built in:
// module ports when the member has a network module, else onboard ports.
function pickUplinks(allPorts, member, prefer, count) {
  const onModule = allPorts.filter(p => p.member === member && p.isModule);
  const onboard  = allPorts.filter(p => p.member === member && !p.isModule);
  const pool = prefer === "module" && onModule.length ? onModule : onboard;
  return pool.slice(0, count);
}

// A standalone switch takes all its uplinks from the one member; a stack takes
// perMember from each, in member order — that order is the port-channel's.
function uplinkPorts(members, allPorts, policy) {
  if (!policy) return [];
  if (members.length === 1) return pickUplinks(allPorts, 1, policy.prefer, policy.standaloneCount ?? 2);
  return members.flatMap((_, i) => pickUplinks(allPorts, i + 1, policy.prefer, policy.perMember ?? 1));
}

// Role ports are taken from the END of each member's list, in the order the
// roles are declared: SVL claims the last two onboard ports (23, 24), then DAD
// claims the next one still free (22).
function rolePorts(members, allPorts, roles) {
  const claimed = new Set();
  const out = {};
  for (const [name, def] of roles) {
    const { perMember = 1, from = "onboard" } = def.select || {};
    out[name] = members.flatMap((_, i) => {
      const member = i + 1;
      const pool = allPorts.filter(p =>
        p.member === member && (from === "module" ? p.isModule : !p.isModule) && !claimed.has(p.id));
      const take = pool.slice(-perMember);
      take.forEach(p => claimed.add(p.id));
      return take;
    });
  }
  return out;
}

// ── Shorthand + range compression ──────────────────────────────────────────
const shorthand = p => (p.isModule ? `${p.member}/${MODULE_SLOT}/${p.port}` : `${p.member}/${p.port}`);

// Merges only consecutive ports that share a member AND a namePattern, so a
// range never spans a stack member or a connector-speed boundary.
function compressRun(ports) {
  const sorted = [...ports].sort((a, b) => a.port - b.port);
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= 3) out.push(`${shorthand(run[0])} - ${shorthand(run[run.length - 1])}`);
    else run.forEach(p => out.push(shorthand(p)));
    run = [];
  };
  for (const p of sorted) {
    const prev = run[run.length - 1];
    if (prev && p.port === prev.port + 1 && p.patternIdx === prev.patternIdx) run.push(p);
    else { flush(); run = [p]; }
  }
  flush();
  return out;
}

// Groups a mixed selection by member and onboard/module, then compresses each.
function interfaceList(ports) {
  const buckets = new Map();
  for (const p of ports) {
    const key = `${p.member}|${p.isModule ? 1 : 0}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const [ma, ta] = a.split("|").map(Number);
    const [mb, tb] = b.split("|").map(Number);
    return ma - mb || ta - tb;
  });
  return keys.flatMap(k => compressRun(buckets.get(k))).join(", ");
}

// ── YAML emitter — the whole point: indentation is never hand-typed ────────
function buildYAML({ members, ruleset, deviceFlags, mgmt, groups, portsById }) {
  const L = [];
  // Naming the ruleset in the file makes the config reproducible: whoever
  // regenerates it gets the same commands without picking anything.
  if (ruleset) L.push(`Ruleset: ${ruleset}`);
  for (const [key, on] of Object.entries(deviceFlags || {})) if (on) L.push(`${key}: True`);
  L.push(`Devices:`);
  members.forEach((m, i) => L.push(`  ${i + 1}: ${m.model}`));
  const withModules = members.map((m, i) => [i + 1, m.module]).filter(([, mod]) => mod);
  if (withModules.length) {
    L.push(`Modules:`);
    withModules.forEach(([n, mod]) => L.push(`  ${n}/${MODULE_SLOT}: ${mod}`));
  }
  if (mgmt.ip || mgmt.vlan || mgmt.gw) {
    L.push(`Management:`);
    if (mgmt.ip)   L.push(`  IP: ${mgmt.ip}`);
    if (mgmt.vlan) L.push(`  VLAN: ${mgmt.vlan}`);
    if (mgmt.gw)   L.push(`  DefaultGW: ${mgmt.gw}`);
  }
  for (const g of groups) {
    if (!g.ports.length) continue;
    const ports = g.ports.map(id => portsById[id]).filter(Boolean);
    L.push(``, `${g.name}:`);
    L.push(`  Interfaces: ${interfaceList(ports)}`);
    if (g.role) {
      // Role ports take their commands from the ruleset; mode, VLAN and dot1x
      // do not apply to them.
      L.push(`  Role: ${g.role}`);
    } else {
      L.push(`  Mode: ${g.mode}`);
      if (g.mode === "Access" && g.vlan) L.push(`  VLAN: ${g.vlan}`);
      if (ports.some(p => p.isModule)) L.push(`  UplinkModule: True`);
      L.push(`  Dot1x: ${g.dot1x ? "True" : "False"}`);
      L.push(`  Shutdown: ${g.shutdown ? "True" : "False"}`);
      if (g.portChannel)
        L.push(`  PortChannel: True`, `  ChannelGroup: ${g.channelGroup}`, `  ChannelMode: ${g.channelMode}`);
    }
    if (g.rangeMode) L.push(`  Range: True`);
    L.push(`  Description: "${(g.description || g.name).replace(/"/g, "'")}"`);
  }
  return L.join("\n") + "\n";
}

// ── Shared styles ──────────────────────────────────────────────────────────
const card  = { background: "#1e293b", border: "1px solid #334155", borderRadius: 10, padding: 16 };
const label = { fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 6, display: "block" };
// Fixed height so a <select>, a plain <div> and a <button> sitting in the same
// grid row line up: their natural heights differ by a pixel or two otherwise.
const CONTROL_H = 34;
const input = { background: "#0d1117", border: "1px solid #334155", borderRadius: 6, color: "#e2e8f0", padding: "7px 10px", fontSize: 13, width: "100%", height: CONTROL_H, boxSizing: "border-box", outline: "none" };
const stepTitle = { fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 };
const badge = { background: "#3b82f6", color: "#fff", borderRadius: "50%", width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 };
const ghostBtn = { padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, background: "none", border: "1px dashed #475569", color: "#64748b" };
const memberGrid = { display: "grid", gridTemplateColumns: `42px 1fr 1fr ${CONTROL_H}px`, gap: 10 };

export default function Wizard({ onApply, rulesetId, onRulesetChange }) {
  const [members, setMembers]   = useState(() => [newMember()]);
  const [mgmt, setMgmt]         = useState({ ip: "", vlan: "", gw: "" });
  const [groups, setGroups]     = useState(() => [newGroup(1, rulesetPortDefaults(rulesetId))]);
  const [deviceFlags, setDeviceFlags] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [lastPort, setLastPort] = useState(null);

  const isStack = members.length > 1;

  // Flat, ordered port list across every member: member 1 onboard, member 1
  // module, member 2 onboard, … Stable ids survive re-renders; they encode
  // the member so a model change only invalidates that member's ports.
  const { allPorts, portsById } = useMemo(() => {
    const all = [];
    members.forEach((m, i) => {
      const member = i + 1;
      for (const p of switchPorts(m.model, member))
        all.push({ ...p, member, isModule: false, id: `s${member}-${p.port}` });
      if (m.module)
        for (const p of modulePorts(m.module, member))
          all.push({ ...p, member, isModule: true, id: `m${member}-${p.port}` });
    });
    return { allPorts: all, portsById: Object.fromEntries(all.map(p => [p.id, p])) };
  }, [members]);

  // Changing a model or removing a member drops ports that no longer exist.
  const cleanGroups = useMemo(() => {
    const valid = new Set(allPorts.map(p => p.id));
    return groups.map(g => ({ ...g, ports: g.ports.filter(id => valid.has(id)) }));
  }, [groups, allPorts]);

  const active  = cleanGroups.find(g => g.id === activeId) || cleanGroups[0];
  const ownerOf = id => cleanGroups.find(g => g.ports.includes(id));
  const colorOf = g => GROUP_COLORS[cleanGroups.findIndex(x => x.id === g.id) % GROUP_COLORS.length];

  const patchMember = (id, fields) => setMembers(prev => prev.map(m => (m.id === id ? { ...m, ...fields } : m)));
  const patch       = (id, fields) => setGroups(prev => prev.map(g => (g.id === id ? { ...g, ...fields } : g)));

  const uplinkPolicy = rulesetUplinks(rulesetId);
  const naming = rulesetNaming(rulesetId);
  const portDefaults = rulesetPortDefaults(rulesetId);
  const management = rulesetManagement(rulesetId);
  const deviceToggles = rulesetDeviceToggles(rulesetId);
  const onLoopback = String(management.interface || "vlan").toLowerCase() === "loopback";
  const proposedUplinks = useMemo(
    () => uplinkPorts(members, allPorts, uplinkPolicy),
    [members, allPorts, uplinkPolicy]
  );

  // Role groups offered by whichever device toggles are switched on.
  const roleSets = useMemo(() => {
    const all = Object.entries(rulesetPortRoles(rulesetId));
    return deviceToggles
      .filter(t => deviceFlags[t.key])
      .map(t => ({ toggle: t, roles: all.filter(([, def]) => def.requiresToggle === t.key) }))
      .filter(r => r.roles.length);
  }, [rulesetId, deviceToggles, deviceFlags]);

  const addRoleGroups = ({ roles }) => {
    const picked = rolePorts(members, allPorts, roles);
    const taken = new Set(cleanGroups.map(g => g.name.trim()));
    const made = [];
    for (const [name, def] of roles) {
      const ids = (picked[name] || []).map(p => p.id);
      if (!ids.length) continue;
      let gname = name;
      for (let i = 2; taken.has(gname); i++) gname = `${name}${i}`;
      taken.add(gname);
      made.push({
        ...newGroup(groups.length + made.length + 1),
        // The short role name makes a tidier interface description than the
        // full label: ";SVL" rather than ";StackWise Virtual link".
        name: gname, role: name, description: name,
        rangeMode: Boolean(def.range), ports: ids,
      });
    }
    if (!made.length) return;
    const allIds = made.flatMap(g => g.ports);
    setGroups(prev => [...prev.map(x => ({ ...x, ports: x.ports.filter(id => !allIds.includes(id)) })), ...made]);
    setActiveId(made[0].id);
  };

  // Materializes the ruleset's uplink policy as a real group, so the YAML still
  // names every port explicitly instead of depending on the policy later.
  const addUplinkGroup = () => {
    const ids = proposedUplinks.map(p => p.id);
    if (!ids.length) return;
    const taken = new Set(cleanGroups.map(g => g.name.trim()));
    let name = "Uplink";
    for (let i = 2; taken.has(name); i++) name = `Uplink${i}`;
    const g = {
      ...newGroup(groups.length + 1),
      name, mode: "Trunk", dot1x: false, description: "Uplink", ports: ids,
      portChannel: true,
      channelGroup: String(uplinkPolicy.channelGroup ?? 1),
      channelMode: uplinkPolicy.channelMode || "Active",
    };
    setGroups(prev => [...prev.map(x => ({ ...x, ports: x.ports.filter(id => !ids.includes(id)) })), g]);
    setActiveId(g.id);
  };

  // Click assigns to the active group (or unassigns); shift-click fills a range.
  const togglePorts = (ids, forceAdd) => {
    if (!active) return;
    setGroups(prev => prev.map(g => {
      if (g.id === active.id) {
        const keep = g.ports.filter(id => !ids.includes(id));
        const remove = !forceAdd && ids.every(id => g.ports.includes(id));
        return { ...g, ports: remove ? keep : [...keep, ...ids] };
      }
      return { ...g, ports: g.ports.filter(id => !ids.includes(id)) }; // a port belongs to one group
    }));
  };

  const onPortClick = (p, e) => {
    if (e.shiftKey && lastPort) {
      const a = allPorts.findIndex(x => x.id === lastPort);
      const b = allPorts.findIndex(x => x.id === p.id);
      if (a > -1 && b > -1) togglePorts(allPorts.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id), true);
    } else {
      togglePorts([p.id]);
    }
    setLastPort(p.id);
  };

  // ── Validation: the schema rules, checked before any YAML is written ─────
  const problems = [];
  const names = cleanGroups.map(g => g.name.trim());
  for (const g of cleanGroups) {
    const n = g.name.trim();
    if (!n) problems.push("A port group has no name.");
    else if (/[:\s]/.test(n)) problems.push(`Group name "${n}" cannot contain spaces or colons.`);
    else if (names.filter(x => x === n).length > 1) problems.push(`Duplicate group name "${n}".`);
    if (g.mode === "Access" && g.vlan && !(+g.vlan >= 1 && +g.vlan <= 4094)) problems.push(`${n}: VLAN must be 1-4094.`);
    if (g.portChannel && !g.channelGroup) problems.push(`${n}: port-channel needs a channel group number.`);
  }
  if (mgmt.ip && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(mgmt.ip)) problems.push("Management IP must be CIDR, e.g. 192.168.1.10/24");
  if (mgmt.gw && !/^\d+\.\d+\.\d+\.\d+$/.test(mgmt.gw)) problems.push("Default gateway must be a plain IP, e.g. 192.168.1.1");
  if (mgmt.vlan && !(+mgmt.vlan >= 1 && +mgmt.vlan <= 4094)) problems.push("Management VLAN must be 1-4094.");
  if (!members.length) problems.push("Add at least one stack member.");
  if (!cleanGroups.some(g => g.ports.length)) problems.push("Assign at least one port to a group.");
  const issues = [...new Set(problems)];

  const yaml = useMemo(
    () => buildYAML({ members, ruleset: rulesetId, deviceFlags, mgmt, groups: cleanGroups.map(g => ({ ...g, name: g.name.trim() })), portsById }),
    [members, rulesetId, deviceFlags, mgmt, cleanGroups, portsById]
  );
  const assigned = cleanGroups.reduce((n, g) => n + g.ports.length, 0);

  const PortButton = ({ p }) => {
    const owner = ownerOf(p.id);
    const c = owner ? colorOf(owner) : null;
    return (
      <button onClick={e => onPortClick(p, e)} title={`${p.name}  (${p.type})`}
        style={{ width: 34, height: 28, borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0,
          background: c || "#0d1117", color: c ? "#0f172a" : "#475569", border: `1px solid ${c || "#334155"}` }}>
        {p.port}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, overflowY: "auto", height: "100%", paddingRight: 6 }}>

      {/* 1 ── Hardware */}
      <div style={card}>
        <div style={stepTitle}>
          <span style={badge}>1</span> Hardware
          <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>
            — {isStack ? `stack of ${members.length}` : "standalone switch"}
          </span>
        </div>

        {/* Column headers once, then one row per member — it is a table, so the
            labels do not repeat. Port counts live in hover tooltips to keep
            a tall stack readable. The trailing spacer matches the button
            column's width so header and rows resolve identical 1fr columns. */}
        <div style={{ ...memberGrid, marginBottom: 6 }}>
          <label style={{ ...label, margin: 0 }}>Mbr</label>
          <label style={{ ...label, margin: 0 }}>Switch model</label>
          <label style={{ ...label, margin: 0 }}>Network module <span style={{ color: "#475569", fontWeight: 400 }}>(optional)</span></label>
          <span style={{ width: CONTROL_H }} />
        </div>

        {members.map((m, i) => (
          <div key={m.id} style={{ ...memberGrid, alignItems: "center", marginBottom: 8 }}>
            <div style={{ ...input, fontWeight: 700, color: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
              {i + 1}
            </div>
            <select value={m.model} onChange={e => patchMember(m.id, { model: e.target.value, module: "" })}
              title={`${m.model} — ${switchSummary(m.model)}`} style={input}>
              {SWITCH_MODELS.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            <select value={m.module} onChange={e => patchMember(m.id, { module: e.target.value })}
              title={m.module ? `${m.module} — ${moduleSummary(m.module)}, slot ${i + 1}/${MODULE_SLOT}` : "No uplink module"}
              style={input}>
              <option value="">— none —</option>
              {modulesFor(m.model).map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            <button onClick={() => setMembers(members.filter(x => x.id !== m.id))} disabled={members.length === 1}
              title={members.length === 1 ? "A switch needs at least one member" : "Remove this member"}
              style={{ width: CONTROL_H, height: CONTROL_H, boxSizing: "border-box", padding: 0, borderRadius: 6, background: "none",
                cursor: members.length === 1 ? "not-allowed" : "pointer", fontSize: 13,
                border: `1px solid ${members.length === 1 ? "#334155" : "#7f1d1d"}`, color: members.length === 1 ? "#334155" : "#f87171" }}>
              ✕
            </button>
          </div>
        ))}

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
          <button onClick={() => setMembers([...members, newMember()])} disabled={members.length >= MAX_MEMBERS}
            style={{ ...ghostBtn, cursor: members.length >= MAX_MEMBERS ? "not-allowed" : "pointer" }}>
            + Add stack member
          </button>
          {members.length >= MAX_MEMBERS && <span style={{ fontSize: 11, color: "#64748b" }}>Stack limit reached ({MAX_MEMBERS}).</span>}
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={label}>Ruleset <span style={{ color: "#475569", fontWeight: 400 }}>— which commands get emitted</span></label>
          <select value={rulesetId} onChange={e => onRulesetChange(e.target.value)} style={input}>
            {RULESET_OPTIONS.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>{rulesetSummary(rulesetId)}</div>
        </div>

        {/* Box-wide features the ruleset offers — global config, not per port. */}
        {deviceToggles.length > 0 && (
          <div style={{ marginTop: 14, borderTop: "1px solid #334155", paddingTop: 12 }}>
            <label style={label}>Device features</label>
            {deviceToggles.map(t => (
              <div key={t.key} style={{ marginBottom: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#cbd5e1" }}>
                  <input type="checkbox" checked={Boolean(deviceFlags[t.key])}
                    onChange={e => setDeviceFlags(prev => ({ ...prev, [t.key]: e.target.checked }))} />
                  {t.label || t.key}
                </label>
                {t.hint && <div style={{ fontSize: 11, color: "#64748b", marginLeft: 24 }}>{t.hint}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2 ── Management */}
      <div style={card}>
        <div style={stepTitle}>
          <span style={badge}>2</span> Management
          <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>
            — optional · {onLoopback
              ? `this ruleset addresses management on Loopback${management.number ?? 0}`
              : "this ruleset addresses management on a VLAN interface"}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 2fr", gap: 12 }}>
          <div><label style={label}>IP (CIDR)</label>
            <input style={input} placeholder={onLoopback ? "10.0.0.1/32" : "192.168.1.10/24"} value={mgmt.ip} onChange={e => setMgmt({ ...mgmt, ip: e.target.value })} /></div>
          <div>
            <label style={label}>VLAN {onLoopback && <span style={{ color: "#475569", fontWeight: 400 }}>(unused)</span>}</label>
            <input style={input} disabled={onLoopback} placeholder="10" value={mgmt.vlan} onChange={e => setMgmt({ ...mgmt, vlan: e.target.value })} /></div>
          <div>
            <label style={label}>Default gateway {onLoopback && <span style={{ color: "#475569", fontWeight: 400 }}>(unused)</span>}</label>
            <input style={input} disabled={onLoopback} placeholder="192.168.1.1" value={mgmt.gw} onChange={e => setMgmt({ ...mgmt, gw: e.target.value })} /></div>
        </div>
      </div>

      {/* 3 ── Port groups */}
      <div style={card}>
        <div style={stepTitle}>
          <span style={badge}>3</span> Port groups
          <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>
            — pick a group, then click ports (shift-click for a range) · {assigned}/{allPorts.length} assigned
          </span>
        </div>

        {/* Group tabs */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {cleanGroups.map(g => {
            const isActive = active?.id === g.id;
            return (
              <button key={g.id} onClick={() => setActiveId(g.id)}
                style={{ padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: isActive ? colorOf(g) : "#0d1117", color: isActive ? "#0f172a" : "#94a3b8",
                  border: `1px solid ${colorOf(g)}` }}>
                {g.name.trim() || "unnamed"} <span style={{ opacity: .7 }}>({g.ports.length})</span>
              </button>
            );
          })}
          <button onClick={() => { const g = newGroup(groups.length + 1, rulesetPortDefaults(rulesetId)); setGroups([...groups, g]); setActiveId(g.id); }}
            style={ghostBtn}>
            + Add group
          </button>
          {uplinkPolicy && proposedUplinks.length > 0 && (
            <button onClick={addUplinkGroup} style={{ ...ghostBtn, borderStyle: "solid", borderColor: "#3b82f6", color: "#3b82f6" }}
              title={proposedUplinks.map(p => p.name).join("\n")}>
              ↑ Add uplinks ({proposedUplinks.length} port{proposedUplinks.length > 1 ? "s" : ""}, {uplinkPolicy.channelMode?.toLowerCase()} port-channel)
            </button>
          )}
          {roleSets.map(rs => {
            const picked = rolePorts(members, allPorts, rs.roles);
            const summary = rs.roles.map(([n]) => `${(picked[n] || []).length} ${n}`).join(" + ");
            return (
              <button key={rs.toggle.key} onClick={() => addRoleGroups(rs)}
                style={{ ...ghostBtn, borderStyle: "solid", borderColor: "#facc15", color: "#facc15" }}
                title={rs.roles.map(([n, d]) => `${d.label || n}: ${(picked[n] || []).map(p => p.name).join(", ")}`).join("\n")}>
                ⇄ Add {rs.toggle.label} ports ({summary})
              </button>
            );
          })}
        </div>
        {roleSets.map(rs => {
          const picked = rolePorts(members, allPorts, rs.roles);
          return (
            <div key={rs.toggle.key} style={{ fontSize: 11, color: "#64748b", marginTop: -6, marginBottom: 12 }}>
              {rs.roles.map(([n, d]) => (
                <div key={n}>
                  {d.label || n} → <span style={{ color: "#94a3b8" }}>{(picked[n] || []).map(p => p.name).join(", ") || "no free ports"}</span>
                </div>
              ))}
            </div>
          );
        })}
        {uplinkPolicy && proposedUplinks.length > 0 && (
          <div style={{ fontSize: 11, color: "#64748b", marginTop: -6, marginBottom: 12 }}>
            {isStack ? `${uplinkPolicy.perMember ?? 1} per member` : `${uplinkPolicy.standaloneCount ?? 2} on a standalone switch`}
            , preferring the {uplinkPolicy.prefer === "module" ? "network module" : "onboard ports"} →{" "}
            <span style={{ color: "#94a3b8" }}>{proposedUplinks.map(p => p.name).join(", ")}</span>
          </div>
        )}

        {/* Port grid — one block per stack member */}
        <div style={{ background: "#0d1117", border: "1px solid #334155", borderRadius: 8, padding: 12, marginBottom: 14 }}>
          {members.map((m, i) => {
            const member = i + 1;
            const onboard = allPorts.filter(p => p.member === member && !p.isModule);
            const modPorts = allPorts.filter(p => p.member === member && p.isModule);
            return (
              <div key={m.id} style={{ marginTop: i === 0 ? 0 : 16 }}>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 7 }}>
                  {isStack && <span style={{ color: "#3b82f6", fontWeight: 700 }}>Member {member} · </span>}
                  {m.model} — onboard ports
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {onboard.map(p => <PortButton key={p.id} p={p} />)}
                </div>
                {m.module && (
                  <>
                    <div style={{ fontSize: 11, color: "#64748b", margin: "10px 0 7px" }}>
                      {isStack && <span style={{ color: "#3b82f6", fontWeight: 700 }}>Member {member} · </span>}
                      {m.module} — uplink module, slot {member}/{MODULE_SLOT}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {modPorts.map(p => <PortButton key={p.id} p={p} />)}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Active group settings */}
        {active && (
          <div style={{ border: `1px solid ${colorOf(active)}`, borderRadius: 8, padding: 14, background: "#0d1117" }}>
            <div style={{ display: "grid", gridTemplateColumns: active.role ? "1fr 2fr" : "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={label}>Group name</label>
                <input style={input} value={active.name} onChange={e => patch(active.id, { name: e.target.value })} /></div>
              {active.role ? (
                <div>
                  <label style={label}>Role</label>
                  <div style={{ ...input, display: "flex", alignItems: "center", color: "#facc15" }}>
                    {rulesetPortRoles(rulesetId)[active.role]?.label || active.role} — commands come from the ruleset
                  </div>
                </div>
              ) : (
                <>
                  <div><label style={label}>Mode</label>
                    <select style={input} value={active.mode} onChange={e => patch(active.id, { mode: e.target.value })}>
                      <option>Access</option><option>Trunk</option>
                    </select></div>
                  <div>
                    <label style={label}>VLAN {active.mode === "Trunk" && <span style={{ color: "#475569", fontWeight: 400 }}>(n/a on trunk)</span>}</label>
                    <input style={input} disabled={active.mode === "Trunk"} placeholder="10" value={active.vlan}
                      onChange={e => patch(active.id, { vlan: e.target.value })} />
                  </div>
                </>
              )}
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={label}>Description</label>
              <input style={input} placeholder={active.name} value={active.description}
                onChange={e => patch(active.id, { description: e.target.value })} />
              {(naming.prefix || naming.noDot1xSuffix) && (
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>
                  Emitted as <span style={{ color: "#a3e635", fontFamily: "monospace" }}>
                    description {formatDescription(active.description || active.name, active, naming)}
                  </span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", fontSize: 13, color: "#cbd5e1" }}>
              {(active.role
                  ? [["rangeMode", "Single interface range"]]
                  : [["dot1x", "Dot1x"], ["shutdown", "Shutdown"], ["portChannel", "Port-channel"], ["rangeMode", "Single interface range"]]
                ).map(([k, lbl]) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={active[k]} onChange={e => patch(active.id,
                    // Ticking Port-channel pre-fills the mode this ruleset prefers.
                    k === "portChannel" && e.target.checked
                      ? { portChannel: true, channelMode: portDefaults.channelMode || active.channelMode }
                      : { [k]: e.target.checked })} /> {lbl}
                </label>
              ))}
              {!active.role && active.portChannel && (
                <>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>Group
                    <input style={{ ...input, width: 60 }} value={active.channelGroup}
                      onChange={e => patch(active.id, { channelGroup: e.target.value })} /></span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>Mode
                    <select style={{ ...input, width: 110 }} value={active.channelMode}
                      onChange={e => patch(active.id, { channelMode: e.target.value })}>
                      {["Active", "Passive", "On", "Auto", "Desirable"].map(m => <option key={m}>{m}</option>)}
                    </select></span>
                </>
              )}
              {cleanGroups.length > 1 && (
                <button onClick={() => { setGroups(groups.filter(g => g.id !== active.id)); setActiveId(null); }}
                  style={{ marginLeft: "auto", background: "none", border: "1px solid #7f1d1d", color: "#f87171", borderRadius: 6, padding: "5px 11px", cursor: "pointer", fontSize: 12 }}>
                  Delete group
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4 ── Review */}
      <div style={card}>
        <div style={stepTitle}><span style={badge}>4</span> Review</div>
        {issues.length > 0 && (
          <div style={{ background: "#450a0a", border: "1px solid #b91c1c", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 12, color: "#fca5a5" }}>
            {issues.map((p, i) => <div key={i}>⚠ {p}</div>)}
          </div>
        )}
        <pre style={{ fontFamily: "monospace", fontSize: 12, lineHeight: 1.65, background: "#0d1117", color: "#a3e635", border: "1px solid #334155", borderRadius: 8, padding: 14, maxHeight: 240, overflow: "auto", margin: 0 }}>
          {yaml}
        </pre>
        <button onClick={() => onApply(yaml)} disabled={issues.length > 0}
          style={{ width: "100%", marginTop: 12, padding: 11, borderRadius: 8, border: "none", fontWeight: 700, fontSize: 14,
            background: issues.length ? "#1e3a5f" : "#3b82f6", color: issues.length ? "#64748b" : "#fff",
            cursor: issues.length ? "not-allowed" : "pointer" }}>
          {issues.length ? `Fix ${issues.length} issue(s) first` : "▶ Generate config from this YAML"}
        </button>
      </div>
    </div>
  );
}
