# Third-party notices

ScoreBrush's AGPL-3.0-or-later grant applies to its own work. The components below
retain their upstream licenses and notices. The Microsoft-specific additional
permission is in [LICENSING.md](LICENSING.md).

| Component | Bundled version / scope | License and notice location |
| --- | --- | --- |
| Mozilla PDF.js | 5.6.205, build ada343803; library/worker, CMaps, fonts, profiles and decoders | Apache-2.0 for PDF.js; `app/vendor/PDFJS-LICENSE`; subcomponents below |
| PDF-lib | 1.17.1 | MIT; `app/vendor/PDF-LIB-LICENSE.md`; embedded notices in the bundle |
| JSZip | 3.10.1 | MIT option of its MIT/GPLv3 dual license; `app/vendor/JSZIP-LICENSE.md`; embedded dependency notices |
| PDF.js CMaps | From the matching PDF.js distribution | `app/vendor/cmaps/LICENSE` |
| Foxit/PDFium standard fonts | From the matching PDF.js distribution | BSD-style; `app/vendor/standard_fonts/LICENSE_FOXIT` |
| Liberation fonts | From the matching PDF.js distribution | SIL OFL-1.1; `app/vendor/standard_fonts/LICENSE_LIBERATION` |
| ICC color profile | From the matching PDF.js distribution | CC0-1.0; `app/vendor/iccs/LICENSE` |
| OpenJPEG and PDF.js wrapper | WASM and fallback decoder | BSD-2-Clause; `app/vendor/wasm/LICENSE_OPENJPEG` and `LICENSE_PDFJS_OPENJPEG` |
| qcms and PDF.js wrapper | WASM color conversion | MIT; `app/vendor/wasm/LICENSE_QCMS` and `LICENSE_PDFJS_QCMS` |
| PDFium JBIG2 and PDF.js wrapper | WASM decoder | BSD-style and Apache-2.0 notices; `app/vendor/wasm/LICENSE_JBIG2` and `LICENSE_PDFJS_JBIG2` |
| Sora | Bundled WOFF2 | SIL OFL-1.1; `app/vendor/fonts/sora-OFL.txt` |
| Bricolage Grotesque | Bundled WOFF2 | SIL OFL-1.1; `app/vendor/fonts/bricolagegrotesque-OFL.txt` |
| Microsoft WebView2 SDK | 1.0.4258.31; Core/WinForms assemblies and x64 loader | BSD-style Microsoft license; `licenses/WebView2-SDK-LICENSE.txt`; also `WebView2-LICENSE.txt` in binary ZIPs |
| Microsoft Evergreen bootstrapper | 1.3.299.15; pinned by `runtime-lock.json` | Microsoft terms; `licenses/WebView2-Evergreen-LICENSE.txt` |
| Microsoft Evergreen WebView2 Runtime | Shared installation; not bundled | Microsoft's separate runtime terms; maintained by Microsoft |

Original embedded notices remain in the JavaScript bundles. PDF-lib 1.17.1
embeds tslib 1.11.1 (Apache-2.0), pako 1.0.10/1.0.11 (MIT and zlib notices),
`@pdf-lib/standard-fonts` 1.0.0 and `@pdf-lib/upng` 1.0.1. JSZip 3.10.1 embeds
pako 1.0.5, lie 3.3.0, immediate 3.0.6 and setimmediate 1.0.5. Its browser build
uses a stub instead of readable-stream and includes the browser-pack 6.0.2 loader.
Standalone license texts and underlying font/encoding-data notices are below.
Standard-font preparation inputs and readable loader source are retained;
`third-party/source-audit.json` records their correspondence to the bundled code.
Source/provenance material is described in `third-party/README.md`.
Font download URLs and hashes are recorded in `app/vendor/fonts/sources.json`.
The source export does not install or bundle a complete Microsoft runtime.

Upstream references:

- https://github.com/mozilla/pdf.js/tree/v5.6.205
- https://github.com/Hopding/pdf-lib/tree/v1.17.1
- https://github.com/Stuk/jszip/tree/v3.10.1
- https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31/License
- https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution

Retain notices required by each component's license when distributing source or
binaries. The ICC profile and its upstream notice are retained as component
provenance; CC0 itself does not require attribution.

## Embedded JavaScript license texts

The following notices cover code embedded in PDF-lib and JSZip. Original
notices in their sources and bundles remain in place.

