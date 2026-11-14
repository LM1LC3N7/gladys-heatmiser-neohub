# Third-party notices

## Reference documentation

The protocol is written from the official **"neoHub API"** PDF of IMI Heatmiser
(Rev 3.01, released 01/03/2023), published on the IMI Heatmiser developer
portal (https://dev.heatmiser.com/). Nothing of that document is reproduced
here; the integration only speaks the protocol it describes.

## Example consulted (no code copied)

**hypercat-net/heatmiser-neohub** (https://github.com/hypercat-net/heatmiser-neohub),
version 2.0.0, commit f07a336 (2026-11-13), a Python client of the neoHub
WebSocket API, MIT license. It was read as an example only: its notes confirm
that the `COMMAND` field travels in the single-quoted form of the PDF
(`{'GET_LIVE_DATA':0}`), the hub answering `Invalid Json` to the double-quoted
form. No code was copied nor ported.

```
MIT License

Copyright (c) 2026 Hypercat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

- **@gladysassistant/integration-sdk** (Apache-2.0).
- **ws** (https://github.com/websockets/ws), MIT license, Copyright (c) 2011
  Einar Otto Stangvik, (c) 2013 Arnout Kazemier and contributors, (c) 2016
  Luigi Pinca and contributors. Its license file ships in the image with the
  package (`node_modules/ws/LICENSE`).
