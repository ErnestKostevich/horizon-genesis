# Attribution requirements

Horizon AI ("Horizon", "Horizon Genesis", "Horizon AI Agent") is the
work of **Ernest Kostevich** (https://github.com/ErnestKostevich).

If you redistribute, fork, host, or display Horizon — under the
Business Source License 1.1 today or AGPL-3.0 after the Change Date —
the following attribution requirements apply.

## What you may NOT do

Even under the most permissive interpretation of the license:

1. **You may not strip the original author's identity** from the
   software. The names "Ernest Kostevich", "Horizon AI", and any
   identifying logos remain visible in the About dialog, the startup
   banner, the CLI `--version` output, and the source-preview window.

2. **You may not present Horizon as your own original work.** A fork
   that simply re-skins Horizon and calls itself something else
   without acknowledgement is a license violation, regardless of how
   much code you changed.

3. **You may not remove or alter the NOTICE file, the build-info
   integrity stamp, or the LICENSE file**. These convey legal terms.
   Tampering with them tampers with the license itself.

4. **You may not use the Horizon name, logo, or trademarks to promote
   a derivative work without written permission.** "Powered by
   Horizon" with a link back is fine. "Try X — the new Horizon" is
   not.

## What you MUST do when redistributing or forking

If you ship a modified version of Horizon (whether as binaries,
source, a hosted service, or embedded in another product), you must:

1. **Preserve the LICENSE, NOTICE, and ATTRIBUTION.md files** in the
   distribution, unchanged.

2. **Clearly label your build as modified** in the About dialog, the
   CLI banner, and any "version" surface. Example:
   `Horizon AI (modified by <Your Name>) — based on the work of Ernest Kostevich`.

3. **Provide a public link to the original repository**
   (https://github.com/ErnestKostevich/horizon-genesis) in the About
   dialog and any documentation you publish.

4. **State the changes you made.** Either a CHANGES.md file in the
   distribution, or a documented list of differences from the upstream
   commit your fork is based on.

5. **Use a different name + logo + domain.** Don't call your fork
   "Horizon" or "Horizon AI". Don't host it on a domain that pretends
   to be horizonaai.dev. Pick your own name; credit the original.

## What you should ALSO do (recommended)

Not strict license requirements, but the kind of thing that lets the
project survive:

- Open a GitHub issue or email Ernest about your fork so it can be
  added to a "known forks" list — visibility helps both sides.
- Contribute fixes back upstream when you find bugs that affect the
  original codebase.
- If your fork makes commercial use of Horizon-based features beyond
  what BSL permits, contact ernest2011kostevich@gmail.com to discuss a
  commercial license — it's usually cheaper than the legal cost of
  ignoring this.

## Plugin authors and marketplace contributors

The plugin SDK ([@horizonai/plugin-cli](https://github.com/ErnestKostevich/horizon-plugin-sdk))
ships under MIT — you are free to build commercial plugins that target
Horizon without any attribution beyond "compatible with Horizon AI".

The marketplace integration (the catalog at horizonaai.dev/browse and
the NOWPayments payout pipeline) is a service operated by Ernest
Kostevich. By publishing a plugin, you agree to:

- Keep 70% of each sale; the marketplace platform takes 30%.
- Honour the permission manifest your plugin declares — don't escalate
  silently.
- Respond to security issues reported about your plugin within a
  reasonable timeframe.

## How to contact about attribution / licensing

- General questions, fork notification: open an issue at
  https://github.com/ErnestKostevich/horizon-genesis/issues
- Commercial licensing: ernest2011kostevich@gmail.com
- Trademark / brand misuse: ernest2011kostevich@gmail.com with subject
  "Horizon Brand Notice"
- Security disclosure (not attribution-related): see SECURITY.md

## Why all this?

Horizon Genesis is the work of one person without VC funding. The BSL
license is what makes it possible to fund continued development while
keeping the source open for evaluation. Honest attribution lets the
original maintainer keep building the project. Anonymous re-skinning
breaks the funding model that lets you read the source in the first
place.

If you're building something on top of Horizon and you're not sure
whether what you're doing needs attribution or a license: ask. Most
of the time the answer is "yes, attribution; no, you don't need a
commercial license" and that's free.

---

© Ernest Kostevich. All rights reserved.
Business Source License 1.1 → AGPL-3.0 (after the Change Date).
