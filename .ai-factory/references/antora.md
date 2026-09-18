# Antora Reference

> Source: https://docs.antora.org/antora/latest/ (docs for Antora 3.2)
> Upstream sources: https://gitlab.com/antora/antora (`docs/` on branch `main`)
> Related: https://docs.antora.org/antora/latest/ (site), https://antora.org, https://gitlab.com/antora/antora-ui-default
> Created: 2026-09-18
> Updated: 2026-09-18

## Overview

Antora is a static site generator for software documentation, aimed at technical writers ("docs as code"). Authors write content in **AsciiDoc**, organize it into a standard project structure, and store it in one or more git repositories. Antora aggregates those repositories and transforms them into a website.

Docs-as-code practices Antora is built around: content in version control, separation of content/configuration/presentation, automation for validation and publishing, and reuse of shared material (DRY).

The generator pipeline (default, opinionated, extensible):

1. **Build playbook** — read the playbook file (YAML, JSON, or TOML) and build a playbook object.
2. **Load content repositories** — clone/fetch the git repositories (or local folders) listed in `content.sources` into a local cache.
3. **Find the content source roots** — starting at each content source root, look for `antora.yml`; a sibling `modules` directory holds that component version's files.
4. **Transform input files into virtual file objects** and assign them to component version buckets.
5. **Compute additional metadata** (module, family, family-relative path, output path, publish path).
6. **Organize files into a content catalog**, registering component version start pages and the site start page.
7. **Convert AsciiDoc pages to embeddable HTML** with Asciidoctor.js.
8. **Convert navigation files** into a navigation model (trees grouped into menus).
9. **Locate and fetch the UI bundle**, classify UI files (`ui.yml`), and compute their output paths.
10. **Wrap converted content in page templates** (Handlebars) with site metadata, component/version context, and navigation model.
11. **Produce the sitemap** (partitioned per component via a sitemap index).
12. **Publish the site** to one or more destinations.

The default site generator can be replaced via `--generator` with a library or script exporting `generateSite(args, env)`.

## Core Concepts

| Term | Meaning |
| --- | --- |
| **Component** | A project, product, library, service, or course whose docs are published together. Never declared directly; it is created by having at least one component version sharing the same `name`. |
| **Component version** | A discrete version of the docs for a component, declared by an `antora.yml` file (component version descriptor). Identified by `name` + `version`. |
| **Versionless component** | A component version with an empty `version` (`~` / `null`). Renders without a version segment in URLs. |
| **Module** | A grouping of content inside a component version, represented by a module directory. Becomes a URL segment (except `ROOT`). |
| **Family** | The function/type of a source file, determined by its family directory: `pages`, `partials`, `examples`, `images`, `attachments`. |
| **Resource** | A source file assigned to a family. Every resource gets a unique **resource ID** of five coordinates. |
| **Publishable resource** | A resource in `pages`, `images`, or `attachments` — published automatically even if unreferenced. Partials and examples are published only when included. |
| **Content source** | A git repository (remote URL or local path) plus refname filters, listed in the playbook. |
| **Content source root** | The location in a branch/tag where Antora starts looking for `antora.yml`. Defaults to the repository root; changed with `start_path` / `start_paths`. |
| **Playbook** | The site manifest (`antora-playbook.yml`): what content to use, how to process it, and where to publish. |
| **UI bundle** | A ZIP archive (or directory) of Handlebars templates, helpers, CSS, and JS that turns embeddable HTML into pages. |
| **Site** | The generated output directory (default `./build/site`). |

Key consequences:

- A component version may be assembled from **many** repositories, branches, tags, and start paths. Antora decides which files belong together based on descriptor metadata, not on filesystem or repository location.
- Source layout never determines the published URL. Each family has its own rules for output path and URL.
- References between resources are **source-to-source** (via resource IDs), not URL-based, so they survive environment and URL-strategy changes.

## Content Source Layout (Standard File and Directory Set)

Antora collects files based on a reserved hierarchy that starts at the content source root.

```text
repository/                 # content source root by default
  antora.yml                # required component version descriptor (reserved name)
  modules/                  # required; sibling of antora.yml
    ROOT/                   # optional ROOT module directory (uppercase, reserved)
      attachments/          # optional family directories
      examples/
      images/
      pages/
      partials/
      nav.adoc              # optional navigation file (not inside a family directory)
      assets/               # optional alternate location for attachments/ and images/
        attachments/
        images/
    named-module/           # optional named module directory (as many as needed)
      pages/
      nav.adoc
  packages/                 # ignored: outside modules/
```

Minimum requirements at a content source root:

- An `antora.yml` file.
- A `modules` directory at the same level as `antora.yml`.
- At least one module directory inside `modules`.
- At least one family directory inside that module containing at least one source file.

If the content source root is not the repository root, point Antora at it with `start_path` / `start_paths` on the content source in the playbook.

### Module rules

- Two kinds: the **ROOT module directory** (must be spelled `ROOT`, all uppercase) and **named module directories**. A module directory must contain at least one family directory with at least one source file, and may contain zero or more navigation files.
- The module name is the directory name (the `ROOT` module is the exception; it is an alias for a blank module name). Module names are used both as the module coordinate in resource IDs and as a URL segment.
- Named module directories must not contain blank spaces or forward slashes (`/`). Avoid uppercase letters, underscores, and characters that are not URL-recommended. Keep names short — writers must type them in resource IDs.
- If a module name ends with the name of a built-in AsciiDoc macro (e.g. `link`, `menu`), that part may need escaping in an xref: `monolink` → `mono\link`.
- A module does not have to contain `pages`; a module can exist with only `images` or `examples`. But if a `pages` directory exists, it (or a subdirectory) must contain at least one `.adoc` file.
- The `ROOT` module's pages become the top-level pages of the component version, and `ROOT` never appears in a URL. Its `pages/index.adoc` becomes the component version's default start page.
- **Implicit ROOT module:** if the content source root has no `modules` directory, the content source root itself is treated as the ROOT module, so family directories can sit directly next to `antora.yml`. Adding `modules/` later requires moving those files under `modules/ROOT`.

### Family directories

Family directories are created at the root of a module directory, one per family. All are optional.

| Family (reserved directory name) | Purpose | Published? |
| --- | --- | --- |
| `pages` | AsciiDoc documents (`.adoc`) with a page title | Yes — converted to HTML and published individually, even if unreferenced |
| `partials` | Reusable content snippets (usually AsciiDoc) inserted with `include::` | No — only via an include directive |
| `examples` | Source code samples, terminal output, data sets referenced with `include::` | No — only via an include directive |
| `images` | Photos, diagrams, screenshots (PNG, JPG, SVG, GIF) | Yes — unless hidden or missing a file extension |
| `attachments` | Downloadable files (PDF, ZIP), linked with `xref:` | Yes — unless marked unpublished |

An `assets` directory at the module root is an alternate container for the `attachments` and `images` family directories.

### Hidden, unpublished, and private files

- **Hidden file:** name begins with a dot (`.`); files without a file extension are also hidden — except in `examples` and `partials`, where extensionless files are allowed. Hidden files are not added to the content catalog, get no resource ID, cannot be referenced, and are not published.
- **Unpublished file:** added to the catalog and assigned a resource ID (so it can be referenced), but not published. Files outside a publishable family (examples, partials) are intrinsically unpublished. A **private file** (name begins with `_`, or stored in a directory whose name begins with `_`) is unpublished even inside a publishable family; the `private` property, when explicitly set, overrides this.

## Component Version Descriptor (`antora.yml`)

`antora.yml` has two jobs: (1) its presence at a content source root tells Antora to collect the sibling `modules` directory, and (2) it supplies the component version metadata that Antora assigns to all collected files.

Required keys:

| Key | Description |
| --- | --- |
| `name` | Component name, used with `version` to identify a component version; used as the component coordinate in resource IDs and as the component URL segment. |
| `version` | Version, used with `name`; used as the version coordinate and the URL version segment (except for an empty version). Optional in the descriptor if inherited from the content source in the playbook. |

Optional keys:

| Key | Description |
| --- | --- |
| `title` | Display name for menus, selector, breadcrumbs, and version sorting. Falls back to `name`. No effect on IDs or URLs. |
| `display_version` | Presentation-only version label (e.g. `3.0 Beta`, `RED WREN!`). Falls back to `version`. No effect on IDs, URLs, or sorting. Quote it if it begins with a number. |
| `prerelease` | Marks the version as a prerelease and deactivates default routing rules. Accepts an identifier (e.g. `-rc.3`, `Beta`) or `true`; set `false` (or delete) to graduate to stable. |
| `start_page` | Resource ID of the component version's home page. Default: `index.adoc` in the `ROOT` module. |
| `nav` | List of navigation file paths relative to `antora.yml`. Registration order defines menu order. |
| `asciidoc.attributes` | Map of built-in/custom/page attributes applied to every page and resource of the component version. |
| `ext` | Extension keys contributed by Antora/Asciidoctor extensions (extension-defined). |

