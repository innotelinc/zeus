import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next ships flat configs directly — using FlatCompat here
// breaks on ESLint 9 ("Converting circular structure to JSON" from
// eslint-plugin-react's configs).
const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
];

export default eslintConfig;
