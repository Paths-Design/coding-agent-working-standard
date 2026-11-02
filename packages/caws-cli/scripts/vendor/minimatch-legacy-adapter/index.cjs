'use strict';

// Legacy ESLint consumers import a CommonJS default and use its real Minimatch
// class. Matching is implemented entirely by the patched upstream dependency.
module.exports = require('minimatch-modern').minimatch;
