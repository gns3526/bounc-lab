# Penguin Bounce skin ImageGen prompt set

All eleven production assets were generated with the built-in ImageGen tool, one image call per character or ball. The files in `public/assets/skins/` are transparent PNG game assets; high-resolution generation sources are archived at `E:\CodexBouncSkinWork\imagegen-originals\` because the C: drive was full during release packaging.

## Shared art direction

> Production mobile-game character asset for Penguin Bounce. One polished, cute chibi subject, full body, centered, slight three-quarter front view, large expressive icy-blue eyes, rounded readable silhouette, premium 2.5D cel-shaded illustration, crisp materials and clean color separation, designed to remain recognizable at 32–64 px. Keep the complete character, weapon, crown, wings, tail, and effects inside the canvas. Isolated on a genuinely transparent background. No scene, floor, frame, text, letters, numbers, logo, watermark, UI, or cast shadow. Do not add extra characters or detached body parts.

The base penguin output was used as the visual identity reference for every penguin variant: navy-and-white face, orange beak and feet, large icy-blue eyes, rounded proportions, and the same viewing angle.

## Per-asset subject prompts

| Output | Subject direction |
| --- | --- |
| `base_penguin.png` | Unarmored mascot penguin; friendly and adventurous; no accessories. |
| `chrome_speedball.png` | A single spherical polished silver chrome speedball, navy equatorial inset band, ice-blue reflections, cyan energy core emblem and fine mechanical panel seams; no face, eyes, beak, feet, wings, or penguin body. |
| `robo_penguin.png` | Friendly high-tech robot penguin with white and silver armor, cyan energy lines, blue visor accents, compact booster wings and a glowing chest core. |
| `princess_penguin.png` | Regal princess penguin with an aurora-pink dress, gold-trimmed heart crown, jewel ornaments, elegant translucent cape and star-heart magic accents. |
| `frost_knight_penguin.png` | Noble frost knight in ice-blue crystal armor, carrying a crystalline sword and compact snowflake shield; cold blue runes and restrained frost highlights. |
| `inferno_warrior_penguin.png` | Legendary fire warrior in obsidian-and-crimson armor with molten gold cracks, horned helmet, cape and one dramatic flaming battle axe. |
| `galaxy_mage_penguin.png` | Legendary cosmic mage in a deep blue-violet constellation robe and oversized starry wizard hat, holding one gold-trimmed star wand. |
| `neon_ninja_penguin.png` | Agile navy ninja with cyan and magenta luminous trim, long wind-swept scarf, belt pouches and one compact neon shuriken. |
| `thunder_emperor_penguin.png` | Legendary blue-and-gold emperor with ornate lightning crown, royal armor and one lightning scepter; contained electric accents. |
| `mecha_dragon_penguin.png` | Legendary black-and-violet mecha-dragon armor, amber energy core, mechanical horns, compact segmented wings and armored tail. |
| `aurora_seraph_penguin.png` | Legendary white-and-gold celestial penguin with a halo, luminous robes and wide layered pastel aurora wings kept fully inside the canvas. |

Robo and princess also received isolated background-extraction passes. Because those two extraction outputs still baked in a checker pattern, only the edge-connected checkerboard pixels were converted to alpha during final asset cleanup; their ImageGen artwork itself was not redrawn or altered.
