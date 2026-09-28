import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
    // Replaces .eslintignore - flat config has no separate ignore file
    { ignores: ['node_modules/**', 'main.js'] },

    js.configs.recommended,
    ...tseslint.configs.recommended,

    // Replaces the old .eslintrc's "env": { "node": true } - needed for the
    // build scripts (esbuild.config.mjs, version-bump.mjs), which use real
    // Node globals like process/import.meta, not just the plugin's own src/*.ts
    {
        languageOptions: {
            globals: globals.node,
        },
    },

    // Carried over verbatim from the old .eslintrc's "rules" block
    {
        files: ['**/*.ts'],
        rules: {
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
            '@typescript-eslint/ban-ts-comment': 'off',
            'no-prototype-builtins': 'off',
            '@typescript-eslint/no-empty-function': 'off',
        },
    },
];
