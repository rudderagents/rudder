// Windows has no 0700 / 0600: RUDDER_HOME (db, TLS key, the CLI channel's token) is made owner-only with an ACL
// instead, and the CLI checks that ACL before it trusts what it reads there (the Windows notes).
import { describeFailure, powershellArgv, runSync, type SyncRunner } from "./run"

export const SYSTEM_SID = "S-1-5-18"
export const ADMINISTRATORS_SID = "S-1-5-32-544"
/** Stands for the file's owner in inherit-only entries. */
export const CREATOR_OWNER_SID = "S-1-3-0"

export class AclError extends Error {}

/** `whoami /user /fo csv /nh` → `"desktop-7\me","S-1-5-21-…-1001"`. */
export function parseWhoamiSid(stdout: string): string | null {
  const match = stdout.match(/"(S-1-5-[0-9-]+)"\s*$/m)
  return match ? match[1]! : null
}

export function currentUserSid(run: SyncRunner = runSync): string {
  const argv = ["whoami.exe", "/user", "/fo", "csv", "/nh"]
  const result = run(argv)
  const sid = result.exitCode === 0 ? parseWhoamiSid(result.stdout) : null
  if (!sid) throw new AclError(`could not read this user's SID: ${describeFailure(argv, result)}`)
  return sid
}

/**
 * Replaces the inherited entries with full control for the user and SYSTEM only (the services that back up or index
 * a profile run as SYSTEM). `(OI)(CI)` carries it to everything created inside; Windows propagates it to what is
 * already there. Administrators keep what they always have: they can take ownership of anything.
 */
export function restrictArgv(path: string, userSid: string, directory: boolean): string[] {
  const inherit = directory ? "(OI)(CI)" : ""
  return ["icacls.exe", path, "/inheritance:r", "/grant:r", `*${userSid}:${inherit}F`, `*${SYSTEM_SID}:${inherit}F`, "/q"]
}

// Reads the owner and the explicit plus inherited entries as SIDs (names are localised: "Jeder", "Utilisateurs").
// The path comes in through RUDDER_ACL_PATH so no quoting of it ever reaches the PowerShell parser.
const READ_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "$acl = Get-Acl -LiteralPath $env:RUDDER_ACL_PATH",
  "'owner|' + $acl.GetOwner($sid).Value",
  "foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) { '{0}|{1}|{2}' -f $rule.IdentityReference.Value, [int64]$rule.FileSystemRights, $rule.AccessControlType }",
].join("; ")

export function readAclArgv(): string[] {
  return powershellArgv(READ_ACL_SCRIPT)
}

export type AclEntry = { sid: string; rights: number; allow: boolean }
export type Acl = { owner: string; entries: AclEntry[] }

export function parseAcl(stdout: string): Acl {
  let owner = ""
  const entries: AclEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.trim().split("|")
    if (fields[0] === "owner" && fields[1]) owner = fields[1]
    else if (fields.length === 3 && fields[0]!.startsWith("S-")) {
      const rights = Number(fields[1])
      if (Number.isFinite(rights)) entries.push({ sid: fields[0]!, rights, allow: fields[2] === "Allow" })
    }
  }
  if (!owner) throw new AclError("Get-Acl printed no owner")
  return { owner, entries }
}

// Any of these lets a principal read the token or replace what the CLI reads: ReadData, WriteData, AppendData,
// Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL / WRITE / READ.
const SENSITIVE_RIGHTS = 0x1 | 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000 | 0x80000000

/** Why `acl` lets someone other than this user (or SYSTEM / Administrators) in, or null when it does not. */
export function aclProblem(acl: Acl, userSid: string): string | null {
  const trusted = new Set([userSid, SYSTEM_SID, ADMINISTRATORS_SID, CREATOR_OWNER_SID])
  if (!trusted.has(acl.owner)) return `it is owned by ${acl.owner}, not by you (${userSid})`
  const outsider = acl.entries.find((entry) => entry.allow && !trusted.has(entry.sid) && (entry.rights & SENSITIVE_RIGHTS) !== 0)
  return outsider ? `${outsider.sid} has access to it (rights 0x${outsider.rights.toString(16)})` : null
}

export function readAcl(path: string, run: SyncRunner = runSync, env: Record<string, string | undefined> = process.env): Acl {
  const argv = readAclArgv()
  const result = run(argv, { env: { ...env, RUDDER_ACL_PATH: path } })
  if (result.exitCode !== 0) throw new AclError(`could not read the permissions of ${path}: ${describeFailure(argv, result)}`)
  return parseAcl(result.stdout)
}

/** Throws unless only this user (plus SYSTEM / Administrators) can read or change `path`. */
export function checkOwnerOnly(path: string, userSid: string, run: SyncRunner = runSync): void {
  const problem = aclProblem(readAcl(path, run), userSid)
  if (problem) throw new AclError(`refusing ${path}: ${problem}`)
}

/** Makes `path` owner-only, then reads the ACL back: a failure to tighten it is an error, never silently ignored. */
export function restrictToUser(path: string, options: { directory: boolean; userSid?: string; run?: SyncRunner }): void {
  const run = options.run ?? runSync
  const userSid = options.userSid ?? currentUserSid(run)
  const argv = restrictArgv(path, userSid, options.directory)
  const result = run(argv)
  if (result.exitCode !== 0) throw new AclError(`could not make ${path} private to you: ${describeFailure(argv, result)}`)
  checkOwnerOnly(path, userSid, run)
}