### @pdf-lib/standard-fonts 1.0.0

Upstream: https://github.com/Hopding/standard-fonts

```text
MIT License

Copyright (c) 2018 Andrew Dillon

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

### @pdf-lib/upng 1.0.1

Upstream: https://github.com/Hopding/upng

```text
MIT License

Copyright (c) 2017 Photopea

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

### pako 1.0.5, 1.0.10 and 1.0.11

Upstream: https://github.com/nodeca/pako

```text
(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### lie 3.3.0

Upstream: https://github.com/calvinmetcalf/lie

```text
#Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

**THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.**
```

### immediate 3.0.6

Upstream: https://github.com/calvinmetcalf/immediate

```text
Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### setimmediate 1.0.5

Upstream: https://github.com/YuzuJS/setImmediate

```text
Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, and Domenic Denicola

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### pako zlib portions (embedded 1.0.5, 1.0.10 and 1.0.11)

Upstream: https://github.com/nodeca/pako

```text
// (C) 1995-2013 Jean-loup Gailly and Mark Adler
// (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin
//
// This software is provided 'as-is', without any express or implied
// warranty. In no event will the authors be held liable for any damages
// arising from the use of this software.
//
// Permission is granted to anyone to use this software for any purpose,
// including commercial applications, and to alter it and redistribute it
// freely, subject to the following restrictions:
//
// 1. The origin of this software must not be misrepresented; you must not
//   claim that you wrote the original software. If you use this software
//   in a product, an acknowledgment in the product documentation would be
//   appreciated but is not required.
// 2. Altered source versions must be plainly marked as such, and must not be
//   misrepresented as being the original software.
// 3. This notice may not be removed or altered from any source distribution.
```

### tslib 1.11.1

Upstream: https://github.com/microsoft/tslib/tree/1.11.1

```text
/*! *****************************************************************************

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use

this file except in compliance with the License. You may obtain a copy of the

License at http://www.apache.org/licenses/LICENSE-2.0



THIS CODE IS PROVIDED ON AN *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY

KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION ANY IMPLIED

WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A PARTICULAR PURPOSE,

MERCHANTABLITY OR NON-INFRINGEMENT.



See the Apache Version 2.0 License for specific language governing permissions

and limitations under the License.

***************************************************************************** */

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

## Standard-font data notices

### Adobe Core 14 font metrics in @pdf-lib/standard-fonts 1.0.0