### `name` rules

- May contain letters, numbers, underscores (`_`), hyphens (`-`), periods (`.`). Use lowercase for portability.
- May not contain spaces, forward slashes (`/`), or HTML special characters (`&`, `<`, `>`), and may not be empty.
- Case sensitive: components differing only in case are different components. Use consistent casing across versions.
- Used as the component URL segment, unless the name is `ROOT`.
- `name: ROOT` combined with `version: ~` publishes the component at the site root (both the component and module `ROOT` segments are dropped), which is how a hand-written site gets `/index.html` and `/deploy.html` instead of nested paths. A `ROOT` component needs its own `antora.yml` and `modules` directory. Because its segments vanish, its modules are scoped under the site root and can collide with a same-named component — set `title` since `ROOT` is not user-friendly.

### `version` rules

- Literal values may contain letters, numbers, periods, underscores, hyphens; use lowercase; no spaces, `/`, `&`, `<`, `>`.
- **Semantic identifier:** an integer, or a string beginning with a number and containing at least one dot (plus the optional leading `v`). Examples: `10`, `1.0.0`, `5.1`, `v9.0.2` (the `v` is preserved but ignored when sorting). Quote values that look like numbers in YAML.
- **Named identifier:** anything else, e.g. `rigel`, `edge`.
- **Refname as version:** `version: true` substitutes the git refname (always the short refname; `/` becomes `-`).
- **Refname projection:** a map of pattern → replacement, using the same glob/extglob capabilities as branch matching. Parentheses form match groups; `(?<name>...)` names them, otherwise `$1`, `$2`… index them; `$&` is the whole refname. First matching pattern wins; if none matches, the refname is used as the version.

```yaml
name: colorado
version:
  v(?<version>+({0..9}).+({0..9})).x: $<version>
  feature/(*)/*: $1
```

- The descriptor's `version` takes precedence over a `version` key on the playbook content source. Omit it in the descriptor to let the playbook derive it.
- `version: ~` (or `null`) makes the component version versionless: it sorts above other versions of the component, is treated as the latest one, gets `display_version: default` at runtime (unless overridden), and publishes without a version segment even if `latest_version_segment` is set — unless `latest_version_segment_strategy: redirect:from`.
- To reference a versionless component version from elsewhere, use the reserved version coordinate `_`: `xref:_@component:module:file.adoc[]`.

### `title` vs `display_version` vs `version`

- `version` is the identity: it drives sorting, latest-version selection, routing rules, and the URL version segment.
- `title` is a human-facing name for the component version; it also sorts components in the UI (falling back to `name`). Keep it uniform across versions of a component.
- `display_version` only changes the label in the version selectors. It never changes sorting, IDs, routing, or URLs.

### `prerelease`

- A component version is a prerelease when `prerelease` holds a non-empty identifier or `true`.
- It does not make the version unique: removing the key leaves the component version identity unchanged.
- Antora skips prereleases when choosing the latest version, unless every version of the component is a prerelease.
- Prereleases do not get the default routing rules, even when they would otherwise be the latest version.
- Identifier handling: if the identifier starts with `-` or `.`, Antora appends it to `version` (`6.0.0` + `-rc.3` → `6.0.0-rc.3`); otherwise it separates it with a space (`4.0` + `Beta` → `4.0 Beta`). That computed value becomes `display_version` unless one is set explicitly.
- Inbound references without a version coordinate route to the latest **stable** version, not to a prerelease. Because the actual version is unchanged, URLs and explicit references survive graduation to stable.

### `start_page`

- Defaults to `index.adoc` in the `ROOT` module. Set the key when that file is absent or when a different page should be the entry point.
- Accepts a page resource ID that belongs to this component version, starting at the module coordinate (`ROOT` is implied): `start_page: get-started:overview.adoc` or `start_page: overview.adoc`.
- Without a start page, visitors clicking the component version get a 404.

### `nav`

- A list of navigation file paths relative to `antora.yml` (each on its own line, no indentation, `- ` prefix).
- Only contents of registered files are assembled into the component version page menu. Order of values dictates menu order — Antora concatenates the files in the order listed.

### `asciidoc.attributes` and attribute precedence

- Declares component version attributes applied to all pages/resources of the component version. Can set built-in, custom, and page (`page-`-prefixed) attributes.
- Values may reference earlier attributes in the same file or site attributes (`{site-title}`, `{page-level}`); quote values starting with `{`. Escape a reference with a backslash to prevent substitution.
- Set an attribute with no explicit value using `''`; multiple independent values are separated with `;`.
- Modifiers, relative to site attributes (playbook) and page headers:

| Form | Meaning | Overridable by page? |
| --- | --- | --- |
| `value` (or `''`) | Hard set | No |
| `value@` (or `'@'`) | Soft set (`'@'` assigns the built-in default) | Yes |
| `~` | Hard unset | No (page cannot set it) |
| `false` | Soft unset | Yes |

- Intrinsic component attributes `antora-component-name` and `antora-component-version` are available to attributes defined in `antora.yml`. Antora also derives intrinsic page attributes from most descriptor keys (e.g. `page-component-title`), which cannot be referenced from `antora.yml` but are available to pages.

### Distributed component versions

- Source files of one component version may live in multiple content source roots (multiple repositories and/or start paths).
- When several `antora.yml` files declare the same `name` and `version`, Antora collects all their files into one component version.
- Only one of those descriptors should carry optional configuration (`title`, `nav`, etc.); the rest must declare only `name` and `version`. Conflicting optional keys produce unpredictable results.
- Each content source root must contribute a unique set of files (other than `antora.yml`) — overlapping roots cause duplicate resource IDs, which is a fatal error.

## Pages

Every AsciiDoc file in a `pages` family directory becomes exactly one HTML page, whether or not anything links to it.

- A page has a **header** and a **body**. The header is a set of contiguous lines starting on the first line of the file; it ends at the first blank line.
- The **page title** is the only required header element and must use Atx-style markup (a single `=` at the start of a line). Setext-style titles are not recognized, and without a title xrefs and other features stop working. The title must not contain resource references (xrefs, images) because it is used in navigation.
- Filenames are used to compute URLs. A leading dot or a missing file extension makes the page hidden; a leading underscore makes it unpublished. Use URL-compliant, lowercase filenames without spaces.
- Header lines can be attribute entries, comment lines, and an author line beneath the title. Some header attributes (`description`, `keywords`, author) are emitted as HTML `<meta>` tags by the UI.

```asciidoc
= Page Title
:description: A description of the page stored in an HTML meta tag.
:keywords: docs, antora, asciidoc
:page-toclevels: 2

This is the first line of the page body.
```

### Page attributes

- Any attribute whose name begins with `page-` is a **page attribute**. Its prefix is dropped when promoted into the UI model (`page-toclevels` → `page.attributes.toclevels`), where UI templates read it.
- Page attributes must be defined in the page header; otherwise they are not found. They may be blank (`:page-pagination:`) or have a value separated from the closing colon by at least one space.
- Values are strings; custom values may be referenced in content with `{page-name}`. A non-page attribute can be promoted by referencing it: `:page-product-name: {product-name}`.
- Documented page attributes include `page-aliases`, `page-layout`, `page-toclevels`, `page-pagination`, `page-partial`, plus any custom `page-*` name. `reftext` and `navtitle` are ordinary document attributes (no `page-` prefix) — see below.
- To turn built-in/custom attributes off (or on from a default), use `:!name:` / `:name!:`.

### Attribute precedence

For any AsciiDoc document attribute (except read-only intrinsics), the definition order from highest to lowest precedence is:

```text
CLI (--attribute)  >  playbook (asciidoc.attributes)  >  component descriptor (antora.yml)  >  page header
```

The order can be inverted per attribute with the `@` precedence modifier. Attributes hard set or hard unset in the playbook/descriptor beat page-defined values unless the site value is soft set with a trailing `@`.

### `page-layout`

- `:page-layout: tiles` applies the UI layout `tiles.hbs` from the bundle's `layouts` directory to the page.
- Precedence: `page-layout` in the page header → `ui.default_layout` in the playbook → built-in `default` (`layouts/default.hbs`).

### Intrinsic page attributes

