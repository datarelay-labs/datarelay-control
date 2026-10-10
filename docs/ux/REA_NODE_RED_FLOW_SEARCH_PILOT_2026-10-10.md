# REA Node-RED 5.0.7 Flow Search: Licensed Static UX Pilot

Date: 2026-10-10 KST
Owner: DataRelay Control UX Work Packet #413, existing Draft PR #414
Decision: Apply a bounded **quick-find pattern** to the existing Route Flow expert view; **do not copy competitor source**.

## Provenance and rights

- Target: OpenJS Foundation **Node-RED**, version **5.0.7**, tag commit
  [d9644c41beb0d90d1cbf9375646e4259551182af](https://github.com/node-red/node-red/tree/d9644c41beb0d90d1cbf9375646e4259551182af).
- License: **Apache-2.0**, reviewed from the pinned published `@node-red/editor-client@5.0.7`
  package's `LICENSE` and manifest. License file SHA256:
  `876efc5b0ea06ac893b0d5f88bba8abfc050d82d157d65a95453abcb4dd6b0e0`.
- npm editor-client package integrity:
  `sha512-bvgOGXvArCxTeB43P18Wu8UZAc3qXKPArr83a8BG7F2vcXFbYFbw6nbe9Euz9uWEVAEPrz3cPrGp8xVCZSyUwg==`.
- Narrow inspected files, from that **exact upstream commit**:
  - `src/js/ui/search.js`: SHA256 `f2109106a7bd9d69346518b04ac65acc7d1123fad0a276b3ff9fc1b284a0f062`.
  - `src/js/ui/sidebar.js`: SHA256 `39efa02938b5f832247309ee4521988665df4b334f069315f2052d09fefa19a7`.
  - `src/js/ui/view.js`: SHA256 `a7f927dd958ff77866d900b18950a1697dca45e75c5680273296bc9b3e0126cb`.
- Official vendor behavior documents:
  [Node-RED searching flows](https://nodered.org/docs/user-guide/editor/workspace/search),
  [Node-RED editor guide](https://nodered.org/docs/user-guide/editor/).
  Both describe a searchable workspace with node ID/name/type/property matching,
  selecting a search result, and revealing it within the editor.

## Real REA execution (not a simulated feature claim)

- Analyzer: **REA `rea-agents@6.3.0`**; published npm integrity pinned to
  `sha512-1l3L22PYqlzW70I2Z8fVjWufdBp8lN5dwXSiBERLKPP7pybiFSHeCD8LnXfAoilYkmSQe1NfRgOrbIr9ujkOfQ==`.
- Actual command: `rea analyze-javascript-application <licensed-staged-directory> --artifact-format directory --format json`
  via Node 24 on dev-atlas. Tool packages were temporary, installed with
  `--ignore-scripts`; no global REA install or agent/MCP re-registration.
- Sandbox: private user, mount, network and PID namespaces, no network during
  analysis; sensitive home/runtime directories masked. Staged JS and analyzer
  marked read-only; **the target JavaScript was parsed, not executed**.
- REA root artifact SHA256:
  `9c98ab9e93eb35f4ef464db9c67f4bdbb4457f6ce47cd96eb4083a6c130fbae4`.
  REA Evidence ID:
  `ev_46059b54f8de00396618e934061722d2a532e0f31b218bb0ec7ba0af2a9923f4`.
  Complete raw evidence SHA256:
  `dee86dabfaeec0cab646bfcba54b3513b68df9492ad119b3fbe71a76a7501e8e`.
  The ~77.8 MB raw evidence **is not committed**; only these bounded counts
  and digests are carried into the product repository.
- Actual stats: **3 parsed JavaScript files, 0 parse errors; 52,587 AST nodes;
  14 application graph nodes, 23 edges; 26,021 semantic nodes, 20,454
  relations; 501 callable fingerprints; 11,344 unresolved semantic
  observations.** The semantic graph explicitly reports **partial/truncated**
  coverage. This is NOT a whole-product functional reconstruction or runtime test.
- REA semantic evidence identifies function boundaries in `search.js` for
  `indexNode` (line 51), `search` (132), `ensureSelectedIsVisible` (245),
  `reveal` (469), `revealPrev` (484), `revealNext` (505);
  it also identifies `sidebar.js` state/navigation boundaries. These are
  function-name/line **observations only**; dynamic correctness is unknown.

## Control source reconciliation

| UX question | Control source baseline | Authorized product improvement |
| --- | --- | --- |
| Can an expert find an out-of-view Route by ID or Destination name? | Existing desktop `RoutesFlowTreeTable` rendered the first eight Streams expanded and only twelve Routes per Stream, with no direct search. | Add a local **Find in expert Route Flow** input, reuse existing mobile `routeMatchesQuery` / `streamMatchesQuery`, and reveal the exact matching Route even when beyond the default visible page. |
| Does a search alter operator state or backend data? | Existing manual expand/collapse is local presentation state; the snapshot is the source of runtime evidence. | Store search-only collapses separately; clearing the query restores manual collapse. **No API requests, writes, new index, auth or privilege changes.** |
| Can a failed search be confused with an empty installation? | Existing zero-inventory view distinguishes unknown snapshot from verified empty. | Search-no-match explicitly says **no match within the loaded snapshot**, never “no Routes configured” or “healthy”. |
| Does this duplicate mobile search? | Existing mobile compact Route cards already support Stream/Route/Destination search and attention triage. | Reuse its matching semantics; expose this additional control **only on desktop**. |

**Constraints:** Control is a data delivery gateway, not a Node-RED clone.
Route Processing remains the canonical path: **One Stream → Many Routes → Many
Destinations**. The existing Node-RED search workflow is a design precedent,
not a legal license to copy source or evidence of feature parity. No proprietary
Cribl/Confluent/Datadog binaries were inspected, no authenticated competitor UI
was visited, and no previously denied browser automation was retried.

## Qualification still required

Source tests, exact-head CI and production build are necessary but not the
product's actual-user acceptance. Browser BFS 20/97, authenticated responsive
320/375/1440 review, current installed head and two-person Full User E2E remain
open under the existing release gate. Keep PR #414 Draft and product status
PARTIAL until actual qualification and owner approval.
