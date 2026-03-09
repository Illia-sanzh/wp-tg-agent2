# Greenshift Block System

When creating pages with the Greenshift plugin, use `skill_convert` to transform HTML into Greenshift blocks.

## Workflow (with skill_convert)

1. Write clean HTML+CSS to `/tmp/design.html` (vanilla HTML, `<style>` tags, no frameworks)
2. Run `skill_convert` with `input_file: "/tmp/design.html"`
3. Insert the output into WordPress via `wp post update <ID> /tmp/output.html`

## HTML Rules for Clean Conversion

1. **Vanilla HTML + CSS only** — no React, Tailwind, or frameworks
2. **All CSS in `<style>` tags**, all JS in `<script>` tags
3. **Unique class prefixes** — 4+ letters, e.g. `.strp-hero`, `.strp-card`
4. **No `:root`, `body`, or `*` styles** — only your prefixed classes
5. **Headings/paragraphs** must have explicit `margin-top` and `margin-bottom`
6. **Lists** must have `list-style-position: inside; margin-left: 0; padding-left: 0`
7. **Images**: `https://picsum.photos/seed/KEYWORD/WIDTH/HEIGHT`
8. **Full-width sections**: `<div class="prefix-section"><div class="prefix-wrap">content</div></div>`

## Without skill_convert (fallback)

Wrap entire HTML+CSS in `<!-- wp:html -->...<style>...</style><section>...</section>...<!-- /wp:html -->`
