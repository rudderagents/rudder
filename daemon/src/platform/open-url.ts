type BrowserLaunch = { argv: string[]; environment?: Record<string, string> }

export function validateExternalUrl(url: string): void {
  if (/\p{Cc}/u.test(url)) throw new Error("MCP browser URL contains control characters")
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("MCP browser URL must use HTTP(S) without embedded credentials")
  }
}

export function browserLaunch(url: string, platform: NodeJS.Platform = process.platform): BrowserLaunch {
  validateExternalUrl(url)
  if (platform === "darwin") return { argv: ["open", url] }
  if (platform === "win32") return {
    argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:RUDDER_OPEN_URL"],
    environment: { RUDDER_OPEN_URL: url },
  }
  return { argv: ["xdg-open", url] }
}

export async function openExternalUrl(url: string): Promise<void> {
  const launch = browserLaunch(url)
  const child = Bun.spawn(launch.argv, {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    timeout: 15_000, ...(launch.environment ? { env: { ...process.env, ...launch.environment } } : {}),
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`System browser launcher exited with code ${code}; open the authorization from the computer`)
}
