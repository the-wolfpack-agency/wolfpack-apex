import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  preset: "ts-jest",
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          jsx: "react",
        },
      },
    ],
  },
  transformIgnorePatterns: ["/node_modules/"],
};

export default config;
