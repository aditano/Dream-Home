# Dream Home

Browser 3D walkthrough of my dream house.

**Live:** https://aditano.github.io/Dream-Home/

## What it is

A static Three.js site that loads the house model (exported from the Blender build, v6 scene) and lets you explore it:

- **Orbit** (default): drag to rotate, scroll or pinch to zoom, right drag or two fingers to pan.
- **Walk**: first person at eye height with floor following and wall collision. Click to look (pointer lock), WASD or arrow keys to move, Shift to sprint.
- **Fly**: free flight, no collision. WASD to move, E or Space up, Q or C down.
- **Rooms**: the sidebar flies the camera to every render viewpoint: front, gate, driveway, sides, back, valley, aerial, kitchen, dining, living hall, theater, pantry, powder room, master bedroom and bath, bedrooms, offices, hall and guest baths, garage and utility.
- Speed slider, shadow, forest and resolution toggles. On phones there is a joystick and drag to look.

Keys 1, 2, 3 switch between Orbit, Walk and Fly.

## Files

- `index.html`, `style.css`, `main.js`: the viewer (no build step, Three.js from a CDN via an import map).
- `assets/dream_house.glb`: web optimized model (meshopt compressed, WebP textures).
- `assets/viewpoints.json`: camera spots taken from the Blender render cameras, converted to glTF Y-up.
- `assets/forest.json`: forest tree layout from the Blender scene, drawn as light instanced trees.

The full quality GLB lives in OneDrive (Grok Bot / Dream House).

## Deploy

Pushes to `main` deploy to GitHub Pages through `.github/workflows/pages.yml`.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000.