PDF-lib includes metric data from the 14 PostScript AFM files in `@pdf-lib/standard-fonts` 1.0.0. Their release-associated source is [Hopding/standard-fonts at 41a6440267de5456042c7bcbac5ec65065e2ef69](https://github.com/Hopding/standard-fonts/tree/41a6440267de5456042c7bcbac5ec65065e2ef69). The original AFMs and their accompanying `font_metrics/MustRead.html` are retained unchanged in the corresponding source archive. A byte-identical accompanying notice is also retained at `third-party/notices/standard-font-data/MustRead.html`.

The upstream generator converts the AFMs to JSON, retains the font `Notice` fields, retains character widths and names, omits per-character codes, bounding boxes and ligatures, then applies DEFLATE and Base64 encoding. These upstream generated data are embedded in `app/vendor/pdf-lib.min.js`; ScoreBrush does not modify the original AFMs or these generated payloads.

The Adobe permission applies to the 14 AFMs; the package's MIT license does not replace these data terms. The original permission paragraph follows unchanged:

This file and the 14 PostScript(R) AFM files it accompanies may be used, copied, and distributed for any purpose and without charge, with or without modification, provided that all copyright notices are retained; that the AFM files are not distributed without this file; that all modifications to this file or any of the AFM files are prominently noted in the modified file(s); and that this paragraph is not modified. Adobe Systems has no responsibility or obligation to support the use of the AFM files.

The font copyright and trademark notices follow, grouped only when identical:

`Courier-Bold`, `Courier-BoldOblique`:

```text
Copyright (c) 1989, 1990, 1991, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
```

`Courier-Oblique`, `Courier`:

```text
Copyright (c) 1989, 1990, 1991, 1992, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.
```

`Helvetica-Bold`, `Helvetica-BoldOblique`, `Helvetica-Oblique`, `Helvetica`:

```text
Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated.  All Rights Reserved.Helvetica is a trademark of Linotype-Hell AG and/or its subsidiaries.
```

`Symbol`:

```text
Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All rights reserved.
```

`Times-Bold`, `Times-BoldItalic`, `Times-Italic`, `Times-Roman`:

```text
Copyright (c) 1985, 1987, 1989, 1990, 1993, 1997 Adobe Systems Incorporated.  All Rights Reserved.Times is a trademark of Linotype-Hell AG and/or its subsidiaries.
```

`ZapfDingbats`:

```text
Copyright (c) 1985, 1987, 1988, 1989, 1997 Adobe Systems Incorporated. All Rights Reserved.ITC Zapf Dingbats is a registered trademark of International Typeface Corporation.
```

### Unicode encoding data in @pdf-lib/standard-fonts 1.0.0

The package derives its Symbol and Zapf Dingbats mappings from the Unicode 2.0, table version 1.0 (2011-07-12) [Symbol](https://www.unicode.org/Public/MAPPINGS/VENDORS/ADOBE/symbol.txt) and [Zapf Dingbats](https://www.unicode.org/Public/MAPPINGS/VENDORS/ADOBE/zdingbat.txt) tables. The original source headers and mapping rows are retained in the source archive. The upstream generator converts the mappings into a combined JSON object, selects the needed mapping/name fields, removes the `(CUS)` glyph-name annotation, and applies DEFLATE and Base64 encoding. The following original file-specific notice applies to both tables and is retained with their derived data:

```text
#  Copyright (c) 1991-2011 Unicode, Inc. All Rights reserved.
#
#  This file is provided as-is by Unicode, Inc. (The Unicode Consortium). No
#  claims are made as to fitness for any particular purpose. No warranties of
#  any kind are expressed or implied. The recipient agrees to determine
#  applicability of information provided. If this file has been provided on
#  magnetic media by Unicode, Inc., the sole remedy for any claim will be
#  exchange of defective media within 90 days of receipt.
#
#  Unicode, Inc. hereby grants the right to freely use the information
#  supplied in this file in the creation of products supporting the
#  Unicode Standard, and to make copies of this file in any form for
#  internal or external distribution as long as this notice remains
#  attached.
#
```

The [CP1252-to-Unicode table](https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WINDOWS/CP1252.TXT), Unicode 2.0/table version 2.01 dated 1998-04-15, has no file-specific license header. The [Unicode Terms of Use](https://www.unicode.org/copyright.html) apply Unicode License v3 to Unicode data files under `https://www.unicode.org/Public/` unless a specific exception is identified. The retained CP1252 table has the same mapping rows as that published data file. The full applicable license follows and is retained at `third-party/notices/standard-font-data/Unicode-LICENSE-v3.txt`:

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

### PDFKit WinAnsi glyph names

The `@pdf-lib/standard-fonts` Win1252 generator combines the CP1252 mapping with the 256-name WinAnsi table from [PDFKit `lib/font/afm.js` at 83f5f7243172a017adcf6a7faa5547c55982c57b](https://github.com/foliojs/pdfkit/blob/83f5f7243172a017adcf6a7faa5547c55982c57b/lib/font/afm.js). It omits `.notdef` entries and includes the selected names in the generated Win1252 data. The table is retained in `scripts/encodings/parseWin1252.ts` in the standard-fonts source archive. Its original MIT license follows and is also retained at `third-party/notices/standard-font-data/PDFKit-LICENSE.txt`:

```text
MIT LICENSE
Copyright (c) 2014 Devon Govett

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## base64-arraybuffer code embedded in standard-fonts

The `chars`, `lookup`, and `decodeFromBase64` code in `@pdf-lib/standard-fonts` is attributed upstream to base64-arraybuffer by Niklas von Hertzen. The standard-fonts 1.0.0 lockfile resolves base64-arraybuffer 0.1.5. Its original JavaScript and full MIT license are retained under `base64-arraybuffer-0.1.5/` in `third-party/upstream-sources/standard-fonts-1.0.0-41a6440-source.tar.gz`.

Source: https://registry.npmjs.org/base64-arraybuffer/-/base64-arraybuffer-0.1.5.tgz

Copyright (c) 2012 Niklas von Hertzen

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

## Browserify loader (browser-pack 6.0.2)

JSZip includes the browser-pack loader by James Halliday.
Source: https://registry.npmjs.org/browser-pack/-/browser-pack-6.0.2.tgz
Readable source and original notice: third-party/upstream-sources/browser-pack-6.0.2-loader-source.tar.gz.

This software is released under the MIT license:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
