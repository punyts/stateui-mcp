import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        testTimeout: 30000,
        hookTimeout: 60000,
        globalSetup: ['test/globalSetup.ts']
    }
});