Read-only attributes Antora assigns to each page (and navigation file) when it is loaded. They are a conduit from Antora to the page, should not be reassigned, and are reassigned per page/navigation file.

Environment: `env=site`, `env-site`, `site-gen=antora`, `site-gen-antora` (useful in `ifdef::site-gen-antora[]` conditionals to include content only in proper Antora builds).

Site/configuration (reconfigurable, unlike other intrinsics): `attribute-missing=warn`, `!data-uri`, `icons=font`, `sectanchors`, `source-highlighter=highlight.js`, `site-title`, `site-url`.

Page intrinsics:

| Attribute | Value |
| --- | --- |
| `page-component-name` | Component `name` |
| `page-component-title` | Component `title` |
| `page-component-version` | Component `version` |
| `page-component-display-version` | Component `display_version` |
| `page-component-latest-version` | Version string of the latest version of the component |
| `page-component-version-is-latest` | Set (empty) when the current version is the latest |
| `page-version` | Alias for `page-component-version` |
| `page-module` | Module name of the page |
| `page-relative-src-path` | Path relative to `modules/<module>/pages` |
| `page-edit-url` | URL where the page source can be edited |
| `page-origin-url`, `page-origin-type` | Content source URL (without credentials) and type (e.g. `git`) |
| `page-origin-refname`, `page-origin-refhash`, `page-origin-reftype` | Reference name, SHA-1, type (`branch`/`tag`); refhash is `(worktree)` for a worktree |
| `page-origin-branch` / `page-origin-tag` | Mutually exclusive branch/tag name |
| `page-origin-start-path` | Start path of the content source |
| `page-origin-worktree` | Absolute path of the worktree, when read from one |
| `page-origin-private` | Set (empty) when the origin is private |

### `reftext` and `navtitle`

- `reftext` supplies the link text used when an xref specifies none. Default: the target page's title.
- `navtitle` supplies the link text used by xrefs that originate in a **navigation file**. Default: the target page's `reftext`.
- Fallback chain: `navtitle` → `reftext` → page title.
- Caveat: when the resource ID is followed by a fragment (`xref:page.adoc#fragment[]`), link text is **not** populated automatically — specify it explicitly.

## References and Links

### Resource ID

A resource ID identifies a resource with five coordinates in a fixed order: **version, component, module, family, file**. Delimiters: `@` after the version, `:` after component and module, `$` after family (the family name minus its trailing `s`), and `#` before a fragment. Only the coordinates needed for the context are written.

| Coordinate | Derived from | Required when |
| --- | --- | --- |
| version | `version` in `antora.yml` or on the playbook content source; always first, followed by `@` | Target is in a different version of the component |
| component | `name` in `antora.yml`; followed by `:` | Target is in a different component |
| module | Module directory name; followed by `:` | Target is in a different module |
| family | Family directory name → `page$`, `image$`, `partial$`, `example$`, `attachment$` | Depends on family and syntax — see below |
| file | Path **relative to the family directory**, including the extension (except extensionless partials/examples) | Always |

Family coordinate requirements by referencing syntax:

| Target | Syntax | Family coordinate required? |
| --- | --- | --- |
| page | xref macro | No (`page$` assumed) |
| page | include directive | No (`page$` assumed) |
| attachment | xref macro | Yes (`attachment$`) |
| image | block/inline image macro | No (applied at runtime) |
| image | xref macro | Yes (`image$`) |
| partial | include directive | Yes (`partial$`) |
| example | include directive | Yes (`example$`) |

File-coordinate rules:

- The file coordinate is always computed from the family directory, never from the current page's directory. Pages map to distinct URLs; the `.adoc` extension is dropped from the published URL.
- The token `./` abbreviates the family-relative directory path when the target and the current page live in the same subdirectory of a family directory.
- Reserved characters can be percent-encoded; Antora decodes them before resolving (e.g. `c%2B%2B.adoc` for `c++.adoc`).
- A versionless target can be referenced with the reserved version coordinate `_`.
- Two resources may never share a resource ID. When that happens Antora logs a fatal error (duplicate page/nav file) and stops the build immediately — usually caused by a redundant content source root or an un-updated `version` in `antora.yml`.

### xref macro

```asciidoc
xref:resource-id-of-target-page.adoc[optional link text]
xref:resource-id.adoc#fragment[optional link text]
```

Target forms:

| Situation | Form |
| --- | --- |
| Same component version and module | `xref:file-coordinate.adoc[]` |
| Same component version, different module | `xref:module:file-coordinate.adoc[]` |
| Different component (latest version) | `xref:component:module:file-coordinate.adoc[]` |
| Different version, same module | `xref:version@file-coordinate.adoc[]` |
| Different version and module | `xref:version@module:file-coordinate.adoc[]` |
| Fully qualified | `xref:version@component:module:file-coordinate.adoc[]` |

- **ROOT shorthand:** when a component coordinate is given and the target is in the `ROOT` module, the module name may be omitted but its colon must remain: `xref:5.2@colorado::ranges.adoc[]`.
- **Latest version:** if the component is given without a version (and the target is in a different component), Antora resolves the version coordinate to that component's latest version at runtime. Warning: if neither version nor component is specified, Antora assumes the target is in the **same** component version as the current page.
- Link text: if omitted and no fragment is present, the target page's `reftext` (default: its title) is used. With a fragment present, specify link text explicitly.
- Do not use the shorthand `<<other-page.adoc#id>>` form for cross-document references; always prefer the xref macro.
- The xref macro also links to attachments (`attachment$…`) and images (`image$…`). For those, no fragment may be appended, and when no link text is given the target URL/link is displayed rather than a title.

### Page aliases

```asciidoc
= Title of Target Page
:page-aliases: old-name.adoc, 1.4@component-8:module-u:source-w.adoc
```

- `page-aliases` claims one or more former resource IDs so their URLs redirect to this page. Use it for renames and moves.
- Coordinates omitted from an alias are interpolated from the target page's coordinates.
- Aliased IDs also work inside xrefs, so references need not be updated when a page is renamed.
- Only pages can be aliased — not partials, examples, images, or attachments. The version selector does not link old versions through aliases.
- This is not a general-purpose URL router: bulk redirects should be handled by the web server or an Antora extension. Redirect output form depends on `urls.redirect_facility`.

## Navigation Files (`nav.adoc`)

- A navigation file is one or more unordered AsciiDoc lists stored at the base of a module directory (same level as `pages`, never inside it, or it will be published as a page).
- It must be **registered** under the `nav` key in `antora.yml` for its contents to be assembled into the component version page menu.
- Nested items use additional asterisks, up to level five (`*****`). Each item goes on its own line, with a space after the marker. Blank lines and comment lines may be interspersed.
- A list title is written with a leading dot and no space: `.Title`. When a nav file contains multiple lists, each list must start with a list title and lists must be separated by at least one blank line.
- Entries may be page xrefs, attachment xrefs, external links, or plain (optionally formatted) text. If an entry contains an xref, the xref must be the only content of that item; regular links may be combined with other content.

```asciidoc
.Getting Started
* xref:index.adoc[]
** xref:install.adoc[Installation Setup and Steps]
* CLI Commands
** xref:commands.adoc[]

.Support
* https://support.project.com[Get Help]
* xref:attachment$practice-project.zip[Practice Project]
```

- Default link text precedence in navigation: target page's `navtitle` → `reftext` → title. (Same fragment caveat as xrefs.)
- Compose nav files with `include::`. The include target must be a file Antora classifies (a page or a partial) — files at the module root are not classified. To nest an included list under an item, wrap the include in an open block attached with a list continuation:

```asciidoc
* Getting Started
+
--
include::partial$getting-started.adoc[]
--
```

- Xrefs in a nav file may target any page in the site (other modules, other components); a per-module nav file is a convention, not a requirement. Referencing a page in another version is discouraged.

## Content Reuse

### Partials

- AsciiDoc (usually) snippets stored in a `partials` family directory; not published unless included from a page (or from another resource eventually included in a page).
- A partial has no required structure (no title needed). An extensionless partial is still loaded and gets a resource ID.
- A partial is converted **after** insertion, so the including page's component version, module, attributes, and context apply to it.
- A partial's attribute assignment overrides a same-named attribute set in the including page's header or soft-set by its descriptor.
- IDs inside a partial must not collide with the host page's IDs, and headings may need `leveloffset`.
- A reference inside a partial is resolved relative to the **including page**, not the partial. Qualify references to the broadest context in which the partial is used: a fragment suffices if there is exactly one including page; add the page coordinate if several; add the module coordinate if several modules. Nested includes are exempt (includes know their own context).

