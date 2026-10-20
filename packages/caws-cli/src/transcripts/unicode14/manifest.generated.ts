/** Pinned profile provenance. Generated offline; no runtime file reads. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
export const UNICODE_PROFILE_MANIFEST = freeze({
  "pythonVersion": "3.11.13",
  "unicodeVersion": "14.0.0",
  "semanticsVersion": "python-literal-name-and-text-properties/1",
  "sources": [
    {
      "file": "UnicodeData.txt",
      "url": "https://www.unicode.org/Public/14.0.0/ucd/UnicodeData.txt",
      "sha256": "36018e68657fdcb3485f636630ffe8c8532e01c977703d2803f5b89d6c5feafb"
    },
    {
      "file": "NameAliases.txt",
      "url": "https://www.unicode.org/Public/14.0.0/ucd/NameAliases.txt",
      "sha256": "14b3b677d33f95c51423dce6eef4a6a28b4b160451ecedee4b91edb6745cf4a3"
    },
    {
      "file": "Jamo.txt",
      "url": "https://www.unicode.org/Public/14.0.0/ucd/Jamo.txt",
      "sha256": "39ff89e0a329e1ccce6d54fad8cf82e90926901928c0ca9b9a2ad5681f330dd9"
    },
    {
      "file": "NamedSequences.txt",
      "url": "https://www.unicode.org/Public/14.0.0/ucd/NamedSequences.txt",
      "sha256": "db5745688affcdc0c3927a1ee0667018a96a7b24513f866d5235e98fef6c2436"
    },
    {
      "file": "LICENSE.txt",
      "url": "https://www.unicode.org/license.txt",
      "sha256": "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
    }
  ],
  "behaviorSources": [
    {
      "url": "https://raw.githubusercontent.com/python/cpython/v3.11.13/Modules/unicodedata.c",
      "sha256": "45cdebdddfd074ea4a3ec1f99d59012953a35adb3b1235e9cfd38e346d511837",
      "coordinates": "1043-1054 CJK ranges; 1094-1119 algorithmic names; 1174-1186 ASCII case comparison; 1224-1274 case-sensitive algorithmic lookup"
    },
    {
      "url": "https://raw.githubusercontent.com/python/cpython/v3.11.13/Tools/unicode/makeunicodedata.py",
      "sha256": "4167934e4a2fd3d8208005bd590a679bd7309f6915df77ef0c9631d3c1b9187d",
      "coordinates": "405-493 Python text property construction; 607-616 canonical names; 1008-1030 First/Last expansion with empty names; 1040-1073 aliases and sequences"
    }
  ],
  "generatorSha256": "da5b857b91a829e1579e806f5b6dd81808c5dace74cddc689934a89208eb1489",
  "sourceManifestSha256": "63cd7139018e9c4707ccb4ea1e3517ef26eb56cb94a70769760a101db33af54f",
  "profileId": "python-3.11.13;unicode-14.0.0;sha256:aa99f670a79853a79a40a52a442879b657d3d48fb94b61fc578bfd1e974ee7dc",
  "counts": {
    "canonicalNames": 34527,
    "aliases": 470,
    "namedSequences": 461,
    "printableCodepoints": 144516,
    "wordCodepoints": 133548,
    "decimalCodepoints": 660
  },
  "outputSha256": {
    "tables.generated.ts": "b06a2a2ae3b2c018d13a870a57c2a4e0d4862986cbc1f5c2f2802ed6a17d5d91",
    "names.generated.ts": "d14771a3276007719cf63bb48f0214db1f0f534b55e4892be5bee1acf5659a92",
    "literal-fixtures.generated.ts": "9cd1fcf2e38faaf897a2c65500496cf165c33734b7494991b6dd9eeb339fc4d9"
  }
} as const);
