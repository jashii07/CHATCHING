# Third-party code served by the page

Every file here is the pinned npm package's own file, copied unchanged, with its licence next to it. Nothing on any ChatChing page loads from another site, so a network that blocks a CDN still gets the whole app.

| File | What it is | Licence |
|------|------------|---------|
| `ag-grid-community.min.js` | AG Grid Community 36.2.0 (https://www.ag-grid.com), the file `dist/ag-grid-community.min.js` from the npm package. The orders table. | MIT, see `ag-grid-community-LICENSE.txt` |
| `lucide.min.js`, `lucide.min.js.map` | lucide 1.55.0 (https://lucide.dev), the files `dist/umd/lucide.min.js` and its source map from the npm package. The icons. | ISC, see `lucide-LICENSE.txt` |
| `jsQR.js` | jsQR 1.4.0 (https://github.com/cozmo/jsQR), the file `dist/jsQR.js` from the npm package. It reads QR codes on the device, so images never leave the phone. | Apache-2.0, see `jsQR-LICENSE.txt` |

AG Grid and Lucide came from jsDelivr until 6 Nov 2026. The bytes are the same: `public/index.html` keeps the same integrity hashes, and the browser refuses a file whose bytes differ.

To update one: change its pinned version in `package.json` (devDependencies), run `npm install`, copy the file(s) and the licence here again, and update the integrity hash in `public/index.html`. `test/vendor.test.js` fails if a copy differs from the package, or a hash from its file. `.gitattributes` keeps git from changing their line endings.
