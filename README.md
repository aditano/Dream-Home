# Dream Home

Browser 3D walkthrough of my dream house.

**Live:** https://aditano.github.io/Dream-Home/

## What it is

A static Three.js site that loads the house model (exported from the Blender build, v6 scene) and lets you explore it:

- **Orbit** (default): drag to rotate, scroll or pinch to zoom, right drag or two fingers to pan.
- **Walk**: first person at eye height with floor following and wall collision. On a desktop, click to look (pointer lock), WASD or arrow keys to move, Shift to sprint. On a phone or tablet, use the on screen joystick and drag to look. iOS Safari has no pointer lock.
- **Fly**: free flight, no collision. WASD to move, E or Space up, Q or C down. On a phone, the joystick, drag to look, and Up and Down buttons.
- **Rooms**: the sidebar flies the camera to every render viewpoint: front, gate, driveway, sides, back, valley, aerial, kitchen, dining, living hall, theater, pantry, powder room, master bedroom and bath, bedrooms, offices, hall and guest baths, garage and utility. On a phone the sidebar collapses behind the menu button.
- Speed slider, shadow, forest, sharpness, and a quality control (Auto, Low, Balanced, High, Desktop).

Keys 1, 2, 3 switch between Orbit, Walk and Fly.

## Phones and iPads

iOS Safari will reload a page and then show "A problem repeatedly occurred" when the GPU process runs out of memory. The crash comes from decoded texture memory and draw cost, not from the 38 MB file size by itself. The full model draws about 2.9 million triangles and keeps about 200 textures at 1024 px, which expands to roughly 1.2 GB of RGBA textures with mipmaps, plus a 4096 shadow map.

Auto quality on a phone, tablet, touch screen, narrow window, or `navigator.deviceMemory` of 4 or less starts on **High**. A desktop with a mouse starts on **Desktop**. The sidebar can force Low, Balanced, High, or Desktop. Choosing Desktop on a phone asks you to confirm, because that path can still crash Safari. A `?quality=` link does the same for one visit. `?quality=mobile` still means Low.

| Tier | Model | What you get |
| --- | --- | --- |
| Low | `dream_house_mobile.glb` (about 2.5 MB) | Previous phone model. About 0.42 million triangles, 512 and 256 px textures, no shadows, no environment, about 6 percent of the forest. |
| Balanced | `dream_house_balanced.glb` (about 9 MB) | Same geometry as High, textures capped at 512 px, no extra maps. About 45 MB of GPU textures. 1024 shadow, small sky lighting, about 22 percent of the forest. |
| High | `dream_house_high_shell.glb` then `dream_house_high_props.glb` (about 13.5 MB together) | House shell kept, far and small things simplified. Big surfaces stay at 1024. A few brick, roof, and floor normals stay at 512. About 0.99 million model triangles and about 207 MB of GPU textures with mipmaps. 1024 shadow around the camera, sky lighting, antialiasing, about 34 percent of the forest. |
| Desktop | `dream_house.glb` (about 38 MB) | Full model, 4096 shadows, full forest. |

Playwright on an iPhone 13 viewport measured High at about 1.19 million triangles drawn, 148 draw calls, and 208 MB of textures, with a 1024 shadow map and 4x MSAA. Balanced was about 1.12 million triangles and 53 MB of textures. Low stayed near 0.44 million triangles and 52 MB. Desktop, including the full forest, was about 5.3 million triangles, 153 draw calls, and 1.21 GB of textures.

The house shell paints first on High. Rooms and furniture stream in after that, then the forest. After each part uploads, the page drops the CPU copy of the images (`texture.source.data = null`, and `ImageBitmap.close()` when the browser decoded one) so the decode does not sit next to the GPU copy.

If the graphics context is lost, or the page reloads before the first frames finish (a `sessionStorage` boot flag), Auto steps down one tier and says so in the sidebar. A sustained frame time under 20 fps on Auto does the same. The lightest tier shows stills instead of looping.

KTX2 and Basis are not used. The transcoder needs a large WASM heap and a worker, and iOS Safari has been unreliable there. OffscreenCanvas inside a worker is missing before iOS 17. WebP is decoded by Safari itself.

If WebGL cannot start, the page shows a short note, stills of the house, and a prompt to try a desktop computer instead of a blank canvas.

Safari before 16.4 has ES modules but not import maps. The page loads `es-module-shims` only in that case. Meshopt and WebP are required by every tier. The meshopt decoder ships its WASM inside the script, so it does not depend on a separate cross origin `.wasm` file. Draco is not used. Pointer lock is never requested on iOS.

## Files

- `index.html`, `style.css`, `main.js`: the viewer (no build step, Three.js from a CDN via an import map).
- `assets/dream_house.glb`: full model (meshopt compressed, WebP textures).
- `assets/dream_house_mobile.glb`: Low tier, derived in this repo from the full GLB.
- `assets/dream_house_balanced.glb`: Balanced tier.
- `assets/dream_house_high_shell.glb` and `assets/dream_house_high_props.glb`: High tier, shell first, then rooms and props.
- `assets/tier-report.json`: triangle, file size, and texture estimates from the last High and Balanced build.
- `assets/viewpoints.json`: camera spots taken from the Blender render cameras, converted to glTF Y-up.
- `assets/forest.json`: forest tree layout from the Blender scene, drawn as light instanced trees.
- `assets/fallback/`: stills shown if WebGL cannot run.
- `docs/compare/`: desktop, High, and Low stills from the same cameras.
- `scripts/build-mobile-glb.mjs`: rebuilds the Low model.
- `scripts/build-high-glb.mjs`: rebuilds Balanced and High.

The full quality source blend lives outside this repo. Rebuild the phone models with:

```
npm install
node scripts/build-mobile-glb.mjs
node scripts/build-high-glb.mjs
```

## Deploy

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

Browser checks (WebKit at iPhone 13 and iPad sizes, plus Chromium):

```
npx playwright test
```
