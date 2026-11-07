import { fileURLToPath } from "node:url";

// Standalone: no workspace aliases, React transforms, SQLite, or native runtime.
export default {
  root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [
    {
      name: "nsh-test-boundary",
      resolveId(id: string) {
        if (id === "nsh") return "\0nsh-test-boundary";
      },
      load(id: string) {
        if (id === "\0nsh-test-boundary") return "export {}";
      },
    },
  ],
  test: {
    name: "@yuriai/nsh",
    include: ["packages/nsh/*.test.ts"],
    environment: "node",
    // NSH writes generated steps by entrypoint under .nsh/test. App-based
    // integration files must not overwrite each other's in-flight runner.
    fileParallelism: false,
  },
};
