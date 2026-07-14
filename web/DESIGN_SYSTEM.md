# Solix Sunblock Design System

Sunblock makes Solix feel like a modular solar workshop: direct, mechanical, warm, and visibly assembled. It serves developers evaluating a compiler and documentation readers trying to connect authored JSX to exact browser work.

## Design intent

- **Domain:** sunlight, orbit, photosphere, assembly blocks, blueprints, compiler graphs, and instrument labels.
- **Signature:** rectangular blocks visibly snap into a grid or orbit. The signature appears in navigation markers, controls, cards, live-example modes, callouts, and compiler diagrams.
- **Reject:** generic gradient heroes, floating rounded SaaS cards, anonymous sans-serif typography, and decorative color without meaning.
- **Feel:** an optimistic technical field manual—bold enough to be memorable, disciplined enough for long-form documentation.

## Color tokens

| Token  | Value     | Role                                    |
| ------ | --------- | --------------------------------------- |
| Cream  | `#F4EBCB` | Canvas and workshop grid                |
| Paper  | `#FFFAF0` | Reading and inset surfaces              |
| Ink    | `#171711` | Text, borders, code surfaces            |
| Solar  | `#FFD21C` | Primary action, active state, focus     |
| Cobalt | `#2447D8` | Navigation and framework identity       |
| Tomato | `#F04A31` | Validation, warnings, high attention    |
| Mint   | `#B9E6C6` | Success, readiness, supporting callouts |
| Muted  | `#6D695A` | Secondary metadata and placeholders     |

Ink and cream provide structure. Cobalt identifies Solix and navigation. Solar is reserved for action, active state, and focus. Tomato communicates problems or exceptional attention. Mint communicates ready or successful states.

## Typography

- **Archivo Black:** display declarations, page titles, major section headings. Use uppercase with tight tracking and compact line height.
- **Familjen Grotesk:** body copy, navigation, labels, and interface text. Use 400 for reading, 600–700 for controls.
- **Chivo Mono:** source code, installation commands, metadata, sequence numbers, statuses, and instrumentation.
- Long-form docs target `17px / 1.75`; code targets `12–13px / 24px`; interface labels target `10–12px` uppercase.

Fonts are self-hosted through Fontsource so builds and visual tests do not depend on third-party font requests.

## Grid and spacing

- Base spacing unit: `4px`.
- Canvas grid: `32px × 32px` at seven-percent ink.
- Common component gaps: `8px`, `12px`, `16px`, `24px`, `32px`.
- Section separation: `64px`, `96px`, or `128px` depending on viewport.
- Content container: maximum `1440px` with `16px` mobile gutters.
- Documentation prose: maximum `52rem` to protect reading measure.

## Geometry and depth

- Square corners are the default. A full circle is reserved for sun/orbit marks.
- Standard structure uses `2px` ink borders; high-emphasis assemblies use `3px`.
- Small interactive lift: `4px 4px 0 Ink`.
- Major block lift: `8px 8px 0 Ink`.
- Shadows never blur. Offset is physical assembly depth, not atmospheric decoration.
- Cut corners may mark a primary CTA, but do not mix them into every panel.

## Components

- **Button:** primary cobalt, solar action, paper outline, or tomato danger; small, medium, and large sizes. Every button has hover, active, focus-visible, disabled, and loading behavior.
- **Badge:** compact mono instrumentation label. Tone must carry meaning.
- **Input:** cream inset field, ink boundary, solar focus ring, tomato issue text, explicit label and description relationship.
- **Panel/Card:** content-specific internal layout with one shared boundary/depth system.
- **Callout:** eyebrow, declarative title, concise body. Mint is informational/success; tomato is warning.
- **Example toggle:** three pressed buttons for Editor, Preview, and Both. It is a view control, not a tab implementation, and preserves mounted preview state.
- **Code panel:** ink surface, cream rule, mono source, line numbers, build-time syntax tokens, and a clipboard status announcement.
- **Docs sheet:** mobile-only modal layer with a real close control, backdrop control, current-page state, and the same cream canvas as the content.

Solix does not currently support general component children. Reusable primitives therefore use explicit typed props and focused leaf APIs instead of pretending standard React shadcn components are compatible.

## Content and diagrams

- Explain the transformation as authored JSX → compiler graph → static template plus precise DOM operations.
- Pair abstract claims with code or an interactive proof.
- Use numbered blocks and short instrument labels to orient, not decorate.
- Never claim virtual-DOM reconciliation; Solix setup runs once and dependencies drive exact operations.

## Interaction and motion

- Micro-interactions use `140–200ms` decelerating transitions.
- Hover may shift a block by `1–4px` or rotate it by at most one degree.
- Enter/leave demonstrations use restrained opacity and translation.
- `prefers-reduced-motion` reduces animations and transitions to effectively immediate behavior.
- Live previews remain mounted when their editor panel is hidden so user state survives mode changes.

## Accessibility

- Global skip link targets `#main`.
- Focus-visible uses a `4px` Solar outline with `4px` offset.
- Text and action combinations must meet WCAG AA contrast; white text is used only on Cobalt, Tomato, or Ink.
- Controls use native elements, visible labels, disabled semantics, `aria-pressed` for view modes, and live regions for copy/submit status.
- Navigation exposes `aria-current="page"`; mobile sheets have explicit open/close state.
- Layout must remain overflow-free at `390px` and readable at zoomed desktop widths.

## Usage examples

```tsx
<Button label="Compile block" variant="primary" size="md" />
<Badge label="Mounted" tone="mint" />
<Callout eyebrow="Compiler note" title="Setup runs once" body="Only dependencies patch." />
```

Use token utilities (`bg-solar`, `text-cobalt`, `shadow-block`) instead of introducing one-off colors or shadows. New reusable patterns belong here after they appear more than once.
