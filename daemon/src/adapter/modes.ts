// Permission-mode lists each agent advertises. Labels and descriptions are Rudder's English
// fallback copy; the app localizes the ids it knows and shows these for the rest.
import type { PermissionModeInfo, RudderPermissionMode } from "./types"

// Claude Code 2.1.309 `--permission-mode` choices. "manual" is the CLI's name for "default" (Rudder's "ask").
const NATIVE_MODE: PermissionModeInfo = {
  id: "native", native: "CLI configuration", label: "Follow CLI",
  description: "Uses the CLI's configured permissions, which may allow all tools. Applies from the next message.",
  risk: "danger", restart: true,
}

export const CLAUDE_MODES: PermissionModeInfo[] = [
  NATIVE_MODE,
  {
    id: "ask",
    native: "manual",
    label: "Always ask",
    description: "Asks before editing files or running commands, for each tool the first time it is used",
    risk: "normal",
  },
  {
    id: "acceptEdits",
    native: "acceptEdits",
    label: "Accept edits",
    description: "Edits files and runs mkdir / mv and the like in the working directory without asking; other commands still ask",
    risk: "normal",
  },
  { id: "plan", native: "plan", label: "Plan only", description: "Reads only and shows you a plan; changes nothing until you approve it", risk: "normal" },
  {
    id: "auto",
    native: "auto",
    label: "Auto",
    description: "A background classifier reviews each command and network request and runs what it judges safe",
    risk: "caution",
  },
  {
    id: "dontAsk",
    native: "dontAsk",
    label: "Don't ask",
    description: "Anything that needs approval is denied; only reads and pre-approved tools run, so the phone gets no approvals",
    risk: "caution",
  },
  {
    id: "bypassPermissions",
    native: "bypassPermissions",
    label: "Bypass permissions",
    description: "Skips every check and runs everything. Only for isolated containers or VMs without network access",
    risk: "danger",
    // Claude cannot enter it mid-session; the process is relaunched with the flag.
    restart: true,
  },
]

// Codex approvalPolicy × sandbox presets (codex.ts CODEX_PERMISSIONS).
export const CODEX_MODES: PermissionModeInfo[] = [
  NATIVE_MODE,
  { id: "ask", native: "untrusted · workspace-write", label: "Always ask", description: "Asks before any command that is not trusted", risk: "normal" },
  {
    id: "acceptEdits",
    native: "on-request · workspace-write",
    label: "Workspace auto",
    description: "Edits and commands inside the workspace run without asking; asks before going outside it",
    risk: "normal",
  },
  { id: "plan", native: "untrusted · read-only", label: "Plan", description: "Uses Codex native Plan mode to examine the task and propose a plan without changing files", risk: "normal" },
  {
    id: "fullAccess",
    native: "never · danger-full-access",
    label: "Full access",
    description: "Never asks and has no sandbox: it can change anything on the computer",
    risk: "danger",
  },
]

// ACP fallbacks until a live session reports its availableModes.
export const ACP_ASK: PermissionModeInfo = { id: "ask", native: "default", label: "Always ask", description: "Asks before acting", risk: "normal" }
export const ACP_PLAN: PermissionModeInfo = { id: "plan", native: "plan", label: "Plan only", description: "Shows a plan and changes no files", risk: "normal" }

// Not "auto": that id is Claude's classifier. This one is Grok's native `auto` (the phone says 自动判断).
// Risky commands still ask; bypassPermissions is the mode that does not.
export const AUTO_APPROVAL_MODE: PermissionModeInfo = {
  id: "autoApproval",
  native: "auto",
  label: "Auto",
  description: "Most actions run on their own; risky commands still ask you",
  risk: "caution",
}

// Grok only accepts this at process start (`grok agent --always-approve stdio`, grok 1.0.70). The phone confirms before entering it.
export const GROK_BYPASS_MODE: PermissionModeInfo = {
  id: "bypassPermissions",
  native: "bypassPermissions",
  label: "Bypass permissions",
  description: "Runs everything without asking. Only when you trust this computer and folder",
  risk: "danger",
  restart: true,
}

// Copilot's `allow_all` config option (1.0.105) in the agent mode: every tool, path and URL request is approved.
export const COPILOT_BYPASS_MODE: PermissionModeInfo = {
  id: "bypassPermissions",
  native: "allow_all",
  label: "Allow all",
  description: "Approves every tool, path and URL request without asking",
  risk: "danger",
}

// An auto-approval agent never offers "ask". Live ACP lists still report default/agent as ask; drop that and lead with this mode.
export function modesForAutoApproval(modes: PermissionModeInfo[]): PermissionModeInfo[] {
  return [AUTO_APPROVAL_MODE, ...modes.filter((mode) => mode.id !== "ask" && mode.id !== "autoApproval")]
}

// Modes known to let the agent act on its own; anything else an agent reports is "normal".
const ACP_CAUTION = new Set(["auto", "yolo"])
// Copilot autopilot "enables allow-all and runs until task completion": as risky as bypassPermissions.
const ACP_DANGER = new Set(["autopilot"])

export function capabilityModes(modes: PermissionModeInfo[]): { permissionModes: RudderPermissionMode[]; modes: PermissionModeInfo[] } {
  return { permissionModes: modes.map((mode) => mode.id), modes }
}

// Last path segment of an ACP mode id ("https://…/session-modes#agent" → "agent").
export function acpShortId(modeId: string): string {
  return modeId.split("#").pop() ?? modeId
}

// Modes that mean Always ask: the ACP standard "default" / "agent" and goose's "approve".
export const ACP_ASK_IDS = ["default", "agent", "approve"]

// The ACP standard modes map onto Rudder's shared ids; any other mode keeps the agent's own id.
export function acpRudderMode(modeId: string): RudderPermissionMode {
  const short = acpShortId(modeId)
  if (ACP_ASK_IDS.includes(short)) return "ask"
  if (short === "plan") return "plan"
  return modeId
}

export type AcpMode = { id: string; name?: string; description?: string }

export function acpModeInfo(modes: AcpMode[]): PermissionModeInfo[] {
  const seen = new Set<string>()
  const list: PermissionModeInfo[] = []
  for (const mode of modes) {
    const id = acpRudderMode(mode.id)
    if (seen.has(id)) continue
    seen.add(id)
    const short = acpShortId(mode.id)
    list.push({
      id,
      // A URL id (Copilot "https://…/session-modes#agent") shows as its fragment, "#agent".
      native: short === mode.id ? short : `#${short}`,
      label: mode.name || short,
      ...(mode.description ? { description: mode.description } : {}),
      risk: ACP_DANGER.has(short.toLowerCase()) ? "danger" : ACP_CAUTION.has(short.toLowerCase()) ? "caution" : "normal",
      fromAgent: true,
    })
  }
  return list
}