### Examples

- Files in an `examples` directory: source samples, terminal output, data sets, diagrams sources, etc. Not published unless included.
- Extensionless files are allowed and are not treated as hidden.
- Storing code samples as examples (rather than partials) is recommended; an example is a specialized form of a partial.
- Diagram sources are conventionally stored under `partials/diagrams` and included into a diagram block.

### Includes

```asciidoc
include::partial$treeline-warning.adoc[]
include::example$providers/job.yml[]
include::ROOT:partial$treeline-warning.adoc[]
include::5.2@colorado:ROOT:partial$treeline-warning.adoc[]
```

- The include directive treats its target as a resource ID. The family coordinate is required for `partial$` and `example$`; `page$` is assumed when omitted.
- The include directive is aware of the file it is in, unlike an xref: relative targets are relative to the current file (and the family is inherited from it).
- Absolute filesystem paths and URLs cannot be included. An include cannot be used inside another include's target family file type (e.g. an example cannot include an example).
- Documented selection attributes: `tag`, `tags`, `lines` (select regions/lines), `leveloffset` (offset inserted section headings), `indent` (normalize block indentation). Tagged regions are the recommended way to include partial examples of a file.
- Placement matters: with blank lines around it, included content becomes a standalone block; placed adjacent to other lines, it is folded into that block (e.g. inside a source block).

### Including pages: `page-partial`

- Pages are converted to HTML as they are processed, so a page including an already-converted page would receive HTML instead of AsciiDoc.
- `:page-partial:` in the included page's header makes Antora retain AsciiDoc source until all pages are converted. Since Antora 2.2 it is soft-set globally by default (it may increase peak heap use ~10% on very large sites).
- To revert, set `page-partial: false` in the playbook's `asciidoc.attributes`, then mark any page used in an include with `:page-partial:`.

### Images

- Block macro `image::target[attrs]` renders a discrete element (blank lines around it); inline macro `image:target[attrs]` flows within other content.
- Positional attributes come first, in the order `alt`, `width`, `height`; named attributes follow: `xref` (link the image to a page/attachment/image/element, with `#id` for an element in the current page), `link=self` (link to the full-size image itself), `title` (tooltip), `role`.
- The `imagesdir` attribute is ignored by Antora. Unless the target is a URI, Antora rewrites the target to the image output location. Formats: PNG, JPG, SVG, GIF (static and animated).
- The `image$` family coordinate is not needed in image macros; it is applied automatically. Link to an image instead of rendering it with `xref:image$my-image.png[]`.

### Attachments

- Downloadable files in an `attachments` directory, referenced with the xref macro (never inserted into a page).
- The `attachment$` family coordinate is always required; no fragment may be appended; with no link text the computed URL is displayed.
- The file coordinate is always relative to the root of the `attachments` family directory.
- An attachment can also be included with `include::` if it is a text file.
- Large binaries are better hosted outside the repository (object storage or Git LFS).

## AsciiDoc Essentials (Antora-flavored)

Antora uses Asciidoctor.js. Antora supports only **Atx-style** headings (a single line beginning with one or more `=`); Setext-style and Markdown-style headings are not recognized.

| Construct | Syntax |
| --- | --- |
| Document title + header attributes | `= Title` then `:name: value` lines, blank line, then body |
| Section headings | `== Level 1` … `====== Level 5` (level 1 → `<h2>`) |
| Block ID | `[#id]` on the line above a heading or block |
| Bold / italic / monospace / highlight | `*bold*`, `_italic_`, `` `mono` ``, `#highlight#` (double the mark for use inside a word) |
| Subscript / superscript | `H~2~O`, `E=mc^2^` |
| Ordered list | `. item`, nesting `..`, `...`; style `[lowergreek]`; start `[start=4]` |
| Unordered list | `* item`, nesting `**`, `***` … |
| Description list | `Term:: description` |
| Checklist | `* [ ]` / `* [x]` / `* [*]`; clickable with `[%interactive]` |
| List continuation | `+` on its own line to attach a paragraph or block to a list item |
| Admonition | `NOTE:`, `TIP:`, `IMPORTANT:`, `CAUTION:`, `WARNING:`; complex form `[IMPORTANT]` + `====` block |
| Example / sidebar / open block | `====`, `****`, `--` delimited |
| Listing / literal block | `----`, `....` delimited |
| Source block | `[source,lang]` or shorthand `[,lang]` |
| Comment | `//` line comment; `////` block comment |
| External link | Raw URL is auto-linked; add link text with `{attr}[text]` or `URL[text]`; escape with `\https://…` |
| In-page xref | `<<id>>` or `<<id,link text>>` |
| UI macros | `btn:[Save]`, `kbd:[Ctrl+T]`, `menu:File[Save]` |
| Video embed | `video::rPQoq7ThGAU[youtube]` (also `vimeo`) |

Notable details:

- Formatting nesting order: monospace is always outermost, italic always innermost (`` `*_text_*` ``).
- A block with a valid language in the second attribute position implicitly becomes a source block. Setting `source-language` in the document header promotes delimited listing blocks (not literal blocks); `[listing]` prevents that promotion.
- When `source` is given without a language, Antora applies `none`: styled as a source block with no highlighting.
- The reference UI ships highlight.js; `source-highlighter` may only be `highlight.js` (or unset to disable highlighting). Setting `rouge`, `pygments`, or `coderay` makes Antora fail. Disable with `asciidoc.attributes: { source-highlighter: ~ }`.
- Add the `wrap` role (`[.wrap,console]`) for soft-wrapped long lines; by default long lines scroll horizontally.
- Curved quotes: ``'`text`'`` and `"`text`"`; possessive plurals need `` students`' ``; escape with `\'`.
- Built-in replacements include `(C)` → ©, `(R)` → ®, `(TM)` → ™, `...` → …, `--` → em dash, `->`, `<-`, `=>`, `<=`.
- `pass:macros[…]` keeps URL-looking text from being reformatted; the `experimental` attribute must be set for the reference UI to style UI macros.

## Playbook

A playbook is a configuration file written in YAML, JSON, or TOML that tells Antora what content to use, how to process it, and where to publish. Conventional names: `antora-playbook.yml` (and context variants such as `local-antora-playbook.yml`). A playbook is normally kept in its own **playbook project** — a configuration-as-code repository that holds the playbook, and optionally supplemental UI files and extension code, but no content.

Values are resolved in the order: **CLI option > environment variable > playbook key**. A boolean option enabled in the playbook cannot be switched off from the command line.

Minimal playbook:

```yaml
site:
  title: My Demo Site
  url: https://docs.demo.com
  start_page: component-b::index.adoc
content:
  sources:
  - url: https://gitlab.com/antora/demo/demo-component-a.git
  - url: https://gitlab.com/antora/demo/demo-component-b.git
    branches: [v2.0, v1.0]
    start_path: docs
ui:
  bundle:
    url: https://gitlab.com/antora/antora-ui-default/-/jobs/artifacts/HEAD/raw/build/ui-bundle.zip?job=bundle-stable
    snapshot: true
```

Path resolution: relative paths resolve against the current working directory by default. When a path starts with `./`, it resolves relative to the directory containing the playbook file (portable across environments).

Category keys: `site`, `content`, `ui`, `output`, `urls`, `runtime`, `git`, `network`, `asciidoc`, `antora`.

### `site`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `site.title` | string | — (required) | Site title, displayed wherever the UI calls it |
| `site.url` | string | not stated | Absolute URL (`https://docs.example.com`, may include a subpath) or root-relative path (`/products`, `/`). No trailing slash unless the value is exactly `/` |
| `site.start_page` | resource ID | not stated | Must include component, module, and file coordinates; version optional (defaults to latest). Redirects the site root to this page |
| `site.robots` | enum or string | not stated | `allow`, `disallow`, or a custom multi-line string written verbatim as `robots.txt`. Ignored unless `site.url` is set |
| `site.keys` | map | not stated | Name/value pairs exposed to UI templates as `site.keys.*` (names camelCased). Documented built-in: `google_analytics` |

Setting `site.url` enables: the `site-url` AsciiDoc attribute, `site.url` and `site.path` in the UI model, 404 page generation, `robots.txt` (if `site.robots` is set), and site-path-aware redirects. An **absolute** URL additionally enables sitemap generation and `page.canonicalUrl`.

The canonical URL points at the newest non-prerelease version of the page; if the page is absent from the latest version, it may point into an older version — claim the page in the latest version with a page alias if that matters.

### `content` (content sources)

