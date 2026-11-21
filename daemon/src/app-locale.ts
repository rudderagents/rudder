// The languages the phone app ships (`ios/App/Localizable.xcstrings`). The phone reports the one it reads in; text
// rudderd writes for the phone (the lock-screen card's plain-text fallback) follows it.

export const APP_LOCALES = ["zh-Hans", "zh-Hant", "en", "de", "fr", "ja", "ko", "es-419"] as const
export type AppLocale = (typeof APP_LOCALES)[number]

/**
 * A reported language as one the app ships. Older phones sent "zh" / "en" only; anything else falls back the way
 * the app's own catalog would: same language and script first, then English.
 */
export function appLocale(raw: unknown): AppLocale {
  if (typeof raw !== "string" || !raw) return "zh-Hans"
  const exact = APP_LOCALES.find((locale) => locale.toLowerCase() === raw.toLowerCase())
  if (exact) return exact
  const tag = raw.toLowerCase().replace(/_/g, "-")
  if (tag.startsWith("zh")) return /hant|-tw|-hk|-mo/.test(tag) ? "zh-Hant" : "zh-Hans"
  if (tag.startsWith("es")) return "es-419"
  const language = tag.split("-")[0]
  return APP_LOCALES.find((locale) => locale === language) ?? "en"
}
