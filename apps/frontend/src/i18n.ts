// Sprint 037: i18next scaffold. Catalogs are data-only — adding a locale is a
// new file in locales/. User locale comes from the profile (User.locale, 036);
// missing keys fall back to en with a dev-mode console warning.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './locales/en.js';
import { de } from './locales/de.js';

export function initI18n(locale = 'en') {
  void i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, de: { translation: de } },
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    missingKeyHandler: (lng, _ns, key) => {
      if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) console.warn(`[i18n] missing key '${key}' for ${lng}`);
    },
    returnNull: false,
  });
  return i18n;
}

/** Switch the active locale (called when the profile loads). */
export function setLocale(locale: string | undefined) {
  const lng = (locale ?? 'en').split('_')[0]; // en_US → en
  if (i18n.language !== lng && i18n.hasResourceBundle(lng, 'translation')) {
    void i18n.changeLanguage(lng);
  } else if (i18n.language !== 'en' && !i18n.hasResourceBundle(lng, 'translation')) {
    void i18n.changeLanguage('en'); // unknown locale → en fallback
  }
}

export default i18n;
