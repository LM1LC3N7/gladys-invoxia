# Third-party notices

Nothing but the Gladys SDK is installed at runtime. Parts of this
integration are a JavaScript port of the work below.

## gps-tracker

gps-tracker 0.9.2 (<https://gitlab.com/ezlo.picori/gps_tracker>, read at
commit `c01cb4e`), an unofficial Python client of the Invoxia API, under the
MIT License. Ported to JavaScript in `src/invoxia/`: the API address and the
HTTP Basic authentication (`client/config.py`, `client/asynchronous.py`),
the paths of the requests (`client/url_provider.py`), the shapes of the
answers and how their dates are read (`client/datatypes.py`), what a refusal
is (`client/exceptions.py`), and the shapes of its test fixtures
(`tests/fixtures/`, used with made-up values in `test/`).

```
The MIT License (MIT)

Copyright (c) 2021 Ezlo Picori

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

Invoxia is a trademark of its owner; this integration is unofficial and not
affiliated with Invoxia.

## LM1LC3N7/gladys-phonetrack

The structure of the app (start queue, epochs of the loop, refusal kept as
a salted HMAC in `/data`, bounded pauses, state budget, transport badges,
never a smaller device, the "silent" trigger), the HTTP transport and the
test helpers follow this integration of the same author, under the Apache
License 2.0 of this repository.
