"use client";

import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import i18next, { getSavedLocale } from "./index";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const locale = getSavedLocale();
    if (i18next.language !== locale) {
      void i18next.changeLanguage(locale);
    }
    setMounted(true);
  }, []);

  return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>;
}
