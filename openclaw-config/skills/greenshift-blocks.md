# Greenshift/GreenLight Block System

When the Greenshift plugin is active and the `skill_convert` tool is available, use this knowledge to produce production-ready WordPress blocks.

## Architecture Overview

Greenshift uses a single universal block type: `greenshift-blocks/element`. Every HTML element (div, p, h1, img, span, etc.) maps to one element block. CSS is consolidated into a top-level Style Manager block (`greenshift-blocks/stylecombine`).

## Block Comment Format

Every block is a JSON-RPC-style comment pair:
```
<!-- wp:greenshift-blocks/element {"id":"unique_id","type":"inner|text|no","CSSRender":"1",...} -->
<div class="gspb_element" id="unique_id">...children...</div>
<!-- /wp:greenshift-blocks/element -->
```

### Element Types
- `"type":"inner"` — Container/wrapper (div, section, header, footer, nav, ul, ol). Can contain child blocks.
- `"type":"text"` — Text content (p, h1-h6, span, li, a, blockquote). Contains rendered text.
- `"type":"no"` — Self-closing/void elements (img, hr, br, input). No children.

### Critical Attributes
- `"id"` — Unique ID for the element. MUST be unique across the entire page. Use descriptive prefix + counter, e.g. `"hero_wrap_1"`, `"hero_title_1"`.
- `"CSSRender":"1"` — **REQUIRED on every block**. Tells Greenshift to render CSS programmatically. Without this, blocks inserted via REST/WP-CLI will have no styles.
- `"htmlTag"` — The actual HTML tag to render: `"div"`, `"section"`, `"p"`, `"h2"`, `"img"`, `"a"`, `"ul"`, `"li"`, etc. Defaults to `div` if omitted.
- `"content"` — For `type:"text"`, the actual text content.
- `"imgUrl"` — For `type:"no"` with `htmlTag:"img"`, the image source URL.
- `"linkUrl"` — For clickable elements, the href.

## Style Manager Block (Top-Level Wrapper)

Every page MUST start with a Style Manager that consolidates all CSS:

```
<!-- wp:greenshift-blocks/stylecombine {"id":"page_styles","dynamicGClasses":"CSS_STRING","CSSRender":"1"} -->
<div class="gspb_stylecombine" id="page_styles">
  <!-- all element blocks go inside here -->
</div>
<!-- /wp:greenshift-blocks/stylecombine -->
```

### dynamicGClasses Format
All CSS rules concatenated into a single string. Use `\n` for line breaks:
```
".hero_section{padding:80px 0;background:#1a1a2e;color:#fff}\n.hero_title{font-size:clamp(2rem,5vw,3.5rem);font-weight:700;margin:0 0 16px}\n.hero_sub{font-size:1.25rem;opacity:0.85;max-width:600px}"
```

Rules: use class selectors matching your element IDs/classes. No `body`, `*`, or `:root` selectors.

## Conversion Workflow (with skill_convert)

When `skill_convert` is available, you do NOT need to manually construct block JSON. Instead:

1. **Write clean HTML** to a temp file:
```bash
cat > /tmp/design.html <<'HTMLEOF'
<style>
.mypr-hero { padding: 80px 0; background: #1a1a2e; color: #fff; }
.mypr-title { font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 700; }
</style>
<section class="mypr-hero">
  <div class="mypr-wrap">
    <h1 class="mypr-title">Welcome to Our Site</h1>
    <p class="mypr-desc">Building the future, one block at a time.</p>
  </div>
</section>
HTMLEOF
```

2. **Run the converter**:
   Use `skill_convert` with `input_file: "/tmp/design.html"`

3. **The converter outputs** valid WordPress block markup with:
   - Style Manager wrapping all blocks
   - Every element mapped to `greenshift-blocks/element`
   - All CSS extracted into `dynamicGClasses`
   - Unique IDs auto-generated
   - `CSSRender: "1"` on all blocks

4. **Insert the output** into WordPress via WP-CLI (write to file, then `wp post update`)

## Manual Block Construction (without skill_convert)

If the converter is NOT available, wrap your entire HTML+CSS in a single `wp:html` block:
```
<!-- wp:html -->
<style>.mypr-hero{...}</style>
<section class="mypr-hero">...</section>
<!-- /wp:html -->
```
This is a fallback — it works but doesn't get Greenshift's visual editor support.

## HTML Rules for Clean Conversion

These rules ensure the converter produces clean output:

1. **Vanilla HTML + CSS only** — no React, TypeScript, Tailwind, or frameworks
2. **Single HTML file** — all CSS in `<style>` tags, all JS in `<script>` tags
3. **Unique class prefixes** — minimum 4 letters, e.g. `.abcd-hero`, `.abcd-card`
4. **No `:root` variables** — put CSS variables on the parent class instead
5. **No `body` or `*` styles** — only style your own classes
6. **No script-generated content** — all text/HTML must be in the DOM markup
7. **Headings and paragraphs** must have explicit `margin-top` and `margin-bottom`
8. **Lists** must have `list-style-position: inside; margin-left: 0; padding-left: 0`
9. **Full-width sections** use: `<div class="prefix-section"><div class="prefix-wrap">content</div></div>`
10. **Images** use `https://picsum.photos/WIDTH/HEIGHT` or `https://picsum.photos/seed/KEYWORD/WIDTH/HEIGHT`

## Nesting Rules

- Style Manager (`stylecombine`) is the outermost wrapper
- Inside it: `type:"inner"` elements for sections/containers
- Inside containers: `type:"text"` for headings/paragraphs, `type:"no"` for images
- `type:"text"` and `type:"no"` blocks CANNOT contain child blocks
- `type:"inner"` blocks CAN contain any other blocks

## Common Patterns

### Section with heading + text:
```
section (type:inner, htmlTag:section)
  └─ wrapper (type:inner, htmlTag:div)
       ├─ heading (type:text, htmlTag:h2)
       └─ paragraph (type:text, htmlTag:p)
```

### Card grid:
```
grid-container (type:inner, htmlTag:div)
  ├─ card-1 (type:inner, htmlTag:div)
  │    ├─ card-img (type:no, htmlTag:img)
  │    ├─ card-title (type:text, htmlTag:h3)
  │    └─ card-desc (type:text, htmlTag:p)
  ├─ card-2 (type:inner, htmlTag:div)
  │    └─ ...
  └─ card-3 (type:inner, htmlTag:div)
       └─ ...
```

### Hero with CTA:
```
hero-section (type:inner, htmlTag:section)
  └─ hero-wrap (type:inner, htmlTag:div)
       ├─ hero-title (type:text, htmlTag:h1)
       ├─ hero-subtitle (type:text, htmlTag:p)
       └─ hero-btn (type:text, htmlTag:a, linkUrl:"#")
```
