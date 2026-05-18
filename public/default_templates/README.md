# Tagquest default template (playground copy)

Place the canonical default template PNG here as `tagquest_template.png`.

Must be identical to the copy in `studio-taghunter/public/default_templates/`.

Tauri's Vite frontend serves files in `public/` from the SPA root, so at
runtime `/default_templates/tagquest_template.png` resolves to this file.
The TagQuest game page's filename resolver maps the `@default` /
`@template` sentinels (when `use_default_template` is true or unset) to
this URL.

See `src/scenarios/bodies/tagquest/defaultLayout.ts` (in the studio repo)
for the canonical text/icon coordinates the artwork must align to.
