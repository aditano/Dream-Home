# Dream Home

Browser 3D walkthrough of my dream house.

**Live:** https://aditano.github.io/Dream-Home/

## What it is

A static Three.js site that loads the house model (exported from the Blender build, v6 scene) and lets you explore it:

- **Orbit** (default): drag to rotate, scroll or pinch to zoom, right drag or two fingers to pan.
- **Walk**: first person at eye height with floor following and wall collision. On a desktop, click to look (pointer lock), WASD or arrow keys to move, Shift to sprint. On a phone or tablet, use the on screen joystick and drag to look. iOS Safari has no pointer lock.
- **Fly**: free flight, no collision. WASD to move, E or Space up, Q or C down. On a phone, the joystick, drag to look, and Up and Down buttons.
- **Rooms**: the sidebar flies the camera to every render viewpoint: front, gate, driveway, sides, back, valley, aerial, kitchen, dining, living hall, theater, pantry, powder room, master bedroom and bath, bedrooms, offices, hall and guest baths, garage and utility. On a phone the sidebar collapses behind the menu button.
- Speed slider, shadow, forest, sharpness, and a quality control (Auto, Desktop, Mobile).

Keys 1, 2, 3 switch between Orbit, Walk and Fly.

## Phones and iPads

iOS Safari will reload a page and then show "A problem repeatedly occurred" when the GPU process runs out of memory. The full model is about 38 MB on disk, with roughly 2.9 million triangles drawn and 200 textures at 1024 px, plus a 4096 shadow map and a generated environment cubemap. That is too much for an iPhone.

Auto quality picks the lighter model when any of these are true: iOS (including iPadOS), a touch screen, a viewport under 820 px, or `navigator.deviceMemory` of 4 or less. The Mobile and Desktop options in the sidebar override that and reload the page. A `?quality=mobile` or `?quality=desktop` link does the same for one visit.

The lighter model is `assets/dream_house_mobile.glb` (about 2.5 MB, about 0.42 million triangles drawn). Large surfaces keep 512 px WebP textures. Smaller props use 256 px. Normal maps and the metallic-roughness maps are dropped so the decoded textures stay near 40 MB plus mipmaps. Trees, plants, and small props are simplified hard. The procedural forest keeps about 6 percent of the trees and uses coarser shapes. The phone path also turns MSAA off, caps the pixel ratio at 1.5, skips the environment cubemap, and leaves shadows off unless you opt in (then a 512 map). Loading buffers from the glTF parser are released after the scene is built.

KTX2 and Basis are not used. The transcoder needs a large WASM heap and a worker, and iOS Safari has been unreliable there. OffscreenCanvas inside a worker is missing before iOS 17. WebP is decoded by Safari itself.

If WebGL cannot start, or the context is lost, the page shows a short note, stills of the house, and a prompt to try a desktop computer instead of a blank canvas.

Safari before 16.4 has ES modules but not import maps. The page loads `es-module-shims` only in that case. Meshopt and WebP are required by both models. The meshopt decoder ships its WASM inside the script, so it does not depend on a separate cross origin `.wasm` file. Draco is not used. Pointer lock is never requested on iOS.

## Files

- `index.html`, `style.css`, `main.js`: the viewer (no build step, Three.js from a CDN via an import map).
- `assets/dream_house.glb`: full model (meshopt compressed, WebP textures).
- `assets/dream_house_mobile.glb`: phone and tablet model, derived in this repo from the full GLB.
- `assets/viewpoints.json`: camera spots taken from the Blender render cameras, converted to glTF Y-up.
- `assets/forest.json`: forest tree layout from the Blender scene, drawn as light instanced trees.
- `assets/fallback/`: stills shown if WebGL cannot run.
- `scripts/build-mobile-glb.mjs`: rebuilds the phone model.

The full quality source blend lives outside this repo. Rebuild the phone model with:

```
npm install
node scripts/build-mobile-glb.mjs
```

## Deploy

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

Browser checks (WebKit at an iPhone size, plus desktop Chromium):

```
npx playwright test
```
