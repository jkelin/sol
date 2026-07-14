import {
  $component,
  createRef,
  GlobalPortal,
  Portal,
  type Ref,
  type RefCallback,
  type RefObject,
} from "solix";

const buttonRef = createRef<HTMLButtonElement>();
const structuralRef: RefObject<HTMLInputElement> = { current: null };
const anchorRef = createRef<HTMLAnchorElement>();
const circleRef = createRef<SVGCircleElement>();
const callbackRef: RefCallback<HTMLDivElement> = (element) => {
  const value: HTMLDivElement | null = element;
  void value;
};
const combined: Ref<HTMLDivElement> = callbackRef;
void combined;

const Valid = $component(function Valid() {
  const target = createRef<HTMLDivElement>();
  return (
    <main>
      <button ref={buttonRef}>Button</button>
      <a ref={anchorRef}>Anchor</a>
      <input ref={structuralRef} />
      <svg>
        <circle ref={circleRef} />
      </svg>
      <div ref={target} />
      <Portal target={target.current!}>
        Targeted {1} {null}
      </Portal>
      <GlobalPortal>Global {2}</GlobalPortal>
    </main>
  );
});
void Valid;

// @ts-expect-error Button refs must expose HTMLButtonElement.
const InvalidElementRef = <button ref={createRef<HTMLInputElement>()}>Wrong element</button>;
// @ts-expect-error Overlapping anchor tags use the HTML element ref type.
const InvalidAnchorRef = <a ref={createRef<SVGAElement>()}>Wrong anchor</a>;
// @ts-expect-error SVG-only tags retain their exact SVG element ref type.
const InvalidCircleRef = <circle ref={createRef<SVGRectElement>()} />;
// @ts-expect-error Portal requires a target.
const MissingTarget = <Portal />;
// @ts-expect-error Portal target must be an Element.
const InvalidTarget = <Portal target="body" />;
// @ts-expect-error GlobalPortal does not accept a target.
const InvalidGlobalTarget = <GlobalPortal target={document.body} />;

void InvalidElementRef;
void InvalidAnchorRef;
void InvalidCircleRef;
void MissingTarget;
void InvalidTarget;
void InvalidGlobalTarget;