| Key | Scope | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `content.sources` | `content` | list of maps | — (required) | At least one entry with a `url` |
| `content.sources[].url` | source | string | — (required) | Remote URI (git-supported) or local filesystem path |
| `branches` | `content`, source | string or list | `[HEAD, v{0..9}*]` | Branch names and/or patterns; source overrides `content`; disable with `~` or `[]` |
| `tags` | `content`, source | string or list | no built-in filter | Does **not** disable the branches filter — set `branches: ~` explicitly |
| `commits` | `content`, source | string or list | not stated | Commit hashes; raise `git.fetch_depth` when using them |
| `worktrees` | `content`, source | boolean or list | `.` (current worktree) | Branches only; makes worktrees selectable. `true` = all, `false`/`~` = none, `/.` = main worktree, `*` = linked worktrees only |
| `start_path` | source | string | repo root | Repo-relative path to the content source root; no leading/trailing slash |
| `start_paths` | source | string or list | not stated | Multiple content source roots; **wins over `start_path` when both are present** |
| `edit_url` | `content`, source | string | built-in default | URL pattern for the page edit link; placeholders `{web_url}`, `{refname}`, `{refhash}`, `{path}` |
| `version` | source | string / `true` / map | not stated | Fallback only — a `version` in `antora.yml` takes precedence |

Behavior notes:

- A `url` is treated as remote if it contains `://` or a colon not followed by `/` or `\`; otherwise it is a local path. Local content sources are never fetched — Antora reads the worktree when the current branch matches the `branches` filter (`HEAD` selects the checked-out branch and is the basis of author mode). A local repo may have no commits.
- `worktrees` does not select content; it only makes worktrees available to the `branches` filter. A worktree is used when its current branch matches a selected branch. Point at the `.git` directory to hide the worktree, or set `worktrees: false` to force reading from the git tree.
- `start_paths` searches are per git reference, so the descriptor must exist at each start path in each selected reference. Globs match directories only (a single level, no `**`), brace expressions need at least two entries, and negated globs (`!…`) must follow inclusions.
- `version: true` uses the matched refname (short form; `/` → `-`). A refname projection is a map of glob patterns to replacements, using the same matching capabilities as branch patterns, with groups referenced by `$<name>`, `$1`, or `$&`.
- Pull/merge-request branches are stored as packed refs on managed remotes and are not discovered; clone and check them out locally to use them.

Refname matching (used by `branches`, `tags`, `commits`, and `start_paths` patterns):

| Form | Example |
| --- | --- |
| Exact shortname | `main`, `v1.0.x` |
| Wildcard | `v*`, `v*.*.x` |
| Exclusion | `['v*.*.x', '!v1.0.x']` (quote in YAML) |
| Alternation | `{this,that}`, `v{5,6}.*.x` |
| Range / step | `v{1..9}.{0..9}.x`, `v{2..8..2}.*.x` |
| Repetition (extglob) | `v@({1..9})*({0..9}).+({0..9}).x` |

Value types: a string is split on commas (use that only for exact matching); prefer array syntax for patterns. Quote values starting with `!`, `*`, or a number.

### `ui`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `ui.bundle` | map | — (required) | UI bundle location and state |
| `ui.bundle.url` | string | — (required) | URL to a ZIP, or a path to a ZIP or extracted directory |
| `ui.bundle.snapshot` | boolean | `false` | Re-download the bundle whenever `runtime.fetch` is enabled |
| `ui.bundle.start_path` | string | not stated | Directory inside the bundle to use as the UI root (multi-UI bundles) |
| `ui.default_layout` | string | `default` | Layout (file stem, no extension) for pages without `page-layout` |
| `ui.output_dir` | string | `_` | Where UI files are published, relative to the site root |
| `ui.supplemental_files` | string or list | not stated | Overlay a directory, or a list of virtual files `{ path, contents }` |

The only required UI files are the default layout (e.g. `layouts/default.hbs`) and, if the 404 page is used, `layouts/404.hbs`. Supplemental files overlay the bundle: a matching path replaces a bundle file, a new path adds one. A virtual file with `contents` ending in a file extension (e.g. `.hbs`) is read from that path; omitting `contents` creates an empty file. Files listed under `static_files` in the UI descriptor (`ui.yml`) are published to the site root instead of the UI output directory. A supplemental `ui.yml` replaces the bundle's, so replicate its contents.

### `output`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `output.clean` | boolean | `false` | Recursively remove the output directory before generating (fs provider only) |
| `output.dir` | string | `./build/site` | Path of the primary `fs` destination |
| `output.destinations[]` | list | implicit `fs` destination | Each entry needs a `provider`; `[]` disables publishing |
| `…destinations[].provider` | string | not stated | `fs`, `archive`, or a custom provider module/path |
| `…destinations[].path` | string | `fs`: `./build/site`; `archive`: `./build/site.zip`; custom: `_site` | Target directory or ZIP file |
| `…destinations[].clean` | boolean | inherits `output.clean` | Per-destination clean (fs only) |

When `output` is omitted, Antora uses the `fs` provider and publishes to `./build/site`. Use `destinations` to publish an archive, to several locations, or with a custom provider. A custom provider is a Node.js module exporting `async function (destConfig, files, playbook)` where `files` is an async-iterable stream of Vinyl objects.

### `urls`

| Key | Type | Default | Allowed values |
| --- | --- | --- | --- |
| `urls.html_extension_style` | enum | `default` | `default` (`.html`), `drop` (no extension), `indexify` (trailing `/`) |
| `urls.redirect_facility` | enum | `static` | `disabled`, `gitlab`, `httpd`, `netlify`, `nginx`, `static` |
| `urls.latest_version_segment` | string | not stated | Symbolic version for the latest version of each component |
| `urls.latest_prerelease_version_segment` | string | not stated | Symbolic version for the latest prerelease of each component |
| `urls.latest_version_segment_strategy` | enum | `replace` (assigned at runtime when a segment key is set) | `replace`, `redirect:to`, `redirect:from` |

- `indexify` and `drop` also drop the last URL segment when the source page is `index.adoc`. `drop` requires web server support (nginx: `try_files $uri $uri.html $uri/index.html = 404;`).
- Redirect facility output: `static` writes an HTML meta-refresh page at each aliased URL; `netlify` and `gitlab` write `_redirects`; `httpd` writes `.htaccess`; `nginx` writes `.etc/nginx/rewrite.conf`; `disabled` writes nothing. Start pages and page aliases use 301, latest-version aliases use 302. Redirect rule paths follow `html_extension_style`.
- Symbolic segments only ever apply to the latest version (or latest prerelease) of a component, never to a versionless one. Values follow the `version` character rules and cannot be `null`; an empty string is allowed only with `replace` or `redirect:to`, never with `redirect:from`.
- `redirect:to` redirects the actual-version URL to the symbolic URL; `redirect:from` redirects the symbolic URL to the actual-version URL. With the `static` facility, `redirect:from` is ignored and `redirect:to` degrades to `replace`.
- A component version counts as a prerelease only if the component also has at least one non-prerelease version; when all versions are prereleases, `latest_version_segment` applies instead of the prerelease one.

### `runtime`

| Key | Default | Allowed values / notes |
| --- | --- | --- |
| `runtime.cache_dir` | OS-specific (see Cache below) | Where git repos and UI bundles are cached |
| `runtime.fetch` | not stated | `true` fetches all cloned remote repos and re-downloads snapshot UI bundles each run |
| `runtime.quiet` | `false` | Suppress messages written directly to stdout (not stderr or the log) |
| `runtime.silent` | `false` | Forces log level `silent`; suppresses stdout and stderr |
| `runtime.log.level` | `warn` | `all`, `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `runtime.log.failure_level` | `fatal` | `fatal`, `error`, `warn`, `none` — at or above this level the process exits non-zero (code 2) |
| `runtime.log.format` | `pretty` when the terminal is interactive (or `CI=true`), else `json` | `pretty` (stderr, colorized), `json` (stdout, JSON Lines) |
| `runtime.log.level_format` | `label` | `label`, `number`; only for `format: json` |
| `runtime.log.destination.file` | `stderr` for `pretty`, `stdout` for `json` | File path, `stdout`/`1`, `stderr`/`2` |
| `runtime.log.destination.append` | `true` | `false` truncates the file first |
| `runtime.log.destination.buffer_size` | `0` | `0` = unbuffered; larger values batch writes |
| `runtime.log.destination.sync` | `true` | `false` writes asynchronously |

