/**
 * Vite resolves a bare CSS import into a side effect that injects the
 * stylesheet. TypeScript has no notion of that, so declare it.
 */
declare module '*.css';
