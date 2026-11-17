import type { JSX as PreactJSX } from "preact";

declare module "preact" {
  namespace JSX {
    interface IntrinsicElements {
      "harbor-qti-renderer-host": PreactJSX.HTMLAttributes<HTMLElement>;
    }
  }
}
