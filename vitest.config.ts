/** Resolve shared React once, including for the linked host UI library. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'], environment: 'jsdom', css: true },
})
