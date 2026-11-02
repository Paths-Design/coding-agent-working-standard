'use strict';
// Keep native import in copied JS: the CLI's CommonJS TypeScript emit rewrites
// import() to require(), while the pinned parser deliberately ships ESM only.
exports.loadParser = () => import('unbash');
