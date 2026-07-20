/**
 * i18next-parser config for playground chrome (bucket 1) key extraction.
 * English is the pivot/source. See plan `multilingual-app-translator-workflow.md`.
 *
 * Usage: npx i18next-parser
 */
export default {
  locales: ['en', 'fr'],
  defaultNamespace: 'common',
  output: 'src/i18n/locales/$LOCALE/$NAMESPACE.json',
  input: ['src/**/*.{ts,tsx}'],
  keepRemoved: false,
  sort: true,
  createOldCatalogs: false,
  defaultValue: (locale, _ns, key, value) =>
    locale === 'en' ? (value ?? '') : '',
  keySeparator: '.',
  namespaceSeparator: ':',
  verbose: false,
};
