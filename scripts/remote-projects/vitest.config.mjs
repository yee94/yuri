import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  name: 'remote-projects-performance-harness', environment: 'node',
  include: ['scripts/remote-projects/**/*.test.mjs'],
} });
