export function compileGuiRuntime(root: string, temporary: string, harness: string, runnerName?: string): Promise<string>;
export function runGuiFixture(command: string, args: string[], timeout?: number): Promise<string>;
