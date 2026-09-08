# Paper import compatibility evidence

Inspected 2026-09-07: installed Paper Desktop 0.5.6 and publicly served editor
chunks `code-import-BedfCftz.js` and `main-BpQgBQAx.js`. Desktop and web editor
versions can differ. These observations guide tests, not a stable private API.

## Observed importer behavior

- HTML is parsed as a document; element styles come from inline declarations.
  There is no observed stylesheet-driven pseudo-element capture in this path.
- Pixel content-box dimensions, including minimum/maximum dimensions, are
  adjusted for padding and borders before box-sizing is removed.
- Absolute elements can be reparented to a positioned containing ancestor.
  Fixed positioning becomes absolute positioning.
- Text may become a separate child or turn its wrapper into a text node.
  Source DOM structure therefore does not guarantee identical Paper layers.
- Native form controls have special conversion paths. Importing the tag alone
  is not evidence that its browser appearance survived.

## Observed style parser behavior

- Styles are normalized, tokens resolved, and several paint properties converted
  into internal fill, border, shadow, font, and filter metadata.
- Text and frame parsing follow different rules. Some defaults and unsupported
  properties are stripped, and transforms are normalized.
- Canvas internals include grid-related structures, but their presence does not
  prove that arbitrary browser grid layouts import faithfully.

## fx policy

Use the public MCP. Do not call undocumented editor handlers or modify Paper's
installation. Maintain compatibility through capture/import/readback fixtures,
not private symbol names. A successful import request is not a fidelity verdict.

Empty absolute pseudo-element decorations are emitted as editable inline boxes.
The browser regression compares source and replacement screenshots exactly.
A live Comp avatar import retained a 28px square, circular radius, and 1px solid
border in Paper. This proves that fixture, not universal pseudo-element support.
Generated text, masks and other unrepresented effects remain unresolved.

References: [HTML import documentation](https://paper.design/docs/paste/html),
[inspected importer](https://app.paper.design/assets/code-import-BedfCftz.js),
[inspected editor](https://app.paper.design/assets/main-BpQgBQAx.js).
