import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [...nextVitals, { ignores: ["workers/*/dist/**", "workers/*/node_modules/**"] }];

export default eslintConfig;
