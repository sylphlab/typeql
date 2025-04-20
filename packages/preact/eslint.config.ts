import type { Linter } from 'eslint';
import sylphConfig from '@sylphlab/eslint-config-sylph';

const config: Linter.FlatConfig[] = [
  ...sylphConfig,
  // Add any project-specific overrides here if needed in the future
  {
    ignores: ['**/dist/**', '**/node_modules/**'], // Standard ignores
  },
];

export default config;