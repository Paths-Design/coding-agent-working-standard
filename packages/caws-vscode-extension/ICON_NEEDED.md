# Extension Icon Required

**Status**: REQUIRED for VS Code Marketplace

---

## Requirements

- **File**: `icon.png`
- **Size**: 128x128 pixels (or 256x256 for Retina)
- **Format**: PNG with transparency
- **Location**: Root of extension package

---

## Recommendations

### Design Guidelines

- Simple, recognizable icon
- Works well at small sizes
- Matches CAWS branding
- Dark background (matches gallery banner)
- High contrast for visibility

### Suggested Design

Option 1: **CAWS Initials**

- "CW" or "CAWS" in modern font
- Blue/cyan color scheme (#3B82F6 or similar)
- Dark background with light text

Option 2: **Quality Badge**

- Checkmark or shield icon
- Represents quality assurance
- Professional appearance

Option 3: **Workflow Icon**

- Gears or process flow
- Represents automation
- Clean, modern design

---

## Creating the Icon

### Using Design Tool

```bash
# Using Figma, Sketch, or similar:
1. Create 128x128 px canvas
2. Design icon (see suggestions above)
3. Export as PNG
4. Save as packages/caws-vscode-extension/icon.png
```

### Using ImageMagick (Quick Placeholder)

```bash
# Create simple text-based icon
convert -size 128x128 xc:"#1e1e1e" \
  -gravity center \
  -pointsize 48 \
  -fill "#3B82F6" \
  -annotate +0+0 "CW" \
  packages/caws-vscode-extension/icon.png
```

### Using Figma Template

1. Go to Figma or similar
2. Create 128x128 frame
3. Add CAWS logo or initials
4. Export as PNG
5. Place in extension root

---

## Alternative: Use Favicon

If `favicon.png` exists in project root:

```bash
# Resize and use as extension icon
convert favicon.png -resize 128x128 packages/caws-vscode-extension/icon.png
```

---

## Until Icon Is Created

The extension package.json references `icon.png`, but it doesn't exist yet.

**Impact**:

- VS Code Marketplace may reject submission
- Extension appears without icon in marketplace
- Less discoverable and professional

**Workaround**:

- Remove `"icon": "icon.png"` from package.json temporarily
- Or create a simple placeholder icon

---

## Next Steps

1. Design icon (or use placeholder)
2. Save as `icon.png` (128x128 PNG)
3. Verify in package.json: `"icon": "icon.png"`
4. Test: `npm run package`
5. Check .vsix includes icon

---

**Contact**: hello@paths.design for design assistance

