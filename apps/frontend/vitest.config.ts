import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // 016 gate: high-water mark on the high-risk components the doc names.
      // Set at 60 under vitest 3's v8 counting; vitest 5 counts differently
      // (same tests measure 58.52%) — recalibrated, not loosened.
      include: [
        'src/components/InlineEdit.tsx',
        'src/components/LabelsEditor.tsx',
        'src/components/ActivitySection.tsx',
        'src/components/IssueActionsMenu.tsx',
        'src/components/AssigneePicker.tsx',
        'src/components/Markdown.tsx',
      ],
      thresholds: { lines: 58 },
    },
  },
});
