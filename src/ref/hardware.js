// ── Hardware library ───────────────────────────────────────────────────────
// Reads Switch_Hardware.json and expands {namePattern, portRange} blocks into
// concrete interface names. This replaces the per-model Excel tabs: a tab's
// column A is exactly what expandPorts() produces here.
import HW from "./Switch_Hardware.json";

export const SWITCH_MODELS = Object.keys(HW.switches).sort();
export const MODULE_NAMES  = Object.keys(HW.modules).sort();

// A namePattern hardcodes member 1 ("GigabitEthernet1/0/{port}"). For stack
// member N the first numeric component becomes N: "GigabitEthernet2/0/{port}".
function applyMember(namePattern, member) {
  if (member === 1) return namePattern;
  return namePattern.replace(/^([A-Za-z]+)(\d+)(\/)/, (_, name, __, slash) => `${name}${member}${slash}`);
}

// → [{ port, name, type, patternIdx }] ordered by port number.
function expandPorts(blocks, member) {
  const ports = [];
  blocks.forEach((block, patternIdx) => {
    const { start, end } = block.portRange;
    const pattern = applyMember(block.namePattern, member);
    for (let p = start; p <= end; p++)
      ports.push({ port: p, name: pattern.replace("{port}", p), type: block.type, patternIdx });
  });
  return ports.sort((a, b) => a.port - b.port);
}

export function switchPorts(model, member = 1) {
  const sw = HW.switches[model];
  return sw ? expandPorts(sw.interfaces, member) : [];
}

export function modulePorts(moduleName, member = 1) {
  const mod = HW.modules[moduleName];
  return mod ? expandPorts(mod.interfaces, member) : [];
}

// An empty compatibleWith list means "fits anything" — the JSON ships them empty.
export function modulesFor(model) {
  return MODULE_NAMES.filter(name => {
    const compat = HW.modules[name].compatibleWith;
    return !compat?.length || compat.includes(model);
  });
}

// Short "24x RJ45 + 4x QSFP28" summary for the dropdown / confirmation line.
export function describe(blocks) {
  return blocks.map(b => `${b.portRange.end - b.portRange.start + 1}x ${b.type}`).join(" + ");
}
export const switchSummary = model => describe(HW.switches[model]?.interfaces || []);
export const moduleSummary = name => describe(HW.modules[name]?.interfaces || []);

export const isKnownModel  = model => Boolean(HW.switches[model]);
export const isKnownModule = name  => Boolean(HW.modules[name]);

// Interface maps in the shape generateConfig() expects: a port-indexed array
// (ifaces[port - 1]), keyed by stack member number / "member/slot".
function toIndexedArray(ports) {
  const arr = [];
  for (const p of ports) arr[p.port - 1] = p.name;
  return arr;
}

// Keyed by MEMBER, not by model: a stack of two identical switches needs
// member 2 to resolve to "…2/0/x", which a model-keyed map cannot express.
export function buildHardwareMaps(devices = {}, modules = {}) {
  const platforms = {};
  for (const [memberKey, model] of Object.entries(devices)) {
    const member = parseInt(memberKey, 10);
    if (!Number.isFinite(member)) continue;
    platforms[member] = toIndexedArray(switchPorts(model, member));
  }
  const mods = {};
  for (const [slotKey, moduleName] of Object.entries(modules)) {
    const member = parseInt(slotKey.split("/")[0], 10) || 1;
    mods[slotKey] = toIndexedArray(modulePorts(moduleName, member));
  }
  return { platforms, modules: mods };
}

export default HW;
