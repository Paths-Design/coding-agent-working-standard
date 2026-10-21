/** Pinned HTML interpretation provenance; generated offline. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
export const PYTHON_HTML_MANIFEST = freeze({
  "pythonVersion": "3.11.13",
  "semanticsVersion": "python-html-unescape/1",
  "decimalDigitLimit": 4300,
  "sources": [
    {
      "file": "entities.py",
      "url": "https://raw.githubusercontent.com/python/cpython/v3.11.13/Lib/html/entities.py",
      "sha256": "282b7cdd567bbbf3d7d7ccd49fae1d3ebc7f7ab64058d781193620913773731b"
    },
    {
      "file": "html-init.py",
      "url": "https://raw.githubusercontent.com/python/cpython/v3.11.13/Lib/html/__init__.py",
      "sha256": "923d82d821e75e8d235392c10c145ab8587927b3faf9c952bbd48081eebd8522"
    },
    {
      "file": "LICENSE.txt",
      "url": "https://raw.githubusercontent.com/python/cpython/v3.11.13/LICENSE",
      "sha256": "3b2f81fe21d181c499c59a256c8e1968455d6689d269aa85373bfb6af41da3bf"
    }
  ],
  "behaviorCoordinates": {
    "html-init.py": "31-64 numeric corrections; 67-88 numeric removals; 91-115 replacement; 118-132 recognition and single-pass substitution",
    "entities.py": "265-2497 html5 named-reference dictionary"
  },
  "derivation": "The pinned html5 dictionary, numeric corrections and invalid-codepoint set are converted to frozen TypeScript data. HTML replacement behavior is implemented in TypeScript with a fixed default decimal integer conversion limit; Python execution and general Python parsing are absent from generation and runtime.",
  "generatorSha256": "c21b8fd87600a627d90ea1097f3f86f3d45d36347c12972f3e41fbe9951a0a68",
  "sourceManifestSha256": "27a7e262bc29cd3847914dd5f5e4a14176055770d7fea5ecdd61a72d7d70ad61",
  "profileId": "python-html-3.11.13;decimal-limit-4300;sha256:47c9045bff479fb8758bbc265f57047038fbab1d9152c2c1d0a8ccb239f30dcd",
  "counts": {
    "namedReferences": 2231,
    "semicolonlessReferences": 106,
    "numericCorrections": 34,
    "invalidNumericCodepoints": 126
  },
  "outputSha256": {
    "entities.generated.ts": "0f2171ccdb987fe04c370b8d10965b8c3f38b6c1bf5f0db5a13b85da0bb0c0dd",
    "numeric.generated.ts": "2ad50fb50d28dca99a23526381562a63af3fc93be058f6b45e4982f4972d54aa"
  }
} as const);
