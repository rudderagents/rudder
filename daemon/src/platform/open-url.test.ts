import { expect, test } from "bun:test"
import { browserLaunch } from "./open-url"

test("browser URLs are literal arguments, never interpolated shell commands", () => {
  const url = "https://example.test/auth?state=$(literal)&next=a%20b"
  expect(browserLaunch(url, "darwin").argv).toEqual(["open", url])
  expect(browserLaunch(url, "linux").argv).toEqual(["xdg-open", url])
  const windows = browserLaunch(url, "win32")
  expect(windows.argv.join(" ")).not.toContain(url)
  expect(windows.environment?.RUDDER_OPEN_URL).toBe(url)
})

test("unsupported schemes and embedded credentials never reach a browser", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/a", "data:text/plain,a", "https://user:password@example.test", "https://example.test/\nsecret"]) {
    expect(() => browserLaunch(url, "darwin")).toThrow()
  }
})