The docs are inconsistent about the `runtime.log.format` default: `configure-runtime` and `environment-variables` say `pretty` when `CI=true` or the terminal is interactive, while `runtime-log-format` states the inverse wording. Treat the playbook as the source of truth when it matters. `NO_COLOR` disables color; `FORCE_COLOR` forces it. Fatal errors raised before the playbook is built are printed to stderr and do not honor log settings.

### `git`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `git.fetch_concurrency` | integer | `1` | Limit concurrent fetch/clone operations; `0` = unlimited. Use `1` on GitHub to avoid ECONNRESET from paused connections |
| `git.fetch_depth` | integer | `1` | Commits to fetch; `0` = full history. Raise it when pinning content sources to commits |
| `git.ensure_git_suffix` | boolean | `true` | Appends `.git` to remote URLs; disable for TFS/Azure DevOps |
| `git.read_concurrency` | integer | `0` (unlimited) | Limits concurrent reads after fetching; 2–5 is a sensible range |
| `git.credentials.path` | path | `$HOME/.git-credentials`, or `$XDG_CONFIG_HOME/git/credentials` | Mutually exclusive with `contents` |
| `git.credentials.contents` | string | not set | Inline credential-store data: `https://$TOKEN:@github.com` |
| `git.plugins.credential_manager` | require request | not stated | Custom credential manager |
| `git.plugins.http` | require request | not stated | Custom HTTP request handler |

The `configure-git` sample uses non-default values (`fetch_concurrency: 3`, `fetch_depth: 0`, `ensure_git_suffix: false`, `read_concurrency: 5`) while its key table lists the defaults above — the table is authoritative. Antora does not expand environment variables inside the playbook; generate the playbook or use `GIT_CREDENTIALS` (comma-separated credentials) / `GIT_CREDENTIALS_PATH` instead.

### `network`

| Key | Notes |
| --- | --- |
| `network.http_proxy` | Proxy URL for HTTP requests (protocol + domain + port), e.g. `http://localhost:3128` |
| `network.https_proxy` | Proxy URL for HTTPS requests |
| `network.no_proxy` | Comma-separated domains/subdomains that bypass the proxy; `*` bypasses entirely |

Antora 3 honors the `http_proxy`, `https_proxy`, and `no_proxy` environment variables automatically even when these keys are unset (a change from Antora 2). Precedence: CLI option > environment variable > playbook key. The proxy protocol need not match the request protocol, and per-URL proxies cannot be configured — only exclusions.

### `asciidoc`

```yaml
asciidoc:
  sourcemap: true
  attributes:
    table-caption: ~
    page-team: Coco B@
  extensions:
  - ./lib/custom-block.js
  - asciidoctor-kroki
```

- `asciidoc.attributes` declares **site attributes**, available to every page in the run. The same modifier semantics apply as in `antora.yml` (`value` hard set, `value@` soft set, `'@'` soft set to the default, `~` hard unset, `false` soft unset), and hard set/unset in the playbook beats the component descriptor and the page header. Values may reference earlier attributes with `{name}`; escape with `\{name}`. Attribute values are strings (`true` becomes `'true'`).
- `asciidoc.extensions` registers **Asciidoctor** extensions (a different facility from `antora.extensions`). Entries are module names or paths. A Node module whose name ends with a file extension (e.g. `highlight.js`) needs a trailing slash so it is resolved as a module, not a local file. Extensions may register globally (once, before any conversion, including navigation files) or scoped per processor instance; scoped registration requires exporting `register(registry, context)`.
- `asciidoc.sourcemap` (default `false`) attaches file and line-number information about AsciiDoc blocks to the logger and to extensions, at some cost in build time. Enable it when you need line-accurate diagnostics such as unresolved xrefs. The CLI flag `--asciidoc-sourcemap` can only activate it.
- Asciidoctor extensions can also be preloaded with the CLI option `-r`/`--require`, which runs before Antora itself is loaded and therefore only works for extensions that self-register.

### `antora`

```yaml
antora:
  extensions:
  - ./lib/audit-pages-extension.js
  - require: '@antora/lunr-extension'
    index_by_heading: true
```

`antora.extensions` registers **Antora** extensions (see Extensions). Entries are module names/paths or maps with a `require` key plus extension configuration.

### Environment variables

| Variable | Playbook key | Values |
| --- | --- | --- |
| `ANTORA_CACHE_DIR` | `runtime.cache_dir` | Path |
| `ANTORA_LOG_LEVEL` | `runtime.log.level` | `all`…`silent` |
| `ANTORA_LOG_FAILURE_LEVEL` | `runtime.log.failure_level` | `fatal`, `error`, `warn`, `none` |
| `ANTORA_LOG_FORMAT` | `runtime.log.format` | `pretty`, `json` |
| `ANTORA_LOG_LEVEL_FORMAT` | `runtime.log.level_format` | `label`, `number` |
| `ANTORA_LOG_FILE` | `runtime.log.destination.file` | Path, `stdout`, `stderr` |
| `GIT_CREDENTIALS` | `git.credentials.contents` | Comma-separated credentials |
| `GIT_CREDENTIALS_PATH` | `git.credentials.path` | Path |
| `GOOGLE_ANALYTICS_KEY` | `site.keys.google_analytics` | Key |
| `URL` | `site.url` | Site URL |
| `http_proxy`, `https_proxy`, `no_proxy` | `network.*` | Proxy configuration |

Additional behavior switches: `CI` (changes the default log format, suppresses stdout, affects the edit-page link), `IS_TTY` (forces the log-format default), `NO_COLOR`, `FORCE_COLOR`, `FORCE_SHOW_EDIT_PAGE_LINK`, and `NODE_OPTIONS` (e.g. `--max-old-space-size=4096` for large sites). Unset a variable for one run with `env -u URL antora antora-playbook.yml`.

## CLI

```text
Usage: antora [options] [[command] [args]]

Commands:
  generate [options] <playbook>  Generate a documentation site specified in <playbook>.
```

- `generate` is implied when no command is given; `antora <playbook>` equals `antora generate <playbook>`. `help` and `version` are meta commands.
- The playbook path is relative to the working directory (or absolute). The extension is optional — Antora searches YAML, then JSON, then TOML. There is no default playbook filename discovery.
- Options may be written `--option value` or `--option=value`. A value containing spaces must be quoted. A bare `--option` is a boolean.
- Repeatable options (`--key`, `--attribute`, `--extension`, `--require`) need the flag before each value.
- `name=value` options take everything after `=` literally; without `=` the value is the empty string. CLI values are strings — prefix a YAML type tag to coerce, e.g. `--attribute 'feed-limit=!!int 50'` (tags: `!!auto`, `!!str`, `!!bool`, `!!int`, `!!float`, `!!seq`, `!!map`, `!!null`).

| Option | Default | Notes |
| --- | --- | --- |
| `-v`, `--version` | — | CLI and default site generator versions |
| `-h`, `--help` | — | Usage; also `antora help`, `antora help generate` |
| `-r`, `--require <library>` | not set | Require a module/script before running; repeatable |
| `--stacktrace` | `false` | Print a stacktrace on failure |
| `--playbook` | — | Not documented as an option: the playbook is the positional argument of `generate` |
| `--fetch` | `false` | Fetch updates from remotes |
| `--clean` | `false` | Erase output folders before generating — use with care |
| `--to-dir <path>` | `./build/site` | Output directory |
| `--generator <lib>` | `@antora/site-generator` | Substitute the site generator |
| `--extension <id\|path>` | not set | Register an Antora extension; `!id` disables one; repeatable |
| `--attribute <name[=value]>` | not set | Set an AsciiDoc attribute; repeatable |
| `--key <name=value>` | not set | Set a site key; repeatable |
| `--title <title>`, `--url <url>`, `--start-page <id>` | not set | Override `site.title`, `site.url`, `site.start_page` |
| `--ui-bundle-url <url\|path>` | not set | UI bundle location |
| `--cache-dir <path>` | OS default | Cache directory |
| `--git-credentials-path <path>` | not set | Credentials file |
| `--html-url-extension-style <style>` | `default` | `default`, `drop`, `indexify` |
| `--redirect-facility <facility>` | `static` | `disabled`, `gitlab`, `httpd`, `netlify`, `nginx`, `static` |
| `--asciidoc-sourcemap` | `false` | Enable the AsciiDoc sourcemap |
| `--quiet` / `--silent` | `false` | Suppress stdout / suppress everything |
| `--log-level <level>` | `warn` | `fatal`…`all`, `silent` |
| `--log-failure-level <level>` | `fatal` | `fatal`, `error`, `warn`, `none` |
| `--log-format <format>` | see `runtime.log.format` | `pretty`, `json` |
| `--log-level-format <format>` | `label` | `label`, `number` |
| `--log-file <path\|stream>` | see `runtime.log.destination.file` | Destination |
| `--http-proxy`, `--https-proxy`, `--noproxy <list>` | not set | Proxy configuration |

