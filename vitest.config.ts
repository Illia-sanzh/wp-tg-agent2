import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["agent/__tests__/**/*.test.ts", "telegram-bot/__tests__/**/*.test.ts"],
  },
});
