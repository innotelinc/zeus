import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next ships flat configs directly — using FlatCompat here
// breaks on ESLint 9 ("Converting circular structure to JSON" from
// eslint-plugin-react's configs).
const eslintConfig = [
  // `vendor/ava` is an upstream checkout, not Zeus source.  It is kept
  // byte-for-byte for AVA upgrades and is covered by its own project tooling.
  { ignores: ["vendor/**"] },
  ...nextVitals,
  ...nextTypescript,
];

export default eslintConfig;