## Build, Preview, and Publish

### Install and run

- Requirements: Node.js ≥ 20 (the version shipped by Debian stable; the Active LTS is recommended). Supported platforms include Alpine ≥ 3.20, Debian LTS, Fedora ≥ 42, Ubuntu 24.04/26.04 LTS, macOS 14–26, Windows 11 and Server 2022/2025, and the latest stable Chrome/Firefox/Edge. Memory: roughly 3 GB of headroom is usually enough; raise Node's heap with `NODE_OPTIONS='--max-old-space-size=4096'` for large sites.

```bash
# recommended: local install in the playbook project
npm i -D -E antora
npx antora -v

# alternative: global install
npm i -g antora

# try without installing (evaluation only)
npx antora -v
```

A local install is not on `PATH`, so run it through `npx`. `-D -E` pins the exact version as a dev dependency. A versioned install looks like `npm i -D -E antora@3.2`. Upgrading a local install means editing the version in `package.json` and running `npm i`; globally, `npm i -g antora@3.2`.

### Quickstart

1. Verify Node.js: `node -v`.
2. Create and enter a site directory: `mkdir docs-site`, then `cd` into it.
3. Initialize a package file: `node -e "fs.writeFileSync('package.json', '{}')"`.
4. Install Antora locally: `npm i -D -E antora`.
5. Verify: `npx antora -v` (the CLI and site generator versions should match).
6. Create `antora-playbook.yml` (see the minimal example above).
7. Generate: `npx antora antora-playbook.yml`; add `--fetch` while starting out, or set `runtime.fetch: true`.
8. Preview: open `build/site/index.html`.

A local-content variant adds `git init` plus an empty commit, then a `modules/ROOT/pages` tree, an `antora.yml`, and a playbook whose only content source is `- url: .` with `branches: HEAD`. Local and remote content sources can be mixed.

### Preview the site

- An Antora site works over the `file:` protocol — open any HTML file in the output directory.
- Use a local server when URLs are indexified, scripts need HTTP, or caching interferes: `npx http-server build/site -c-1` (add `-p 5000` if the port is in use).
- Repositories are cloned on the first run; subsequent runs reuse the cache and only fetch when `--fetch` (or `runtime.fetch`) is enabled.
- Errors print `error: …`; add `--stacktrace` for detail.

### URL construction

```text
<site pathname> / <component> / <version> / <module> / <family-relative path>
```

- Images and attachments insert a family segment (`_images`, `_attachments`) after the module segment. Pages never do.
- Omissions: the component segment is dropped for a `ROOT` component; the version segment is dropped for a versionless component version; the module segment is dropped for the `ROOT` module; the `.adoc` extension is replaced according to `html_extension_style`. Non-page resources keep their original extension.
- The site pathname comes from `site.url` (a subpath of an absolute URL, or the whole root-relative value) and prefixes the domain-relative URL.
- Antora computes three URL variants: relativized URLs (for xrefs, images, navigation, breadcrumbs, pagination, and UI resources), domain-relative URLs (for alias/start-page rewrite rules and `redirect:to`/`replace`), and absolute URLs (for sitemaps and the canonical tag, requiring an absolute `site.url`).

### Version sorting and "latest"

- Only the `version` value is sorted. Schemes: **versionless** (`~`/`null`), **named** (anything not semantic), **semantic** (an integer, or a string starting with a number and containing a dot, optionally with a leading `v`).
- Order: versionless before named before semantic. Named versions sort in reverse alphabetical order; semantic versions sort in descending order using semver rules, ignoring a leading `v`.
- The latest version is the first version in sorted order that is not a prerelease; if every version is a prerelease, it is the first prerelease. A versionless component version is always the latest.
- Components are ordered alphabetically by `title` (falling back to `name`) in the UI; the content catalog order itself is not deterministic.

### 404 page and sitemap

- The 404 page is generated only when `site.url` is set **and** the UI provides a layout named `404` (`layouts/404.hbs`); it is written to `404.html` at the site root and rendered with a reduced UI model (only `page.title` and `page.layout`, with root-relative `uiRootPath` and `siteRootPath`).
- Sitemaps are generated only when `site.url` is an **absolute** URL: `sitemap.xml` is an index listing `sitemap-<component>.xml` files, each with a `<url>` entry per published page. `<loc>` is the absolute page URL; `<lastmod>` is the generation date.

### Publishing

GitHub Pages:

- GitHub Pages runs files through Jekyll unless an empty `.nojekyll` file is present at the site root — without it, everything under `_` (including the UI directory and `_images`) is deleted. Add it with `touch build/site/.nojekyll`, a CI step, or a supplemental UI virtual file promoted via `static_files`.
- With GitHub Actions the workflow builds and deploys directly (no `gh-pages` branch), using `actions/configure-pages`, `actions/upload-pages-artifact` with `path: build/site`, and `actions/deploy-pages`.

```yaml
name: Publish to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
concurrency:
  group: github-pages
  cancel-in-progress: false
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
    - name: Checkout repository
      uses: actions/checkout@v5
    - name: Configure Pages
      uses: actions/configure-pages@v5
    - name: Install Node.js
      uses: actions/setup-node@v5
      with:
        node-version: '20'
    - name: Install Antora
      run: npm i antora
    - name: Generate Site
      run: npx antora antora-playbook.yml
    - name: Upload Artifacts
      uses: actions/upload-pages-artifact@v4
      with:
        path: build/site
    - name: Deploy to GitHub Pages
      id: deployment
      uses: actions/deploy-pages@v4
```

