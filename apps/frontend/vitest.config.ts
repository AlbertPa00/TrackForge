import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      // 016 gate: 60% lines on the high-risk components the doc names.
      include: [
        'src/components/InlineEdit.tsx',
        'src/components/LabelsEditor.tsx',
        'src/components/ActivitySection.tsx',
        'src/components/IssueActionsMenu.tsx',
        'src/components/AssigneePicker.tsx',
        'src/components/Markdown.tsx',
      ],
      thresholds: { lines: 60 },
    },
  },
});
