// no-undef 专用最小配置（2026-10-28）
// 为什么需要：`node --check` 只查语法，查不出「引用了不存在的变量」——
// 2026-10-28 就因为设置页引用了浮球面板的 busy，整块设置页渲染崩溃。
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        React: 'readonly', h: 'readonly',
        window: 'readonly', document: 'readonly', console: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', location: 'readonly', alert: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly',
        FileReader: 'readonly', FormData: 'readonly', AbortController: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        module: 'readonly', require: 'readonly', global: 'readonly', globalThis: 'readonly',
        HTMLElement: 'readonly', Event: 'readonly', CustomEvent: 'readonly', Node: 'readonly',
        MutationObserver: 'readonly', ResizeObserver: 'readonly', IntersectionObserver: 'readonly',
        performance: 'readonly', crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly',
        AbortSignal: 'readonly', AbortController: 'readonly',
      },
    },
    rules: { 'no-undef': 'error' },
  },
]
