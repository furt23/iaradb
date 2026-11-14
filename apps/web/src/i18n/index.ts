import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { pt } from "./locales/pt";
import { en } from "./locales/en";

// Suppress any donation / support notices from i18next
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { __i18next_supportNoticeShown?: boolean }).__i18next_supportNoticeShown = true;
}
if (typeof process !== "undefined" && process.env) {
  process.env.I18NEXT_NO_SUPPORT_NOTICE = "true";
}

export const resources = {
  pt: { translation: pt },
  en: { translation: en },
} as const;

export type Locale = "pt" | "en";
export const DEFAULT_LOCALE: Locale = "pt";

const STORAGE_KEY = "iara.locale.v1";

export function getSavedLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "pt" || saved === "en") return saved;
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_LOCALE;
}

export function saveLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage unavailable
  }
}

// Initialize i18next
if (!i18next.isInitialized) {
  void i18next
    .use(initReactI18next)
    .init({
      resources,
      // the server renders the default: the client matches it, then I18nProvider switches to the saved locale
      lng: DEFAULT_LOCALE,
      fallbackLng: "en",
      // Disable any donation or support notices
      showSupportNotice: false,
      debug: false,
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
    } as unknown as Parameters<typeof i18next.init>[0]);
} else {
  // a dev reload re-runs this module on a live i18next: without this the server keeps the old keys and renders untranslated text
  for (const [lng, bundle] of Object.entries(resources)) i18next.addResourceBundle(lng, "translation", bundle.translation, true, true);
}

/**
 * Direct translation helper function that can be used anywhere (pure functions, components, callbacks).
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

/**
 * Change the active language and persist choice.
 */
export async function changeLanguage(locale: Locale): Promise<void> {
  saveLocale(locale);
  await i18next.changeLanguage(locale);
}

export { useTranslation } from "react-i18next";
export default i18next;
