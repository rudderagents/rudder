// The lock-screen card's fixed alerts. Sent as keys (`titleKey` / `bodyKey`, the Simplified Chinese source text) the
// phone looks up in its catalog, in whichever of its languages it reads; a gateway that refuses keys gets plain text.
import { appLocale } from "./app-locale"

export const LIVE_ALERT_KEYS = {
  waiting: { title: "需批准", body: "有一项操作等你批准" },
  done: { title: "完成", body: "这一轮结束了" },
  failed: { title: "失败", body: "这一轮没有完成" },
  // a question now rides the per-computer card instead of its own notification, so it needs a sound too.
  question: { title: "等你回答", body: "有一个问题等你回答" },
  // r70 1.2a: the silent alert a card rudderd starts while a turn runs must carry (ActivityKit push-to-start).
  started: { title: "在跑", body: "电脑上有一轮开始了" },
} as const

export type LiveAlertKind = keyof typeof LIVE_ALERT_KEYS

/** The listed plain text for a phone reading in `locale` (what it reported; old phones sent "zh" / "en"). */
export function liveAlertText(locale: string, kind: LiveAlertKind): { title: string; body: string } {
  return LIVE_ALERT_TEXT[appLocale(locale) === "zh-Hans" ? "zh-Hans" : "en"][kind]
}

export type LiveAlert = { title: string; body: string } | { titleKey: string; bodyKey: string }

/** Which fixed alert this is, as keys or as the text of any language. */
export function liveAlertKind(alert: LiveAlert): LiveAlertKind | undefined {
  const title = "titleKey" in alert ? alert.titleKey : alert.title
  const kinds = Object.keys(LIVE_ALERT_KEYS) as LiveAlertKind[]
  return kinds.find((kind) => LIVE_ALERT_KEYS[kind].title === title || Object.values(LIVE_ALERT_TEXT).some((byKind) => byKind[kind].title === title))
}

/**
 * The plain texts gateways list (push-gateway `LIVE_ACTIVITY_ALERTS`, r59 F-10), word for word: deployed gateways
 * are frozen, so this table is not the app catalog's current wording (`live-activity.test.ts` holds the two equal).
 */
export const LIVE_ALERT_TEXT = {
  "zh-Hans": LIVE_ALERT_KEYS,
  en: {
    waiting: { title: "Needs approval", body: "An action is waiting for your approval" },
    done: { title: "Done", body: "This turn finished" },
    failed: { title: "Failed", body: "This turn did not finish" },
    question: { title: "Needs an answer", body: "A question is waiting" },
    started: { title: "Running", body: "A turn started on your computer" },
  },
} as const

/**
 * What the push gateway takes, learnt from its refusal and kept until restart: keys the phone translates from its
 * catalog into any of its languages, else the listed text closest to the phone's language.
 */
export class AlertLadder {
  private keys = true

  constructor(private readonly log: (line: string) => void = () => {}) {}

  alert(locale: string, kind: LiveAlertKind): LiveAlert {
    if (this.keys) {
      const { title, body } = LIVE_ALERT_KEYS[kind]
      return { titleKey: title, bodyKey: body }
    }
    return liveAlertText(locale, kind)
  }

  /** A 400 naming a keyed alert: the gateway predates keys. Says whether to send again as text. */
  refused(status: number, alert: unknown, message: string | undefined): boolean {
    if (!this.keys || status !== 400 || !/alert/.test(message ?? "") || !alert || typeof alert !== "object" || !("titleKey" in alert)) return false
    this.keys = false
    this.log("the push gateway does not translate alerts yet; sending Simplified Chinese or English text")
    return true
  }
}