GitLab Pages (CI needs to be configured only in the playbook repository's default branch):

```yaml
image:
  name: antora/antora
pages:
  stage: deploy
  interruptible: true
  script:
  - antora --fetch --redirect-facility gitlab --to-dir public antora-playbook.yml
  artifacts:
    paths:
    - public
```

- `public` is GitLab Pages' predefined publish folder and must match `--to-dir`. `--redirect-facility gitlab` produces GitLab-format `_redirects` rules.
- De-select *Use unique domain* in Deploy → Pages, otherwise GitLab adds a unique number to the URL.
- The `antora/antora` Docker image contains only Antora core; declare extensions (e.g. `@antora/lunr-extension`, `asciidoctor-kroki`) in the playbook project's `package.json` and run `npm ci` in CI.
- For private content repositories, define a `GIT_CREDENTIALS` CI/CD variable (deploy tokens give read-only access). Add `--log-failure-level warn` to fail the pipeline on warnings.

### Containers and cache

- The official image is `antora/antora` (command form: `docker run -u $(id -u) -v $PWD:/antora:Z --rm -t antora/antora antora-playbook.yml`). `-t` provides the TTY git progress bars need; `:Z` is only needed on SELinux systems; `--privileged` is not required.
- If the local uid is not 1000, container runs fail with `EACCES: permission denied, mkdir '/.cache'` because the cache resolves under an unmapped home directory. Fix by setting `--cache-dir ./.cache/antora` or `-e HOME=/antora` so the cache lives inside the mounted directory.
- The cache holds cloned git repositories (`content/`) and downloaded UI bundles (`ui/`). Default locations: Linux `$XDG_CACHE_HOME/antora` or `$HOME/.cache/antora`; macOS `$HOME/Library/Caches/antora`; Windows `$APPDATA/antora/Caches`. Precedence: `--cache-dir` > `ANTORA_CACHE_DIR` > `runtime.cache_dir`. Clear it by deleting the directory; refresh it with `--fetch`.

### Symlinks in content sources

- Symlinks are supported and translated transparently between the filesystem and git. On Windows, creating them needs elevated privileges or Developer Mode.
- Antora materializes a symlinked file as a regular file, and a symlinked directory as that directory's files at the link's path.
- The target must exist and must be expressed as a **relative** path. A symlink cannot point to itself, and a symlink committed to git cannot point outside the repository or into another git reference. Map only what you need — every mapped file costs build time.

## Extensions

An Antora extension is a JavaScript module that hooks into the generator pipeline by listening to events.

```js
'use strict'

module.exports.register = function ({ playbook, config }) {
  this.on('contentClassified', ({ contentCatalog }) => {
    // work with the catalog
  })
}
```

- The exported `register` function is called as soon as the generator starts, after the playbook is built. If `register` is bindable (`function` form), the generator context is bound to `this`; if it declares a first parameter, that parameter receives the generator context instead. Arrow functions cannot use `this` for the context.
- Class-based form: export a class with a static `register` method that instantiates the class with the generator context, and register listeners as bound instance methods in the constructor.
- Listeners are registered with `on(event, listener)` (chainable, and mirrors Node's `EventEmitter` API). Built-in events fire once, so `once` may be used. Listeners run synchronously in registration order even when async, and their return values are ignored. `prependListener` adds a listener ahead of existing ones.
- Documented events: `playbookBuilt` (first), `contentAggregated`, `contentClassified`, `beforePublish`, `sitePublished` (last), `contextStopped`, `contextClosed`. Extensions can also emit and listen for custom events.
- Context variables flow through the generator: the first positional parameter of a listener is an object of context variables (`playbook`, `siteCatalog`, `contentCatalog`, …). The playbook is a **frozen** object. Once a built-in variable is established it becomes **locked** and can no longer be replaced (its contents may still be mutated, except for the playbook).
- `register` also receives the extension's `config` object (empty `{}` when nothing is configured). Nested configuration keys are converted from snake_case to camelCase automatically; keys under `data` bypass that conversion.

Context helpers:

| Helper | Purpose |
| --- | --- |
| `getVariables()` | Read the current context variables |
| `updateVariables(object)` | Add or replace context variables (use `undefined` to remove); cannot replace locked variables |
| `stop(exitCode)` | Orderly shutdown; emits `contextStopped` and `contextClosed`. Calling it before `sitePublished` prevents publishing |
| `getLogger(name)` | Obtain a named logger |
| `require(request)` | Require a module in the context of the Antora installation |

Registration and control from the playbook and CLI:

```yaml
antora:
  extensions:
  - require: ./my-extension.js
    enabled: false
    id: my-extension
    custom: value
```

- Playbook entries register in listed order, before any extension enabled via `--extension`. Referencing a playbook extension on the CLI (`--extension my-extension`, by `id` or `require` value) moves it into CLI position while keeping its playbook configuration; set `order: fixed` to retain playbook order.
- `enabled: false` registers an extension (with its configuration) without enabling it. `--extension '!my-extension'` disables a registered extension by rewriting its `enabled` key.
- Install extension code as a project dependency, a global module, or a script in the playbook project. Antora does not download npm packages for you.
- Asciidoctor extensions are registered separately under `asciidoc.extensions`.

Replaceable/relevant components (all MPL-2.0, versioned together as core except where noted): `@antora/asciidoc-loader`, `@antora/cli`, `@antora/content-aggregator`, `@antora/content-classifier`, `@antora/document-converter`, `@antora/logger`, `@antora/navigation-builder`, `@antora/page-composer`, `@antora/playbook-builder`, `@antora/redirect-producer`, `@antora/site-generator`, `@antora/site-mapper`, `@antora/file-publisher`, `@antora/ui-loader`; extended: `@antora/lunr-extension`.

## Best Practices (as documented)

1. Use lowercase names everywhere you control them — component names, module directories, filenames, refnames. Case-insensitive filesystems and web servers make mixed case a portability hazard, and refnames should avoid characters requiring URL encoding (`#` breaks edit links).
2. Version documentation by branch, and keep documentation tags distinct from software release tags (e.g. `docs/2.0.1` after `release/2.0.1`). Branch-based versioning keeps git's compare/merge tooling; tag-based versioning freezes content; folder-based versioning starts as a full copy and loses git history benefits.
3. Prefer `partials` for AsciiDoc fragments and `examples` for code, and store both with their proper file extensions so extensions and future capabilities keep working. Use tagged regions to include only the relevant part of a file.
4. Qualify references inside partials to the broadest context where they are used (fragment, then page, then module coordinates).
5. Set `start_page` explicitly when a component version has no `index.adoc` in `ROOT`, or visitors clicking that version get a 404.
6. Set `title` in `antora.yml` (especially for a `ROOT` component) rather than relying on `name`, and keep it uniform across versions of a component.
7. Keep optional descriptor keys in exactly one `antora.yml` when a component version is distributed across repositories — the others must declare only `name` and `version`.
8. Use page aliases for renames and moves (they keep xrefs working), but route bulk URL changes through the web server or an extension.
9. Set `git.fetch_concurrency: 1` when content repositories are on GitHub, and raise `git.fetch_depth` if you pin content sources to commits.
10. Keep the CLI and site generator versions in sync, and prefer a local (project) install so the version travels with the project.
11. Use a real HTTP server to preview when using `indexify`/`drop` URL styles or when redirects and the 404 page must be exercised.
12. Enable `asciidoc.sourcemap` when you need line-accurate diagnostics, accepting the extra build cost.

## Common Pitfalls

| Symptom | Cause and fix |
| --- | --- |
| `Duplicate page` / `Duplicate nav file` and the build stops | Two resources claim one resource ID — usually a redundant content source root or two descriptor files declaring the same `name` and `version`. Remove the overlapping file/repository or change one `version`. |
| A page is missing from the site | The filename begins with a dot, or a publishable resource has no file extension. Rename it; extensionless files are allowed only in `examples` and `partials`. |
| A page exists but is not published | The filename or containing directory begins with `_` (private), or a `private` property was set. Rename it, or set `private: false`. |
| Links land on the wrong version | Neither version nor component was given in the xref, so Antora assumed the current page's component version. Specify the component to get latest-version resolution. |
| An xref to a page with a fragment shows a URL instead of link text | Link text is not auto-populated when a fragment is present — specify it explicitly. |
| `target of xref not found` | The resource ID is missing a required coordinate (module, component, family) or a version coordinate was assumed. Enable `asciidoc.sourcemap` for line numbers. |
| A page-level override of a site attribute has no effect | The site value was hard set (no trailing `@`). Soft set it with `value@`, or use `'@'` to soft set the default. |
| An image or attachment link fails | The `attachment$`/`image$` family coordinate is missing where required, or a fragment was appended (which is not allowed for those families). |
| Nothing appears in the page menu | The nav file is not registered under `nav` in `antora.yml`, or it was placed inside `pages` (where it becomes a page). |
| An included nav list breaks the hierarchy | Wrap the include in an open block attached with `+` so the included list nests under the item. |
| `ECONNRESET` while cloning | Concurrent fetches on GitHub get reset. Leave `git.fetch_concurrency` at `1`. |
| `EACCES: permission denied, mkdir '/.cache'` in a container | The container's HOME resolves to `/`. Set `--cache-dir` or `HOME` to a path inside the mounted volume. |
| `RangeError [ERR_FS_FILE_TOO_LARGE]` / `Cannot read properties of null (reading 'slice')` | A pack file exceeds 2 GiB (isomorphic-git + Node limit). Lower `pack.packSizeLimit` and run `git gc` on the clone and server. |
| Pages vanish on GitHub Pages | Jekyll removed everything under `_`. Add an empty `.nojekyll` at the site root. |
| GitLab Pages URL changes unexpectedly | GitLab enabled *Use unique domain*. De-select it in Deploy → Pages. |
| A `ROOT` component's pages collide with a named component's pages | Both resolve to the same site-root paths because the `ROOT` component segment is dropped. Rename one component. |
| Symbolic latest-version URLs are not redirected | `redirect:from` is ignored with the `static` facility, and `redirect:to` degrades to `replace`. Use a server-side redirect facility. |
| Prerelease never becomes the latest | That is intended: prereleases are skipped while any non-prerelease version exists. |
| Build runs out of memory | Raise the heap with `NODE_OPTIONS='--max-old-space-size=4096'`; large sites also pay a heap cost for the globally soft-set `page-partial`. |

## Version Notes

- The `latest` documentation set documents **Antora 3.2**, built from the `main` branch; `3.1` is available alongside it at `/antora/3.1/`.
- The site generator package is `@antora/site-generator` (renamed from `@antora/site-generator-default`), and `@antora/file-publisher` replaced `@antora/site-publisher`.
- Since Antora 2.2, the `page-partial` attribute is soft set globally by default, so pages can be included without per-page opt-in.
- Antora 3 honors `http_proxy`/`https_proxy` automatically, unlike Antora 2 — a frequent cause of unexpected `Bad response: 503` after upgrading; bypass with `no_proxy`.
- Antora ≥ 3.2.0 separates fetch and scan operations, greatly reducing GitHub `ECONNRESET` failures.
- The reference UI supports only `highlight.js` as a source highlighter; build-time highlighters (`rouge`, `pygments`, `coderay`) fail under Asciidoctor.js.
- Asciidoctor extensions may require the `asciidoc.sourcemap` key (default `false`) to run correctly.
