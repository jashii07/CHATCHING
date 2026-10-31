# Third-party code served by the page

| File | What it is | Licence |
|------|------------|---------|
| `jsQR.js` | jsQR 1.4.0 (https://github.com/cozmo/jsQR), the file `dist/jsQR.js` from the npm package, unchanged. It reads QR codes on the device, so images never leave the phone. | Apache-2.0, see `jsQR-LICENSE.txt` |

To update it: change the pinned version in `package.json`, run `npm install`, and copy the file and its `LICENSE` here again. `test/vendor.test.js` fails if the two copies differ.
